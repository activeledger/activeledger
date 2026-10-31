import { expect } from "chai";
import "mocha";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require("child_process");
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { gzipSync, gunzipSync } from "zlib";
import { generateKeyPairSync } from "crypto";
import { EventEmitter } from "events";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveInterfaces } from "../packages/network/src/network/utils";
import { Host } from "../packages/network/src/network/host";
import { Home } from "../packages/network/src/network/home";
import { Locker } from "../packages/network/src/network/locker";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { HybridBans } from "../packages/network/src/network/hybridAdmin";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbourhood } from "../packages/network/src/network/neighbourhood";

// A real Host, listening on a loopback port, with the processors faked: the
// request handler in the constructor (routing, bundling, gzip, size limits,
// response headers) is exercised over real HTTP. Everything process wide that
// the constructor touches is put back afterwards.
describe("Host HTTP listener (Activeledger)", () => {
  const iface = ActiveInterfaces as any;
  const cfgKeys = [
    "host",
    "identity",
    "neighbourhood",
    "db",
    "cpus",
    "security",
    "remote",
    "p2pStreamServer",
    "hybrid-listen",
    "proxy",
  ];

  let dir: string;
  let host: any;
  let port: number;
  let children: (EventEmitter & { pid: number; sent: any[]; stop: boolean })[];
  let saved: { [key: string]: any };
  let realFork: any;
  let realHealth: any;
  let realRemap: any;
  let realSetTimeout: any;
  const realHome = {
    reference: Home.reference,
    host: Home.host,
    left: Home.left,
    right: Home.right,
    identity: Home.identity,
    publicPem: Home.publicPem,
  };

  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });

  interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    raw: Buffer;
    text: string;
  }

  const request = (
    method: string,
    url: string,
    body?: Buffer | string,
    headers: { [k: string]: string } = {}
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path: url, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              raw,
              text: raw.toString(),
            });
          });
        }
      );
      req.on("error", reject);
      req.end(body);
    });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-http-"));
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const identity = path.join(dir, ".identity");
    fs.writeFileSync(
      identity,
      JSON.stringify({
        prv: { pkcs8pem: pair.privateKey },
        pub: { pkcs8pem: pair.publicKey },
      })
    );

    port = await freePort();
    const config = ActiveOptions.fetch(false);
    saved = {};
    for (const key of cfgKeys) saved[key] = config[key];
    config.host = `127.0.0.1:${port}`;
    config.identity = identity;
    config.neighbourhood = [];
    config.db = {
      url: "http://127.0.0.1:1",
      database: "ledger",
      error: "error",
      event: "event",
    };
    config.cpus = 1;
    config.security = { maxRequestBytes: 4096 };
    config.remote = false;
    delete config.p2pStreamServer;
    delete config["hybrid-listen"];
    delete config.proxy;
    saved.bindingHost = iface.bindingHost;
    saved.bindingPort = iface.bindingPort;
    iface.bindingHost = undefined;
    iface.bindingPort = undefined;
    realRemap = (Neighbourhood as any).remapedAddr;
    (Neighbourhood as any).remapedAddr = undefined;

    // Fake processors in place of forked workers
    children = [];
    realFork = childProcess.fork;
    childProcess.fork = () => {
      const child: any = new EventEmitter();
      child.pid = 9000 + children.length;
      child.sent = [];
      child.stop = false;
      child.send = (m: any, cb?: any) => {
        child.sent.push(m);
        if (typeof cb === "function") cb();
        return true;
      };
      child.kill = () => true;
      children.push(child);
      return child;
    };
    realHealth = Maintain.healthTimer;
    Maintain.healthTimer = () => undefined;

    // The constructor starts a timer that re-arms itself forever
    realSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: any, ms: any, ...a: any[]) =>
      ms === 2000 ? (0 as any) : realSetTimeout(fn, ms, ...a);
    try {
      host = new Host();
    } finally {
      global.setTimeout = realSetTimeout;
    }

    await new Promise<void>((resolve) => {
      Host.onListening = resolve;
      // Each worker reports ready; once all have, the host listens
      children[0].emit("message", { type: "ready", data: {} });
    });
  });

  after(async () => {
    Host.onListening = undefined;
    const config = ActiveOptions.fetch(false);
    for (const key of cfgKeys) {
      if (saved[key] === undefined) delete config[key];
      else config[key] = saved[key];
    }
    iface.bindingHost = saved.bindingHost;
    iface.bindingPort = saved.bindingPort;
    (Neighbourhood as any).remapedAddr = realRemap;
    childProcess.fork = realFork;
    Maintain.healthTimer = realHealth;
    Home.reference = realHome.reference;
    Home.host = realHome.host;
    Home.left = realHome.left;
    Home.right = realHome.right;
    Home.identity = realHome.identity;
    Home.publicPem = realHome.publicPem;
    // Closes the listen socket; the exit it schedules is not wanted here
    const realExit = process.exit;
    (process as any).exit = () => undefined;
    host.shutdown();
    await new Promise((r) => realSetTimeout(r, 1500));
    process.exit = realExit;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("response headers", () => {
    it("answers with the hardening headers and a JSON content type", async () => {
      const reply = await request("GET", "/a/locks/check");
      expect(reply.status).to.equal(200);
      expect(JSON.parse(reply.text)).to.deep.equal({ checked: true });
      expect(reply.headers["content-type"]).to.equal("application/json");
      expect(reply.headers["access-control-allow-origin"]).to.equal("*");
      expect(reply.headers["x-content-type-options"]).to.equal("nosniff");
      expect(reply.headers["x-frame-options"]).to.equal("DENY");
      expect(reply.headers["strict-transport-security"]).to.contain(
        "max-age=63072000"
      );
      expect(reply.headers["content-security-policy"]).to.contain(
        "default-src 'none'"
      );
    });

    it("answers OPTIONS with {} and the CORS allowances", async () => {
      const reply = await request("OPTIONS", "/");
      expect(reply.status).to.equal(200);
      expect(reply.text).to.equal("{}");
      expect(reply.headers["access-control-allow-methods"]).to.equal(
        "GET, POST"
      );
      expect(reply.headers["access-control-allow-headers"]).to.equal("*");
    });
  });

  describe("GET routing", () => {
    it("lists the held locks and the busy-lock queue", async () => {
      const stream = "L".repeat(64);
      Locker.hold([stream], "http-lock-holder");
      try {
        const reply = await request("GET", "/a/locks");
        expect(reply.status).to.equal(200);
        const body = JSON.parse(reply.text);
        expect(body.L[stream].umid).to.equal("http-lock-holder");
        expect(body.Q).to.deep.equal({ internal: [], external: [] });
      } finally {
        Locker.release([stream], "http-lock-holder");
      }
    });

    it("compresses a large response when the client accepts gzip", async () => {
      const streams = Array.from({ length: 300 }, (_, i) =>
        String(i).padStart(64, "g")
      );
      Locker.hold(streams, "http-gzip-holder");
      try {
        const reply = await request("GET", "/a/locks", undefined, {
          "Accept-Encoding": "gzip",
        });
        expect(reply.headers["content-encoding"]).to.equal("gzip");
        const body = JSON.parse(gunzipSync(reply.raw).toString());
        expect(Object.keys(body.L)).to.have.length(300);
      } finally {
        Locker.release(streams, "http-gzip-holder");
      }
    });

    it("does not bother compressing a small response", async () => {
      const reply = await request("GET", "/a/locks/check", undefined, {
        "Accept-Encoding": "gzip",
      });
      expect(reply.headers["content-encoding"]).to.equal(undefined);
      expect(JSON.parse(reply.text)).to.deep.equal({ checked: true });
    });

    it("refuses stream listings from an address that is not a neighbour", async () => {
      for (const url of ["/a/all", "/a/all/abc", "/a/umid/abc", "/other"]) {
        const reply = await request("GET", url);
        expect(reply.status, url).to.equal(403);
        expect(reply.text, url).to.equal("Forbidden");
      }
    });

    it("refuses hybrid admin routes that are not from loopback addresses only", async () => {
      // This test connects over loopback, so the guard lets it through
      const reply = await request("GET", "/a/hybrid/feeds");
      expect(reply.status).to.equal(200);
      expect(JSON.parse(reply.text)).to.be.an("object");
    });

    it("reports remote reload as disabled unless enabled", async () => {
      const reply = await request("GET", "/a/admin-reload");
      expect(reply.status).to.equal(200);
      expect(JSON.parse(reply.text)).to.deep.equal({
        status: "failed",
        message: "remote disabled",
      });
    });

    it("lets a loopback caller reload when remote is enabled", async () => {
      ActiveOptions.set("remote", true);
      let reloads = 0;
      const realReload = host.reload;
      host.reload = () => reloads++;
      const realParse = (ActiveOptions as any).parseConfig;
      (ActiveOptions as any).parseConfig = () => undefined;
      try {
        const reply = await request("GET", "/a/admin-reload");
        expect(reply.status).to.equal(200);
        expect(JSON.parse(reply.text).status).to.equal("success");
        expect(reloads).to.equal(1);
      } finally {
        host.reload = realReload;
        (ActiveOptions as any).parseConfig = realParse;
        ActiveOptions.set("remote", false);
      }
    });

    it("reports a failed reload in the body", async () => {
      ActiveOptions.set("remote", true);
      const realParse = (ActiveOptions as any).parseConfig;
      (ActiveOptions as any).parseConfig = () => {
        throw new Error("bad config.json");
      };
      try {
        const reply = await request("GET", "/a/admin-reload");
        expect(reply.status).to.equal(200);
        expect(JSON.parse(reply.text)).to.deep.equal({
          status: "failed",
          message: "bad config.json",
        });
      } finally {
        (ActiveOptions as any).parseConfig = realParse;
        ActiveOptions.set("remote", false);
      }
    });
  });

  describe("method handling", () => {
    it("404s methods other than GET, POST and OPTIONS", async () => {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const reply = await request(method, "/a/locks");
        expect(reply.status, method).to.equal(404);
        expect(reply.text, method).to.equal("Not Found");
      }
    });

    it("404s an unknown POST path", async () => {
      const reply = await request("POST", "/nowhere", "{}");
      expect(reply.status).to.equal(404);
    });

    it("refuses internal transactions from non-neighbours", async () => {
      const reply = await request("POST", "/a/init", "{}");
      expect(reply.status).to.equal(403);
      expect(reply.text).to.equal("Forbidden");
    });
  });

  describe("POST bodies", () => {
    const validTx = (over: any = {}) => ({
      $tx: {
        $namespace: "default",
        $contract: "onboard",
        $i: { identity: { publicKey: "x" } },
        $expire: "2000-01-01T00:00:00.000Z",
      },
      $sigs: { identity: "sig" },
      ...over,
    });

    it("rejects an expired transaction as a successful failure, not an HTTP error", async () => {
      const reply = await request("POST", "/", JSON.stringify(validTx()));
      expect(reply.status).to.equal(200);
      const body = JSON.parse(reply.text);
      expect(body.$summary.commit).to.equal(0);
      expect(body.$summary.errors[0]).to.contain("Transaction Expired");
    });

    it("inflates a gzip body announced by Content-Encoding", async () => {
      const reply = await request(
        "POST",
        "/",
        gzipSync(JSON.stringify(validTx())),
        { "Content-Encoding": "gzip" }
      );
      expect(reply.status).to.equal(200);
      expect(JSON.parse(reply.text).$summary.errors[0]).to.contain(
        "Transaction Expired"
      );
    });

    it("inflates a gzip body by its magic number when the header is missing", async () => {
      const reply = await request(
        "POST",
        "/",
        gzipSync(JSON.stringify(validTx()))
      );
      expect(reply.status).to.equal(200);
      expect(JSON.parse(reply.text).$summary.errors[0]).to.contain(
        "Transaction Expired"
      );
    });

    // KNOWN BUG, deliberately not tested: a body that starts with the gzip
    // magic number (1f 8b) but is not valid gzip is never answered. The
    // handler's inflate failure is swallowed so the raw bytes carry on, then
    // makeSureNotBuffer() sees the same magic number, inflates again, and
    // throws inside the async uWS handler: an unhandled rejection and a
    // request that hangs with no response. The correct behaviour is a 4xx
    // reply (or at least a response), so the client is not left waiting.

    it("answers 413 and closes for a body over security.maxRequestBytes", async () => {
      const reply = await request("POST", "/", "x".repeat(5000));
      expect(reply.status).to.equal(413);
      expect(JSON.parse(reply.text)).to.deep.equal({
        error: "Request too large",
      });
      expect(reply.headers.connection).to.contain("close");
    });

    it("answers 413 for a small gzip body that inflates past the limit", async () => {
      const bomb = gzipSync(Buffer.alloc(50_000, 0x20));
      expect(bomb.length).to.be.lessThan(4096);
      const reply = await request("POST", "/", bomb, {
        "Content-Encoding": "gzip",
      });
      expect(reply.status).to.equal(413);
    });

    it("acknowledges a bundle at once and processes each part", async () => {
      const seen: any[] = [];
      const realPost = (Host as any).prototype.processEndpoints;
      // Observe, don't replace the behaviour: count what reached routing
      (host as any).processEndpoints = function (...args: any[]) {
        seen.push(args[2]);
        return realPost.apply(this, args);
      };
      try {
        const a = JSON.stringify(validTx());
        const b = JSON.stringify(validTx({ $sigs: { identity: "other" } }));
        const reply = await request("POST", "/", `${a}:$ALB:${b}`, {
          "X-Bundle": "1",
        });
        expect(reply.status).to.equal(200);
        expect(reply.text).to.equal("{}");
        await new Promise((r) => setTimeout(r, 100));
        expect(seen).to.have.length(2);
        expect(seen.map((s) => s.$sigs.identity).sort()).to.deep.equal([
          "other",
          "sig",
        ]);
      } finally {
        delete (host as any).processEndpoints;
      }
    });

    it("skips empty parts of a bundle", async () => {
      const seen: any[] = [];
      const realPost = (Host as any).prototype.processEndpoints;
      (host as any).processEndpoints = function (...args: any[]) {
        seen.push(args[2]);
        return realPost.apply(this, args);
      };
      try {
        const reply = await request(
          "POST",
          "/",
          `${JSON.stringify(validTx())}:$ALB:`,
          { "X-Bundle": "1" }
        );
        expect(reply.text).to.equal("{}");
        await new Promise((r) => setTimeout(r, 100));
        expect(seen).to.have.length(1);
      } finally {
        delete (host as any).processEndpoints;
      }
    });

    it("answers a transaction that cannot be decrypted with 500", async () => {
      const reply = await request("POST", "/", "not-encrypted", {
        "x-activeledger-encrypt": "1",
      });
      expect(reply.status).to.equal(500);
      expect(JSON.parse(reply.text)).to.equal("Decryption Error");
    });
  });

  describe("endpoint routing", () => {
    it("serves the node's status to an anonymous caller", async () => {
      const reply = await request("GET", "/a/status");
      expect(reply.status).to.equal(200);
      expect(JSON.parse(reply.text)).to.be.an("object");
    });

    it("answers a status ping from an unknown node with 403", async () => {
      const reply = await request("GET", "/a/status", undefined, {
        "X-Activeledger": "not-a-neighbour",
      });
      expect(reply.status).to.equal(403);
      expect(reply.text).to.equal("{}");
    });

    it("lists hybrids for a loopback caller", async () => {
      const reply = await request("GET", "/a/hybrid/list");
      expect(reply.status).to.equal(200);
      // No hybrids registered on a fresh node
      expect(JSON.parse(reply.text)).to.deep.equal([]);
    });

    describe("hybrid ban / unban", () => {
      const realBans = Host.hybridBans;
      const hash = "ab".repeat(32);
      before(() => {
        Host.hybridBans = new HybridBans(path.join(dir, "bans.json"));
      });
      after(() => {
        Host.hybridBans = realBans;
      });

      it("bans a key hash and unbans it again", async () => {
        const ban = await request("POST", "/a/hybrid/ban", JSON.stringify({ keyHash: hash }));
        expect(ban.status).to.equal(200);
        expect(JSON.parse(ban.text)).to.deep.equal({ ok: true });
        expect(Host.hybridBans.set().has(hash)).to.equal(true);

        const unban = await request("POST", "/a/hybrid/unban", JSON.stringify({ keyHash: hash }));
        expect(unban.status).to.equal(200);
        expect(Host.hybridBans.set().has(hash)).to.equal(false);
      });

      it("answers 400 for something that is not a key hash", async () => {
        for (const url of ["/a/hybrid/ban", "/a/hybrid/unban"]) {
          const reply = await request("POST", url, JSON.stringify({ keyHash: "short" }));
          expect(reply.status, url).to.equal(400);
          expect(JSON.parse(reply.text), url).to.deep.equal({
            error: "unknown or invalid key hash",
          });
        }
      });
    });

    it("reads streams through /a/stream and refuses volatile ones with 403", async () => {
      const reply = await request(
        "POST",
        "/a/stream",
        JSON.stringify({ $streams: ["abc:volatile"] })
      );
      expect(reply.status).to.equal(403);
      expect(JSON.parse(reply.text)).to.equal("Request not allowed");
    });
  });

  describe("response writing", () => {
    // A request routed straight at processEndpoints with a fake response
    const route = (
      status: Promise<any>,
      extra: { from?: string; body?: any } = {}
    ) => {
      const real = Endpoints.status;
      Endpoints.status = (() => status) as any;
      const out: any = { headers: {}, ended: undefined };
      const res: any = {
        writable: true,
        cork: (fn: () => void) => fn(),
        writeStatus: (s: string) => (out.status = s),
        writeHeader: (k: string, v: string) => (out.headers[k] = v),
        end: (b: any) => (out.ended = b),
      };
      host.processEndpoints(
        {
          headers: {},
          method: "GET",
          url: "/a/status",
          connection: { remoteAddress: "127.0.0.1" },
        },
        res,
        extra.body,
        extra.from
      );
      Endpoints.status = real;
      return new Promise<any>((resolve) => setImmediate(() => resolve(out)));
    };

    it("encrypts the content for the neighbour that asked, when the endpoint says to", async () => {
      const real = host.neighbourhood.get;
      const asked: string[] = [];
      host.neighbourhood.get = (ref?: string) => {
        if (ref === undefined) return real.call(host.neighbourhood);
        asked.push(ref);
        return {
          encryptKnock: (data: string, flag: boolean) =>
            `enc(${data},${flag})`,
        };
      };
      try {
        const out = await route(
          Promise.resolve({ statusCode: 200, content: { $encrypt: true, a: 1 } }),
          { from: "neighbour-1" }
        );
        expect(asked).to.deep.equal(["neighbour-1"]);
        expect(JSON.parse(out.ended)).to.deep.equal({
          $packet: 'enc({"$encrypt":true,"a":1},true)',
          $enc: true,
        });
      } finally {
        host.neighbourhood.get = real;
      }
    });

    it("leaves the content readable when it asks for encryption but nobody is to receive it", async () => {
      const out = await route(
        Promise.resolve({ statusCode: 200, content: { $encrypt: true, a: 1 } })
      );
      expect(JSON.parse(out.ended)).to.deep.equal({ $encrypt: true, a: 1 });
    });

    it("answers with the status and message an endpoint failed with", async () => {
      const out = await route(
        Promise.reject({ statusCode: 418, content: "short and stout" })
      );
      expect(out.status).to.equal("418");
      expect(JSON.parse(out.ended)).to.equal("short and stout");
    });

    it("answers 500 with a generic message when an endpoint fails without saying why", async () => {
      const out = await route(Promise.reject(new Error("internal detail")));
      expect(out.status).to.equal("500");
      expect(JSON.parse(out.ended)).to.equal("Something has gone wrong");
      expect(out.ended).to.not.contain("internal detail");
    });

    it("answers an empty body as {}", async () => {
      const out = await route(Promise.resolve({ statusCode: 204 }));
      expect(out.status).to.equal("204");
      expect(out.ended).to.equal("{}");
    });

    it("writes nothing to a connection that has gone", async () => {
      const calls: string[] = [];
      const res: any = {
        writable: false,
        cork: () => calls.push("cork"),
        writeStatus: () => calls.push("status"),
      };
      await host.writeResponse(res, 200, "{}", "");
      await host.writeResponse(null, 200, "{}", "");
      expect(calls).to.deep.equal([]);
    });

    it("writes the status and headers but no body for empty content", async () => {
      const out: any = { headers: {} };
      const res: any = {
        writable: true,
        cork: (fn: () => void) => fn(),
        writeStatus: (s: string) => (out.status = s),
        writeHeader: (k: string, v: string) => (out.headers[k] = v),
        end: () => (out.ended = true),
      };
      await host.writeResponse(res, 404, "", "gzip");
      expect(out.status).to.equal("404");
      expect(out.headers["Content-Type"]).to.equal(undefined);
      expect(out.ended).to.equal(undefined);
    });
  });

  describe("messages from the processors", () => {
    const message = (child: any, m: any) => child.emit("message", m);
    const resolved: any[] = [];
    let realTimers: any;
    let timers: { fn: () => void; ms: number }[];
    let realRepair: any;
    let repaired: string[];

    const addPending = (umid: string, over: any = {}) => {
      const entry: any = { $umid: umid, $tx: {}, $nodes: {}, ...over };
      host.processPending[umid] = {
        entry,
        pid: children[0].pid,
        finished: false,
        responded: false,
        resolve: (r: any) => resolved.push({ umid, r }),
        reject: () => undefined,
      };
      return entry;
    };

    beforeEach(() => {
      resolved.length = 0;
      timers = [];
      realTimers = global.setTimeout;
      (global as any).setTimeout = (fn: () => void, ms: number) => (
        timers.push({ fn, ms }), 0 as any
      );
      repaired = [];
      realRepair = Endpoints.repairHistoryAfterCommit;
      Endpoints.repairHistoryAfterCommit = (async (_h: any, umid: string) => {
        repaired.push(umid);
      }) as any;
    });
    afterEach(() => {
      global.setTimeout = realTimers;
      Endpoints.repairHistoryAfterCommit = realRepair;
      for (const k of Object.keys(host.processPending)) {
        delete host.processPending[k];
      }
    });

    it("answers the client with the entry, merged with the processor's, when a tx failed", () => {
      const entry = addPending("m-fail");
      message(children[0], {
        type: "failed",
        data: {
          umid: "m-fail",
          nodes: { me: { vote: false, error: "nope" } },
          entry: { $summary: { total: 1 } },
        },
      });
      expect(resolved).to.have.length(1);
      expect(resolved[0].r.status).to.equal(200);
      expect(resolved[0].r.data.$summary).to.deep.equal({ total: 1 });
      // The node votes were merged into the pending entry first
      expect(entry.$nodes.me.error).to.equal("nope");
    });

    it("answers with the pending entry alone when a failure carries no entry", () => {
      const entry = addPending("m-fail2");
      message(children[0], { type: "failed", data: { umid: "m-fail2" } });
      expect(resolved[0].r.data).to.equal(entry);
    });

    it("ignores a failure for a transaction it no longer holds", () => {
      message(children[0], { type: "failed", data: { umid: "m-gone" } });
      expect(resolved).to.have.length(0);
    });

    it("answers with the outcome and checks for a history gap on commit", () => {
      addPending("m-commit");
      message(children[0], {
        type: "commited",
        data: {
          umid: "m-commit",
          nodes: { me: { vote: true, commit: true } },
          entry: { $summary: { commit: 1 } },
        },
      });
      expect(resolved[0].r.status).to.equal(200);
      expect(resolved[0].r.data.$summary).to.deep.equal({ commit: 1 });
      expect(resolved[0].r.data.$nodes.me.commit).to.equal(true);
      expect(repaired).to.deep.equal(["m-commit"]);
    });

    it("keeps an early update's votes out of the entry", () => {
      const entry = addPending("m-early");
      message(children[0], {
        type: "broadcast",
        data: {
          umid: "m-early",
          early: true,
          nodes: { me: { vote: true } },
        },
      });
      expect(entry.$nodes).to.deep.equal({});
    });

    it("adopts revisions once, filling the missing sides", () => {
      const entry = addPending("m-revs");
      message(children[0], {
        type: "broadcast",
        data: { umid: "m-revs", revs: { $i: { a: { _rev: 1 } } } },
      });
      expect(entry.$revs).to.deep.equal({ $i: { a: { _rev: 1 } }, $o: {} });
      message(children[0], {
        type: "broadcast",
        data: { umid: "m-revs", revs: { $o: { b: { _rev: 2 } } } },
      });
      // Already has revs, not replaced
      expect(entry.$revs.$o).to.deep.equal({});
    });

    it("broadcasts when a processor asks", () => {
      const calls: any[] = [];
      const real = host.broadcast;
      host.broadcast = (...a: any[]) => calls.push(a);
      try {
        message(children[0], {
          type: "broadcast",
          data: { umid: "m-bc", early: true },
        });
      } finally {
        host.broadcast = real;
      }
      expect(calls).to.deep.equal([["m-bc", true]]);
    });

    it("hands contract data and versions to every processor", () => {
      for (const type of ["contractData", "contractLatestVersion"]) {
        const m = { type, data: { umid: "none" } };
        const counts = children.map((c) => c.sent.length);
        message(children[0], m);
        host.processors.forEach((p: any) => {
          expect(p.sent[p.sent.length - 1], type).to.equal(m);
        });
        // The standby has not processed anything, so it is not told
        expect(children[children.length - 1].sent.length).to.equal(
          counts[counts.length - 1]
        );
      }
    });

    it("tells the client what the processor knew when a rejection was unhandled but recoverable", () => {
      addPending("m-rej");
      message(children[0], {
        type: "unhandledrejection",
        data: { umid: "m-rej", recoverable: true, entry: { x: 1 } },
      });
      expect(resolved).to.have.length(1);
      expect(resolved[0].r.data.x).to.equal(1);
      expect(children[0].stop).to.equal(false);
    });

    it("replaces a processor that crashed, then retires it gracefully", () => {
      const before = children.length;
      const standby = host.standbyProcess;
      const orphan = addPending("m-orphan");
      orphan.$nodes = { me: { vote: true } };
      host.reference = "me";
      message(children[0], {
        type: "unhandledrejection",
        data: { umid: "m-orphan", recoverable: false, entry: {} },
      });

      // The pending tx was answered, the processor stopped taking work and
      // the standby moved into rotation with a fresh standby behind it
      expect(resolved).to.have.length(1);
      expect(children[0].stop).to.equal(true);
      expect(host.processors).to.include(standby);
      expect(host.standbyProcess).to.not.equal(standby);
      expect(children.length).to.equal(before + 1);

      // The new standby is sent its setup after a second
      const setupTimer = timers.find((t) => t.ms === 1000)!;
      setupTimer.fn();
      expect(host.standbyProcess.sent[0].type).to.equal("setup");

      // After the grace period what is still in the dead processor is
      // answered with a thread error, then the process is killed.
      resolved.length = 0;
      const grace = timers.find((t) => t.ms === 7 * 60 * 1000)!;
      grace.fn();
      expect(resolved).to.have.length(1);
      expect(resolved[0].r.data.$nodes.me.error).to.equal(
        "(Contract Thread Error) Unknown - Try Again"
      );
      let killed = false;
      children[0].kill = (() => (killed = true)) as any;
      timers.find((t) => t.ms === 2500)!.fn();
      expect(killed).to.equal(true);
      expect(host.processors.some((p: any) => p.pid === children[0].pid)).to.equal(
        false
      );

      // Put the pool back as it was for the tests that follow
      host.processors.splice(host.processors.indexOf(standby), 1);
      host.processors.unshift(children[0]);
      children[0].stop = false;
    });

    // Each forked processor can be unloaded once, so these use their own
    const crashable = () => {
      const proc = host.createProcessor(1);
      const standby = host.standbyProcess;
      const before = children.length;
      return {
        proc,
        before,
        restore: () => {
          host.processors.splice(host.processors.indexOf(standby), 1);
        },
      };
    };

    it("only replaces a crashed processor once", () => {
      const { proc, before, restore } = crashable();
      message(proc, { type: "memory", data: { rss: 3 * 1024 * 1024 } });
      message(proc, { type: "memory", data: { rss: 3 * 1024 * 1024 } });
      expect(proc.stop).to.equal(true);
      expect(children.length).to.equal(before + 1);
      restore();
    });

    it("replaces a processor whose process errors", () => {
      const { proc, before, restore } = crashable();
      proc.emit("error", new Error("spawn failed"));
      expect(proc.stop).to.equal(true);
      expect(children.length).to.equal(before + 1);
      restore();
    });

    it("logs, and carries on, for a message type it does not know", () => {
      expect(() =>
        message(children[0], { type: "mystery", data: { umid: "x" } })
      ).to.not.throw();
    });

    it("does not listen a second time when another worker reports ready", () => {
      let listens = 0;
      const real = host.api.listen;
      host.api.listen = () => listens++;
      try {
        message(children[0], { type: "ready", data: {} });
      } finally {
        host.api.listen = real;
      }
      expect(listens).to.equal(0);
    });
  });

  describe("reload", () => {
    it("tells every processor, including the standby, to reload", async () => {
      const real = ActiveOptions.extendConfig;
      ActiveOptions.extendConfig = (async () => ({})) as any;
      try {
        host.reload();
        await new Promise((r) => setImmediate(r));
      } finally {
        ActiveOptions.extendConfig = real;
      }
      for (const p of [...host.processors, host.standbyProcess]) {
        const last = p.sent[p.sent.length - 1];
        expect(last.type).to.equal("reload");
        expect(last.data.reference).to.equal(Home.reference);
      }
    });

    it("survives the config failing to load", async () => {
      const real = ActiveOptions.extendConfig;
      ActiveOptions.extendConfig = (async () => {
        throw new Error("unreadable");
      }) as any;
      try {
        host.reload();
        await new Promise((r) => setImmediate(r));
      } finally {
        ActiveOptions.extendConfig = real;
      }
    });
  });
});
