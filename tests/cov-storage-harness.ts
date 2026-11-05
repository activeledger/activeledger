import * as child from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * Shared helpers for the storage process tests: start packages/storage/lib/
 * selfhost.js as a real child process on a free port in a temp directory and
 * talk to it over HTTP. Not a test file itself (no .test suffix).
 */

export const SELFHOST = path.join(
  __dirname,
  "../packages/storage/lib/selfhost.js"
);

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

/** One request; the path is sent exactly as given (no normalisation). */
export const request = (
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
  headers: http.OutgoingHttpHeaders = {},
  host = "127.0.0.1"
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host,
        port,
        method,
        path: reqPath,
        headers: {
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode as number, headers: res.headers, text, json });
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${method} ${reqPath}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

export interface Storage {
  port: number;
  dir: string;
  proc: child.ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited: () => boolean;
  /** Everything the process has written to stdout and stderr so far. */
  output: () => string;
  req: (method: string, p: string, body?: unknown, headers?: http.OutgoingHttpHeaders) => Promise<Reply>;
  stop: () => Promise<void>;
  cleanup: () => void;
}

const live = new Set<child.ChildProcess>();

/**
 * Starts a storage process. `dirName` is the data directory argument (the
 * process prefixes "./"); the directory is created before the start. `extra`
 * are the arguments after the port: provider, host, cached database.
 */
export const startStorage = async (
  extra: string[] = ["level"],
  dirName = "data",
  seed?: (dataPath: string) => Promise<void>
): Promise<Storage> => {
  if (!fs.existsSync(SELFHOST)) {
    throw new Error(`${SELFHOST} missing - run npm run build in packages/storage`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-storage-"));
  fs.mkdirSync(path.join(dir, dirName), { recursive: true });
  if (seed) await seed(path.join(dir, dirName) + "/");
  const port = await freePort();
  const proc = child.spawn("node", [SELFHOST, dirName, `${port}`, ...extra], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.on("data", (d) => (out += d));
  proc.stderr?.on("data", (d) => (out += d));
  live.add(proc);
  let done = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) =>
      proc.on("exit", (code, signal) => {
        done = true;
        live.delete(proc);
        resolve({ code, signal });
      })
  );
  const s: Storage = {
    port,
    dir,
    proc,
    exit,
    exited: () => done,
    output: () => out,
    req: (m, p, b, h) => request(port, m, p, b, h),
    stop: async () => {
      if (!done) {
        proc.kill("SIGTERM");
        const timer = setTimeout(() => proc.kill("SIGKILL"), 8000);
        await exit;
        clearTimeout(timer);
      }
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await s.req("GET", "/")).status === 200) break;
    } catch {
      // not listening yet
    }
    if (done || Date.now() > deadline) {
      await s.stop();
      s.cleanup();
      throw new Error("storage process did not start");
    }
    await sleep(100);
  }
  return s;
};

/** Safety net: nothing the tests started may outlive the run. */
export const killAll = () => {
  for (const p of live) p.kill("SIGKILL");
  live.clear();
};

export interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: () => string;
  /** Resolves with the body once `pred` holds for it, or rejects after ms. */
  until: (pred: (body: string) => boolean, ms?: number) => Promise<string>;
  /** Resolves true when the server ends the response. */
  ended: () => boolean;
  close: () => void;
}

/** A streaming GET (SSE or longpoll): headers resolved, body accumulated. */
export const openStream = (
  port: number,
  reqPath: string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<Stream> =>
  new Promise((resolve, reject) => {
    let body = "";
    let ended = false;
    const waiters: Array<() => void> = [];
    const req = http.get(
      { host: "127.0.0.1", port, path: reqPath, headers, agent: false },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (d) => {
          body += d;
          waiters.slice().forEach((w) => w());
        });
        res.on("end", () => {
          ended = true;
          waiters.slice().forEach((w) => w());
        });
        res.on("error", () => {
          ended = true;
          waiters.slice().forEach((w) => w());
        });
        resolve({
          status: res.statusCode as number,
          headers: res.headers,
          body: () => body,
          ended: () => ended,
          close: () => req.destroy(),
          until: (pred, ms = 8000) =>
            new Promise((ok, no) => {
              const check = () => {
                if (pred(body)) {
                  cleanup();
                  ok(body);
                }
              };
              const timer = setTimeout(() => {
                cleanup();
                no(new Error(`stream condition not met; body so far: ${JSON.stringify(body)}`));
              }, ms);
              const cleanup = () => {
                clearTimeout(timer);
                const i = waiters.indexOf(check);
                if (i >= 0) waiters.splice(i, 1);
              };
              waiters.push(check);
              check();
            }),
        });
      }
    );
    req.on("error", (e) => {
      if (!ended) reject(e);
    });
  });
