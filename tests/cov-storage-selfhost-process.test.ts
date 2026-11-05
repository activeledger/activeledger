import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  Storage,
  killAll,
  openStream,
  request,
  sleep,
  startStorage,
} from "./cov-storage-harness";

const waitFor = async (
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms = 15000
) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const canConnect = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 1500 });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });

const externalIPv4 = (): string | undefined => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return undefined;
};

describe("Storage process lifecycle (selfhost)", function () {
  this.timeout(60000);
  after(() => killAll());

  describe("shutdown signals", () => {
    for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"] as const) {
      it(`exits cleanly with status 0 on ${signal} and stops listening`, async () => {
        const s = await startStorage(["level"]);
        try {
          await s.req("POST", "/activeledger", { _id: "persist", v: 1 });
          s.proc.kill(signal);
          const out = await Promise.race([
            s.exit,
            sleep(10000).then(() => "timeout" as const),
          ]);
          expect(out).to.not.equal("timeout");
          expect(out).to.deep.equal({ code: 0, signal: null });
          expect(await canConnect("127.0.0.1", s.port)).to.equal(false);
        } finally {
          await s.stop();
          s.cleanup();
        }
      });
    }

    it("a second signal during shutdown is harmless", async () => {
      const s = await startStorage(["level"]);
      try {
        await s.req("POST", "/activeledger", { _id: "x", v: 1 });
        s.proc.kill("SIGTERM");
        s.proc.kill("SIGINT");
        const out = await s.exit;
        expect(out).to.deep.equal({ code: 0, signal: null });
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("closes the open databases so a restart sees all written data", async () => {
      const s = await startStorage(["level"]);
      try {
        await s.req("POST", "/activeledger", { _id: "survivor", v: "kept" });
        await s.req("POST", "/activeledgerother", { _id: "survivor2", v: "kept2" });
        s.proc.kill("SIGTERM");
        await s.exit;
        // Same data directory, new process
        const { SELFHOST, freePort } = require("./cov-storage-harness");
        const port = await freePort();
        const proc = require("child_process").spawn(
          "node",
          [SELFHOST, "data", `${port}`, "level"],
          { cwd: s.dir, stdio: "ignore" }
        );
        try {
          await waitFor("restart", async () => {
            try {
              return (await request(port, "GET", "/")).status === 200;
            } catch {
              return false;
            }
          });
          const a = await request(port, "GET", "/activeledger/survivor");
          expect(a.json.v).to.equal("kept");
          const b = await request(port, "GET", "/activeledgerother/survivor2");
          expect(b.json.v).to.equal("kept2");
        } finally {
          proc.kill("SIGTERM");
          await new Promise((r) => proc.on("exit", r));
        }
      } finally {
        await s.stop();
        s.cleanup();
      }
    });
  });

  describe("shutdown logging", () => {
    it("closes every open database and says so", async () => {
      const s = await startStorage(["level"]);
      try {
        await s.req("POST", "/activeledger", { _id: "a", v: 1 });
        await s.req("POST", "/activeledgerother", { _id: "b", v: 1 });
        s.proc.kill("SIGTERM");
        expect(await s.exit).to.deep.equal({ code: 0, signal: null });
        expect(s.output()).to.contain("Closed database: activeledger");
        expect(s.output()).to.contain("Closed database: activeledgerother");
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("reports a database it cannot close and still exits cleanly", async () => {
      const s = await startStorage(["level"]);
      try {
        // _changes never opens the database, so closing it later fails
        const r = await s.req("GET", "/activeledgerunopened/_changes?since=now");
        expect(r.status).to.equal(200);
        await s.req("POST", "/activeledger", { _id: "a", v: 1 });
        s.proc.kill("SIGTERM");
        expect(await s.exit).to.deep.equal({ code: 0, signal: null });
        expect(s.output()).to.contain("Error closing database activeledgerunopened");
        expect(s.output()).to.contain("Closed database: activeledger");
      } finally {
        await s.stop();
        s.cleanup();
      }
    });
  });

  describe("a database another process holds", () => {
    let a: Storage;
    let b: Storage;
    before(async () => {
      a = await startStorage(["level"]);
      await a.req("POST", "/activeledger", { _id: "held", v: 1 });
      // A second storage process over the very same data directory: LevelDB
      // takes a lock per database, so it cannot open the one A has.
      const { SELFHOST, freePort } = require("./cov-storage-harness");
      const port = await freePort();
      const proc = require("child_process").spawn(
        "node",
        [SELFHOST, "data", `${port}`, "level"],
        { cwd: a.dir, stdio: ["ignore", "pipe", "pipe"] }
      );
      let out = "";
      proc.stdout.on("data", (d: Buffer) => (out += d));
      proc.stderr.on("data", (d: Buffer) => (out += d));
      const exit = new Promise<any>((resolve) =>
        proc.on("exit", (code: number | null, signal: string | null) => resolve({ code, signal }))
      );
      b = {
        port,
        dir: a.dir,
        proc,
        exit,
        exited: () => false,
        output: () => out,
        req: (m: string, p: string, body?: unknown, h?: any) => request(port, m, p, body, h),
        stop: async () => {
          proc.kill("SIGTERM");
          await exit;
        },
        cleanup: () => undefined,
      };
      await waitFor("second process", async () => {
        try {
          return (await b.req("GET", "/")).status === 200;
        } catch {
          return false;
        }
      });
    });
    after(async () => {
      await b?.stop();
      await a?.stop();
      a?.cleanup();
    });

    it("the holder serves it while the other cannot read it", async () => {
      expect((await a.req("GET", "/activeledger/held")).json.v).to.equal(1);
      const r = await b.req("GET", "/activeledger/held");
      expect(r.status).to.equal(500);
    });

    it("the other cannot write, delete or bulk write to it either", async () => {
      expect((await b.req("POST", "/activeledger", { _id: "x", v: 1 })).status).to.equal(500);
      expect((await b.req("DELETE", "/activeledger/held")).status).to.equal(500);
      expect(
        (await b.req("POST", "/activeledger/_bulk_docs", { docs: [{ _id: "y" }] })).status
      ).to.equal(500);
      // and nothing of that reached the holder's data
      expect((await a.req("GET", "/activeledger/held")).json.v).to.equal(1);
      expect((await a.req("GET", "/activeledger/x")).status).to.equal(500);
    });

    it("a failed sequence delete says so", async () => {
      const r = await b.req("DELETE", "/activeledger/_seq/0000000000000001");
      expect(r.status).to.equal(500);
    });

    it("the other process still shuts down cleanly", async () => {
      b.proc.kill("SIGTERM");
      expect(await b.exit).to.deep.equal({ code: 0, signal: null });
      expect(b.output()).to.contain("Error closing database activeledger");
    });
  });

  describe("start up arguments", () => {
    it("defaults the engine to level when no provider is given", async () => {
      const s = await startStorage([]);
      try {
        expect((await s.req("GET", "/")).json.engine).to.equal("level");
        const w = await s.req("POST", "/activeledger", { _id: "d", v: 1 });
        expect(w.status).to.equal(200);
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("a database folder that cannot be created is a 500, and recovers once it can", async () => {
      const s = await startStorage(["level"]);
      try {
        const blocker = path.join(s.dir, "data", "activeledgerblocked");
        fs.writeFileSync(blocker, "a file where the folder should go");
        expect((await s.req("GET", "/activeledgerblocked")).status).to.equal(500);
        fs.rmSync(blocker);
        expect((await s.req("GET", "/activeledgerblocked")).status).to.equal(200);
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("reports the engine it was told to use", async () => {
      const s = await startStorage(["rocksdb"]);
      try {
        expect((await s.req("GET", "/")).json.engine).to.equal("rocksdb");
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("listens on loopback only by default", async function () {
      const ext = externalIPv4();
      if (!ext) this.skip();
      const s = await startStorage(["level"]);
      try {
        expect(await canConnect("127.0.0.1", s.port)).to.equal(true);
        expect(await canConnect(ext as string, s.port)).to.equal(false);
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("listens on the interface given as the fourth argument", async function () {
      const ext = externalIPv4();
      if (!ext) this.skip();
      const s = await startStorage(["level", "0.0.0.0"]);
      try {
        expect(await canConnect(ext as string, s.port)).to.equal(true);
        const r = await request(s.port, "GET", "/", undefined, {}, ext);
        expect(r.status).to.equal(200);
      } finally {
        await s.stop();
        s.cleanup();
      }
    });

    it("serves reads of the named cached database consistently across updates", async () => {
      const s = await startStorage(["level", "127.0.0.1", "activeledger"]);
      try {
        const a = await s.req("POST", "/activeledger", { _id: "c1", v: 1 });
        expect((await s.req("GET", "/activeledger/c1")).json.v).to.equal(1);
        const b = await s.req("POST", "/activeledger", { _id: "c1", v: 2 });
        const got = await s.req("GET", "/activeledger/c1");
        expect(got.json.v).to.equal(2);
        expect(got.json._rev).to.equal(b.json.rev);
        expect(b.json.rev).to.not.equal(a.json.rev);
        await s.req("DELETE", "/activeledger/c1");
        expect((await s.req("GET", "/activeledger/c1")).status).to.equal(500);
        await s.req("POST", "/activeledger/_bulk_docs", { docs: [{ _id: "c1", v: 3 }] });
        expect((await s.req("GET", "/activeledger/c1")).json.v).to.equal(3);
        expect((await s.req("GET", "/activeledger/_raw/c1")).json.v).to.equal(3);
      } finally {
        await s.stop();
        s.cleanup();
      }
    });
  });

  describe("backup and restore", () => {
    let s: Storage;
    before(async () => {
      s = await startStorage(["level"]);
      await s.req("POST", "/activeledger", { _id: "bk1", v: "one" });
      await s.req("POST", "/activeledger", { _id: "bk2", v: "two" });
    });
    after(async () => {
      await s?.stop();
      s?.cleanup();
    });

    const exists = (f: string) => fs.existsSync(path.join(s.dir, f));

    it("writes the database to the named file in the working directory", async () => {
      const r = await s.req("POST", "/activeledger/_backup", { filename: "one.alb" });
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ status: "started" });
      await waitFor("backup", () => exists("one.alb") && !exists("one.alb.status"));
      const text = fs.readFileSync(path.join(s.dir, "one.alb"), "utf8");
      const docs = text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      expect(docs.map((d) => d._id).sort()).to.deep.equal(["bk1", "bk2"]);
      expect(docs.find((d) => d._id === "bk1").v).to.equal("one");
    });

    it("names the file by timestamp when none is given", async () => {
      const before = fs.readdirSync(s.dir).filter((f) => f.endsWith(".alb"));
      const r = await s.req("POST", "/activeledger/_backup", {});
      expect(r.json).to.deep.equal({ status: "started" });
      await waitFor("default backup", () => {
        const now = fs.readdirSync(s.dir);
        return (
          now.some((f) => /^\d+\.alb$/.test(f) && !before.includes(f)) &&
          !now.some((f) => f.endsWith(".status"))
        );
      });
    });

    it("restores a backup into a database", async () => {
      await s.req("POST", "/activeledger/_backup", { filename: "r.alb" });
      await waitFor("backup", () => exists("r.alb") && !exists("r.alb.status"));
      const r = await s.req("POST", "/activeledgerrestored/_restore", { filename: "r.alb" });
      expect(r.status).to.equal(200);
      expect(r.json).to.deep.equal({ status: "started" });
      await waitFor("restore", async () => {
        const g = await s.req("GET", "/activeledgerrestored/bk2");
        return g.status === 200 && !exists("r.alb.status");
      });
      expect((await s.req("GET", "/activeledgerrestored/bk1")).json.v).to.equal("one");
      expect((await s.req("GET", "/activeledgerrestored/bk2")).json.v).to.equal("two");
    });

    for (const [label, filename] of [
      ["a parent directory path", "../escape.alb"],
      ["an absolute path", "/tmp/escape.alb"],
      ["a subdirectory path", "sub/file.alb"],
      ["an empty name", ""],
      ["a number", 5],
      ["null", null],
      ["an object", { a: 1 }],
    ] as Array<[string, unknown]>) {
      it(`refuses to back up to ${label}`, async () => {
        const r = await s.req("POST", "/activeledger/_backup", { filename });
        expect(r.status).to.equal(500);
        expect(fs.existsSync(path.join(s.dir, "..", "escape.alb"))).to.equal(false);
        expect(exists("sub")).to.equal(false);
        expect(fs.existsSync("/tmp/escape.alb")).to.equal(false);
      });

      it(`refuses to restore from ${label}`, async () => {
        const r = await s.req("POST", "/activeledgerrefused/_restore", { filename });
        expect(r.status).to.equal(500);
      });
    }

    it("refuses to restore when no filename is given", async () => {
      const r = await s.req("POST", "/activeledgerrefused/_restore", {});
      expect(r.status).to.equal(500);
    });

    it("answers a missing restore file with a 404 JSON error and stays alive", async () => {
      const r = await s.req("POST", "/activeledgerrefused/_restore", { filename: "absent.alb" });
      expect(r.status).to.equal(404);
      expect(r.json).to.have.property("error");
      expect(s.exited()).to.equal(false);
      const h = await s.req("GET", "/activeledger/bk1");
      expect(h.status).to.equal(200);
    });

    it("answers a backup that cannot be written with a JSON error and stays alive", async () => {
      // A directory in the way of the file makes the write fail
      fs.mkdirSync(path.join(s.dir, "blocked.alb"));
      const r = await s.req("POST", "/activeledger/_backup", { filename: "blocked.alb" });
      expect(r.status).to.equal(500);
      expect(r.json).to.have.property("error");
      expect(s.exited()).to.equal(false);
      expect((await s.req("GET", "/activeledger/bk1")).status).to.equal(200);
    });

    it("a refused restore does not change the database", async () => {
      await s.req("POST", "/activeledgerrefused/_restore", { filename: "../x" });
      const all = await s.req("GET", "/activeledgerrefused/_all_docs");
      expect(all.json.total_rows).to.equal(0);
    });
  });

  describe("Fauxton assets", () => {
    let s: Storage;
    before(async () => {
      s = await startStorage(["level"]);
    });
    after(async () => {
      await s?.stop();
      s?.cleanup();
    });

    const indexHtml = fs.readFileSync(
      path.join(__dirname, "../packages/storage/lib/fauxton/index.html"),
      "utf8"
    );
    const assets = path.join(
      __dirname,
      "../packages/storage/lib/fauxton/dashboard.assets"
    );

    it("serves the app shell for /_utils and /_utils/", async () => {
      for (const p of ["/_utils", "/_utils/"]) {
        const r = await s.req("GET", p);
        expect(r.status, p).to.equal(200);
        expect(r.headers["content-type"], p).to.equal("text/html");
        expect(r.text, p).to.equal(indexHtml);
      }
    });

    it("serves an asset with the content type for its extension", async () => {
      const css = fs.readdirSync(path.join(assets, "css"))[0];
      const r = await s.req("GET", `/_utils/dashboard.assets/css/${css}`);
      expect(r.status).to.equal(200);
      expect(r.headers["content-type"]).to.equal("text/css");
      expect(r.text).to.equal(fs.readFileSync(path.join(assets, "css", css), "utf8"));
    });

    it("maps other extensions to their types and unknown ones to text/plain", async () => {
      const woff = await s.req("GET", "/_utils/dashboard.assets/fonts/fauxtonicon5.woff");
      expect(woff.headers["content-type"]).to.equal("font/woff");
      const ttf = await s.req("GET", "/_utils/dashboard.assets/fonts/fauxtonicon5.ttf");
      expect(ttf.headers["content-type"]).to.equal("aplication/font-sfnt");
      const png = await s.req("GET", "/_utils/dashboard.assets/img/activeledger.png");
      expect(png.headers["content-type"]).to.equal("image/png");
      const eot = await s.req("GET", "/_utils/dashboard.assets/fonts/fauxtonicon5.eot");
      expect(eot.headers["content-type"]).to.equal("text/plain");
    });

    it("serves the same asset again from its cache", async () => {
      const p = "/_utils/dashboard.assets/fonts/fauxtonicon5.woff";
      const a = await s.req("GET", p);
      const b = await s.req("GET", p);
      expect(b.status).to.equal(200);
      expect(b.text.length).to.equal(a.text.length);
      expect(b.text.length).to.be.greaterThan(0);
    });

    it("a missing asset gets no app shell and the server carries on", async () => {
      const http = require("http");
      const got = await new Promise<string>((resolve) => {
        const req = http.get(
          { host: "127.0.0.1", port: s.port, path: "/_utils/dashboard.assets/js/missing.js", agent: false },
          (res: any) => resolve(`response ${res.statusCode}`)
        );
        req.on("error", () => resolve("error"));
        setTimeout(() => {
          req.destroy();
          resolve("none");
        }, 600);
      });
      expect(got).to.not.equal("response 200");
      expect((await s.req("GET", "/_utils/")).text).to.equal(indexHtml);
    });

    for (const p of [
      "/_utils/../../../../../../../../etc/passwd",
      "/_utils/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
      "/_utils/../../package.json",
      "/_utils/../fauxton-sibling/x",
    ]) {
      it(`does not serve files outside the asset folder (${p})`, async () => {
        const r = await s.req("GET", p);
        expect(r.status).to.equal(200);
        expect(r.text).to.equal(indexHtml);
        expect(r.text).to.not.contain("root:");
      });
    }
  });
});

describe("Storage process /events and longpoll feeds (selfhost)", function () {
  this.timeout(60000);
  let s: Storage;

  before(async () => {
    s = await startStorage(["level"]);
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
    killAll();
  });

  const sseIds = (body: string) => [...body.matchAll(/^id:(.*)$/gm)].map((m) => m[1]);

  describe("/events server sent events", () => {
    const db = "activeledgerevents";

    it("opens an event stream", async () => {
      const st = await openStream(s.port, `/${db}/events`);
      try {
        expect(st.status).to.equal(200);
        expect(st.headers["content-type"]).to.equal("text/event-stream");
        expect(st.headers["cache-control"]).to.equal("no-cache");
        await st.until((b) => b.startsWith(":\n\n"));
      } finally {
        st.close();
      }
    });

    it("sends new events live, without _id and _rev, and only event documents", async () => {
      const st = await openStream(s.port, `/${db}/events`);
      try {
        await st.until((b) => b.length > 0);
        await s.req("POST", `/${db}`, { _id: "other:1", not: "an event" });
        await s.req("POST", `/${db}`, { _id: "event:live1", name: "first", n: 1 });
        const body = await st.until((b) => b.includes("id:live1"));
        expect(sseIds(body)).to.deep.equal(["live1"]);
        const m = body.match(/id:live1\nevent: message\ndata:(.*)\n\n/);
        expect(m).to.not.equal(null);
        expect(JSON.parse((m as RegExpMatchArray)[1])).to.deep.equal({ name: "first", n: 1 });
        expect(body).to.not.contain("an event");
      } finally {
        st.close();
      }
    });

    it("sends the events of a bulk write", async () => {
      const st = await openStream(s.port, `/${db}/events`);
      try {
        await st.until((b) => b.length > 0);
        await s.req("POST", `/${db}/_bulk_docs`, {
          docs: [
            { _id: "event:bulkA", v: 1 },
            { _id: "event:bulkB", v: 2 },
          ],
        });
        const body = await st.until((b) => sseIds(b).length >= 2);
        expect(sseIds(body).sort()).to.deep.equal(["bulkA", "bulkB"]);
      } finally {
        st.close();
      }
    });

    it("stops listening when the client disconnects and keeps serving", async () => {
      const st = await openStream(s.port, `/${db}/events`);
      await st.until((b) => b.length > 0);
      st.close();
      await sleep(200);
      const w = await s.req("POST", `/${db}`, { _id: "event:after-close", v: 1 });
      expect(w.status).to.equal(200);
      expect((await s.req("GET", "/")).status).to.equal(200);
    });

    it("resumes after Last-Event-ID, then carries on live", async () => {
      for (const n of ["r1", "r2", "r3"]) {
        await s.req("POST", `/${db}`, { _id: `event:${n}`, name: n });
      }
      const st = await openStream(s.port, `/${db}/events`, { "Last-Event-ID": "r1" });
      try {
        await st.until((b) => sseIds(b).includes("r3"));
        expect(sseIds(st.body())).to.deep.equal(["r2", "r3"]);
        await s.req("POST", `/${db}`, { _id: "event:r4", name: "r4" });
        await st.until((b) => sseIds(b).includes("r4"));
        expect(sseIds(st.body())).to.deep.equal(["r2", "r3", "r4"]);
      } finally {
        st.close();
      }
    });

    it("sends every event exactly once, in order, when one lands during a long replay", async () => {
      const ids: string[] = [];
      const docs: unknown[] = [];
      for (let i = 1; i <= 1200; i++) {
        const id = `big${String(i).padStart(5, "0")}`;
        ids.push(id);
        docs.push({ _id: `event:${id}`, n: i });
      }
      const w = await s.req("POST", `/${db}/_bulk_docs`, { docs });
      expect(w.json).to.deep.equal({ ok: true });
      const st = await openStream(s.port, `/${db}/events`, { "Last-Event-ID": "big00000" });
      try {
        // while the replay is being read and sent
        await s.req("POST", `/${db}`, { _id: "event:big99999", n: -1 });
        await st.until((b) => sseIds(b).includes("big99999"), 20000);
        await sleep(300);
        const got = sseIds(st.body()).filter((i) => i.startsWith("big"));
        expect(got).to.deep.equal([...ids, "big99999"]);
      } finally {
        st.close();
      }
    });

    it("never sends an event twice when events land while a resume is starting", async () => {
      for (let i = 0; i < 12; i++) {
        const tag = `race${String(i).padStart(2, "0")}`;
        const live = `event:${tag}-live`;
        const [st] = await Promise.all([
          openStream(s.port, `/${db}/events`, { "Last-Event-ID": `${tag}-` }),
          s.req("POST", `/${db}`, { _id: live, i }),
          s.req("POST", `/${db}`, { _id: `${live}2`, i }),
        ]);
        try {
          await st.until((b) => sseIds(b).includes(`${tag}-live2`));
          await sleep(60);
          const got = sseIds(st.body()).filter((x) => x.startsWith(tag));
          expect(got.sort()).to.deep.equal([`${tag}-live`, `${tag}-live2`]);
        } finally {
          st.close();
        }
      }
    });

    it("an unknown database name has no event stream", async () => {
      const r = await s.req("GET", "/notadb/events");
      expect(r.status).to.equal(500);
    });
  });

  describe("_changes longpoll", () => {
    const db = "activeledgerlongpoll";
    const parse = (body: string) => JSON.parse(body);

    it("holds open, streaming the start of the body, then returns the change", async () => {
      const st = await openStream(s.port, `/${db}/_changes?feed=longpoll&since=now&heartbeat=60000`);
      try {
        expect(st.status).to.equal(200);
        expect(st.headers["content-type"]).to.equal("application/json");
        await st.until((b) => b.startsWith('{"results":[\n'));
        expect(st.ended()).to.equal(false);
        await s.req("POST", `/${db}`, { _id: "lp1", v: 1 });
        await st.until(() => st.ended());
        const parsed = parse(st.body());
        expect(parsed.results).to.have.length(1);
        expect(parsed.results[0].id).to.equal("lp1");
        expect(parsed.results[0].doc).to.deep.include({ _id: "lp1", v: 1 });
        expect(parsed.last_seq).to.equal(Number(parsed.results[0].seq));
      } finally {
        st.close();
      }
    });

    it("returns every change of one multi document commit in a single round", async () => {
      const st = await openStream(s.port, `/${db}/_changes?feed=longpoll&since=now&heartbeat=60000`);
      try {
        await st.until((b) => b.startsWith('{"results":[\n'));
        await s.req("POST", `/${db}/_bulk_docs`, {
          docs: [
            { _id: "lpb1", v: 1 },
            { _id: "lpb2", v: 2 },
            { _id: "lpb3", v: 3 },
          ],
        });
        await st.until(() => st.ended());
        const parsed = parse(st.body());
        expect(parsed.results.map((r: any) => r.id).sort()).to.deep.equal(["lpb1", "lpb2", "lpb3"]);
        const maxSeq = Math.max(...parsed.results.map((r: any) => Number(r.seq)));
        expect(parsed.last_seq).to.equal(maxSeq);
      } finally {
        st.close();
      }
    });

    it("keeps bytes flowing with a heartbeat while nothing changes", async () => {
      const st = await openStream(s.port, `/${db}/_changes?feed=longpoll&since=now&heartbeat=100`);
      try {
        await st.until((b) => b.startsWith('{"results":[\n'));
        // opening line is "...[\n"; each heartbeat adds one more newline
        const body = await st.until((b) => b.length >= '{"results":[\n'.length + 3, 5000);
        expect(body).to.match(/^\{"results":\[\n\n+$/);
        expect(st.ended()).to.equal(false);
        // and the feed still completes with the change afterwards
        await s.req("POST", `/${db}`, { _id: "lphb", v: 1 });
        await st.until(() => st.ended());
        expect(parse(st.body()).results[0].id).to.equal("lphb");
      } finally {
        st.close();
      }
    });

    it("a continuous feed is not served but does not disturb the server", async () => {
      const http = require("http");
      const got = await new Promise<string>((resolve) => {
        const req = http.get(
          { host: "127.0.0.1", port: s.port, path: `/${db}/_changes?feed=continuous&since=now`, agent: false },
          (res: any) => resolve(`response ${res.statusCode}`)
        );
        req.on("error", () => resolve("error"));
        setTimeout(() => {
          req.destroy();
          resolve("none");
        }, 400);
      });
      expect(got).to.not.equal("response 500");
      expect((await s.req("GET", "/")).status).to.equal(200);
    });

    it("a client that goes away is cleaned up and the server keeps serving", async () => {
      const st = await openStream(s.port, `/${db}/_changes?feed=longpoll&since=now&heartbeat=50`);
      await st.until((b) => b.startsWith('{"results":[\n'));
      st.close();
      await sleep(300);
      const w = await s.req("POST", `/${db}`, { _id: "after-abandon", v: 1 });
      expect(w.status).to.equal(200);
      expect((await s.req("GET", "/")).status).to.equal(200);
    });

    it("changes made before the poll started are not returned by it", async () => {
      await s.req("POST", `/${db}`, { _id: "early", v: 1 });
      const st = await openStream(s.port, `/${db}/_changes?feed=longpoll&since=now&heartbeat=60000`);
      try {
        await st.until((b) => b.startsWith('{"results":[\n'));
        await s.req("POST", `/${db}`, { _id: "late", v: 1 });
        await st.until(() => st.ended());
        expect(parse(st.body()).results.map((r: any) => r.id)).to.deep.equal(["late"]);
      } finally {
        st.close();
      }
    });
  });

  describe("_changes longpoll with a damaged sequence entry", () => {
    let bad: Storage;
    before(async () => {
      bad = await startStorage(["level"], "bdata", async (prefix) => {
        const { LevelDBDriver } = require("../packages/storage/src/drivers/leveldb");
        const d = new LevelDBDriver(prefix + "activeledger", "level");
        await d.open();
        await d.put("ÿby-sequenceÿ0000000000000005", Buffer.from("not a serialised document"));
        await d.close();
      });
    });
    after(async () => {
      await bad?.stop();
      bad?.cleanup();
    });

    // _changes reads the sequence entries without opening the database
    // itself, so another request has to have opened it first
    beforeEach(async () => {
      expect((await bad.req("GET", "/activeledger")).status).to.equal(200);
    });

    it("answers a longpoll with a 500 carrying the error", async () => {
      const st = await openStream(bad.port, "/activeledger/_changes?feed=longpoll&since=1");
      try {
        await st.until(() => st.ended());
        // (the status line is already sent as 200 by then, so only the body
        // is a reliable signal of the failure)
        const body = JSON.parse(st.body());
        expect(body).to.have.property("error").that.is.a("string");
        expect(body.results).to.equal(undefined);
      } finally {
        st.close();
      }
    });

    it("answers a plain _changes with a 500", async () => {
      const r = await bad.req("GET", "/activeledger/_changes?since=1");
      expect(r.status).to.equal(500);
    });
  });
});
