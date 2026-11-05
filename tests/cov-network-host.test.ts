import { expect } from "chai";
import "mocha";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require("child_process");
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { gzipSync } from "zlib";
import { generateKeyPairSync } from "crypto";
import { EventEmitter } from "events";
import { ActiveClone, ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "../packages/crypto/src";
import { P2PClient, P2PIdentity } from "../packages/activep2p/src";
import { ActiveInterfaces } from "../packages/network/src/network/utils";
import { Host } from "../packages/network/src/network/host";
import { Home } from "../packages/network/src/network/home";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbourhood } from "../packages/network/src/network/neighbourhood";

const freePorts = async (count: number): Promise<number[]> => {
  // consecutive ports: the host's P2P server sits on port + 1
  for (;;) {
    const servers: net.Server[] = [];
    try {
      const first: number = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.on("error", reject);
        s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
        servers.push(s);
      });
      for (let i = 1; i < count; i++) {
        await new Promise<void>((resolve, reject) => {
          const s = net.createServer();
          s.on("error", reject);
          s.listen(first + i, "127.0.0.1", () => resolve());
          servers.push(s);
        });
      }
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      return Array.from({ length: count }, (_, i) => first + i);
    } catch {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    }
  }
};

describe("Host with P2P and hybrid listeners (cov)", () => {
  const iface = ActiveInterfaces as any;
  const cfgKeys = ["host", "identity", "neighbourhood", "db", "cpus", "security", "remote", "p2pStreamServer", "hybrid-listen", "proxy"];
  let dir: string;
  let host: any;
  let port: number;
  let p2pPort: number;
  let hybridPort: number;
  let children: (EventEmitter & { pid: number; sent: any[]; stop: boolean; send: any })[];
  let saved: { [key: string]: any };
  let realFork: any;
  let realHealth: any;
  let realRemap: any;
  let realSetTimeout: any;
  let supernode: P2PIdentity;
  const realHome = {
    reference: Home.reference, host: Home.host, left: Home.left, right: Home.right,
    identity: Home.identity, publicPem: Home.publicPem,
  };
  const errors: any[][] = [];
  const fatals: any[][] = [];
  let realError: any;
  let realFatal: any;

  const request = (method: string, url: string, body?: Buffer | string, headers: { [k: string]: string } = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end(body);
    });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-host-"));
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const identity = path.join(dir, ".identity");
    fs.writeFileSync(identity, JSON.stringify({ prv: { pkcs8pem: pair.privateKey }, pub: { pkcs8pem: pair.publicKey } }));
    supernode = { type: "rsa", publicKey: pair.publicKey, privateKey: pair.privateKey };

    [port, p2pPort] = await freePorts(2);
    [hybridPort] = await freePorts(1);
    const config = ActiveOptions.fetch(false);
    saved = {};
    for (const key of cfgKeys) saved[key] = config[key];
    config.host = `127.0.0.1:${port}`;
    config.identity = identity;
    config.neighbourhood = [];
    config.db = { url: "http://127.0.0.1:1", database: "ledger", error: "error", event: "event" };
    config.cpus = 1;
    config.security = { maxRequestBytes: 4096 };
    config.remote = false;
    config.p2pStreamServer = true;
    config["hybrid-listen"] = hybridPort;
    delete config.proxy;
    saved.bindingHost = iface.bindingHost;
    saved.bindingPort = iface.bindingPort;
    iface.bindingHost = undefined;
    iface.bindingPort = undefined;
    realRemap = (Neighbourhood as any).remapedAddr;
    (Neighbourhood as any).remapedAddr = undefined;

    children = [];
    realFork = childProcess.fork;
    childProcess.fork = () => {
      const child: any = new EventEmitter();
      child.pid = 9500 + children.length;
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
    realSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: any, ms: any, ...a: any[]) =>
      ms === 2000 ? (0 as any) : realSetTimeout(fn, ms, ...a);
    realError = (ActiveLogger as any).error;
    realFatal = (ActiveLogger as any).fatal;
    (ActiveLogger as any).error = (...a: any[]) => errors.push(a);
    (ActiveLogger as any).fatal = (...a: any[]) => (fatals.push(a), new Error("fatal"));
    try {
      host = new Host();
    } finally {
      global.setTimeout = realSetTimeout;
    }
    await new Promise<void>((resolve) => {
      Host.onListening = resolve;
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
    (ActiveLogger as any).error = realError;
    (ActiveLogger as any).fatal = realFatal;
    Home.reference = realHome.reference;
    Home.host = realHome.host;
    Home.left = realHome.left;
    Home.right = realHome.right;
    Home.identity = realHome.identity;
    Home.publicPem = realHome.publicPem;
    const realExit = process.exit;
    (process as any).exit = () => undefined;
    host.p2pServer?.close();
    host.shutdown();
    await new Promise((r) => realSetTimeout(r, 1500));
    process.exit = realExit;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("P2P stream server", () => {
    let seen: any[][];
    let realProcess: any;
    let sockets: net.Socket[];

    beforeEach(() => {
      seen = [];
      sockets = [];
      realProcess = host.processEndpoints;
      host.processEndpoints = (...a: any[]) => seen.push(a);
      errors.length = 0;
    });
    afterEach(() => {
      host.processEndpoints = realProcess;
      sockets.forEach((s) => s.destroy());
    });

    const connect = () =>
      new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port: p2pPort }, () => resolve(s));
        s.on("error", reject);
        sockets.push(s);
      });
    const frame = async (ref: string, payload: any): Promise<Buffer> => {
      const body = await ActiveClone.serialize(payload, {});
      const header = Buffer.alloc(44);
      header.write(ref.padEnd(40, " "), 0);
      header.writeUInt32BE(body.length, 40);
      return Buffer.concat([header, body]);
    };
    const until = async (test: () => boolean, ms = 2000) => {
      const end = Date.now() + ms;
      while (!test()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    it("hands a framed transaction to the internal init endpoint as a peer message", async () => {
      const s = await connect();
      const ref = "a".repeat(40);
      s.write(await frame(ref, { $umid: "u1", n: [1, 2] }));
      await until(() => seen.length === 1);
      const [req, res, tx, from, isP2P] = seen[0];
      expect(req.method).to.equal("POST");
      expect(req.url).to.equal("/a/init");
      expect(req.headers).to.deep.equal({ "X-Activeledger": ref });
      expect(req.connection.remoteAddress).to.be.a("string");
      expect(res).to.equal(null);
      expect(tx).to.deep.equal({ $umid: "u1", n: [1, 2] });
      expect(from).to.equal(ref);
      expect(isP2P).to.equal(true);
    });

    it("trims the padding off the sender reference", async () => {
      const s = await connect();
      s.write(await frame("short-ref", { x: 1 }));
      await until(() => seen.length === 1);
      expect(seen[0][3]).to.equal("short-ref");
    });

    it("waits for the rest of a frame that arrives in pieces", async () => {
      const s = await connect();
      const whole = await frame("b".repeat(40), { $umid: "u2", pad: "x".repeat(300) });
      s.write(whole.subarray(0, 50));
      await new Promise((r) => setTimeout(r, 40));
      expect(seen).to.have.length(0);
      s.write(whole.subarray(50, 200));
      await new Promise((r) => setTimeout(r, 40));
      expect(seen).to.have.length(0);
      s.write(whole.subarray(200));
      await until(() => seen.length === 1);
      expect(seen[0][2].$umid).to.equal("u2");
    });

    it("waits for a header that is itself incomplete", async () => {
      const s = await connect();
      const whole = await frame("c".repeat(40), { $umid: "u3" });
      s.write(whole.subarray(0, 43));
      await new Promise((r) => setTimeout(r, 40));
      expect(seen).to.have.length(0);
      s.write(whole.subarray(43));
      await until(() => seen.length === 1);
    });

    it("handles several frames in one write, in order", async () => {
      const s = await connect();
      const a = await frame("d".repeat(40), { $umid: "first" });
      const b = await frame("e".repeat(40), { $umid: "second" });
      s.write(Buffer.concat([a, b]));
      await until(() => seen.length === 2);
      expect(seen.map((x) => x[2].$umid)).to.deep.equal(["first", "second"]);
      expect(seen.map((x) => x[3])).to.deep.equal(["d".repeat(40), "e".repeat(40)]);
    });

    it("logs a socket error instead of crashing", async () => {
      const s = await connect();
      await new Promise((r) => setTimeout(r, 30));
      s.resetAndDestroy();
      await until(() => errors.some((e) => e[1] === "P2P socket error"));
    });
  });

  describe("hybrid P2P listener", () => {
    it("forwards a hybrid's transaction into the external entry point, naming the relayer", async () => {
      const hybrid: P2PIdentity = (() => {
        const g = new ActiveCrypto.KeyPair("rsa").generate();
        return { type: "rsa", publicKey: g.pub.pkcs8pem, privateKey: g.prv.pkcs8pem };
      })();
      const hash = ActiveCrypto.keyHash(hybrid.publicKey);
      const realLookup = host.hybridRegistry.lookup;
      host.hybridRegistry.lookup = async (h: string) =>
        h === hash ? { key: hybrid.publicKey, type: "rsa", endpoints: [] } : undefined;
      const calls: any[][] = [];
      const realExternal = Endpoints.ExternalInitalise;
      (Endpoints as any).ExternalInitalise = async (...a: any[]) => {
        calls.push(a);
        return { statusCode: 200, content: { $summary: { commit: 1 } } };
      };
      let c: any;
      try {
        c = await P2PClient.connect({ host: "127.0.0.1", port: hybridPort, identity: hybrid, expectedPeerKey: supernode.publicKey });
        const reply = await c.request("tx-forward", { $tx: { x: 1 } }, 3000);
        expect(reply).to.deep.equal({ $summary: { commit: 1 } });
        expect(calls).to.have.length(1);
        expect(calls[0][0]).to.equal(host);
        expect(calls[0][1]).to.deep.equal({ $tx: { x: 1 } });
        expect(calls[0][2]).to.equal(`hybrid:${hash.slice(0, 12)}`);
        expect(calls[0][3]).to.equal(host.dbConnection);
      } finally {
        (Endpoints as any).ExternalInitalise = realExternal;
        host.hybridRegistry.lookup = realLookup;
        c?.close();
      }
    });
  });

  describe("request bodies", () => {
    it("answers 413 for a small wrapped-Buffer body whose inner gzip inflates past the limit", async () => {
      const bomb = gzipSync(Buffer.alloc(50_000, 0x20));
      const wrapped = JSON.stringify({ type: "Buffer", data: [...bomb] });
      expect(wrapped.length).to.be.lessThan(4096);
      const reply = await request("POST", "/", wrapped);
      expect(reply.status).to.equal(413);
      expect(JSON.parse(reply.text)).to.deep.equal({ error: "Request too large" });
    });
  });

  describe("a client that disconnects mid-request", () => {
    it("is ignored, and the host keeps serving", async () => {
      const aborted = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: "127.0.0.1", port }, () => {
          sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{\"partial\":");
          setTimeout(() => {
            sock.destroy();
            resolve(true);
          }, 40);
        });
        sock.on("error", () => resolve(false));
      });
      expect(aborted).to.equal(true);
      await new Promise((r) => setTimeout(r, 40));
      const ok = await request("GET", "/a/locks/check");
      expect(ok.status).to.equal(200);
      expect(JSON.parse(ok.text)).to.deep.equal({ checked: true });
    });
  });

  describe("a crashed processor", () => {
    it("is replaced by the standby, and a failure to set up the next standby is reported", async () => {
      const before = host.processors.length;
      const standby = host.standbyProcess;
      const timers: { fn: () => void; ms: number }[] = [];
      (global as any).setTimeout = (fn: any, ms: number) => (timers.push({ fn, ms }), 0 as any);
      let crashed: any;
      try {
        crashed = host.processors[0];
        crashed.emit("error", new Error("worker died"));
      } finally {
        global.setTimeout = realSetTimeout;
      }
      expect(host.processors).to.include(standby);
      expect(host.processors.length).to.equal(before + 1);
      expect(host.standbyProcess).to.not.equal(standby);
      expect(fatals.some((f) => f[1] === "Processor Crashed")).to.equal(true);
      // the new standby is given its set-up a second later; the send fails
      const setup = timers.find((t) => t.ms === 1000)!;
      expect(setup).to.not.equal(undefined);
      host.standbyProcess.send = (m: any, cb: (e: Error | null) => void) => {
        expect(m.type).to.equal("setup");
        cb(new Error("ipc channel closed"));
        return true;
      };
      fatals.length = 0;
      setup.fn();
      expect(fatals.map((f) => f[1])).to.deep.equal(["Issue with new Standby Process"]);
      expect(fatals[0][0].message).to.equal("ipc channel closed");
    });
  });
});

describe("Host private helpers (cov)", () => {
  const H: any = Host.prototype;
  const host = (extra: any = {}): any => Object.assign(Object.create(Host.prototype), extra);
  const cfg = () => ActiveOptions.fetch(false);
  let savedSecurity: any;
  beforeEach(() => {
    savedSecurity = cfg().security;
    cfg().security = { maxRequestBytes: 200 };
  });
  afterEach(() => {
    if (savedSecurity === undefined) delete cfg().security;
    else cfg().security = savedSecurity;
  });

  describe("makeSureNotBuffer", () => {
    const call = (v: unknown) => H.makeSureNotBuffer.call(host(), v);

    it("unwraps a {type:'Buffer'} object, inflating gzip content", async () => {
      expect(await call({ type: "Buffer", data: [...Buffer.from("plain text")] })).to.equal("plain text");
      expect(await call({ type: "Buffer", data: [...gzipSync(Buffer.from("zipped"))] })).to.equal("zipped");
    });

    it("leaves an empty wrapped Buffer and ordinary objects as they are", async () => {
      const empty = { type: "Buffer", data: [] };
      expect(await call(empty)).to.equal(empty);
      const plain = { a: 1 };
      expect(await call(plain)).to.equal(plain);
    });

    it("turns a Buffer into text, inflating one that is gzip", async () => {
      expect(await call(Buffer.from("hello"))).to.equal("hello");
      expect(await call(gzipSync(Buffer.from("squeezed")))).to.equal("squeezed");
    });

    it("reads a Buffer holding the JSON form of a Buffer, plain or gzip", async () => {
      const wrap = (b: Buffer) => Buffer.from(JSON.stringify({ type: "Buffer", data: [...b] }));
      expect(await call(wrap(Buffer.from("inner")))).to.equal("inner");
      expect(await call(wrap(gzipSync(Buffer.from("inner zipped"))))).to.equal("inner zipped");
    });

    it("refuses to inflate past maxRequestBytes (ERR_BUFFER_TOO_LARGE)", async () => {
      const bomb = gzipSync(Buffer.alloc(5000, 0x20));
      for (const input of [
        bomb,
        { type: "Buffer", data: [...bomb] },
        Buffer.from(JSON.stringify({ type: "Buffer", data: [...bomb] })),
      ]) {
        let err: any;
        try {
          await call(input);
        } catch (e) {
          err = e;
        }
        expect(err?.code).to.equal("ERR_BUFFER_TOO_LARGE");
      }
    });
  });

  describe("parseIp6", () => {
    const parse = (s: string) => H.parseIp6.call(host(), s);
    it("expands the unspecified address and compressed runs of zero", () => {
      expect(parse("::")).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(parse("::1")).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
      expect(parse("fe80::1")).to.deep.equal([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
      expect(parse("2001:db8::ff")).to.deep.equal([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0xff]);
    });
    it("reads a full address group by group", () => {
      expect(parse("1:2:3:4:5:6:7:8")).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8].map((n) => n));
      expect(parse("0:0:0:0:0:ffff:7f00:1")).to.deep.equal([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    });
  });

  describe("readBuffer", () => {
    const fakeRes = () => {
      const res: any = { writable: true, aborted: false, writes: [] as any[] };
      res.onData = (fn: any) => (res.feed = fn);
      res.cork = (fn: any) => fn();
      res.writeStatus = (s: string) => res.writes.push(["status", s]);
      res.writeHeader = () => undefined;
      res.end = (b: string) => res.writes.push(["end", b]);
      return res;
    };
    const ab = (n: number) => new Uint8Array(n).fill(7).buffer;

    it("joins chunks into one buffer", async () => {
      const res = fakeRes();
      const p = H.readBuffer.call(host(), res, 100);
      res.feed(new Uint8Array([1, 2]).buffer, false);
      res.feed(new Uint8Array([3]).buffer, true);
      expect(await p).to.deep.equal(Buffer.from([1, 2, 3]));
    });

    it("resolves an empty body to an empty buffer", async () => {
      const res = fakeRes();
      const p = H.readBuffer.call(host(), res, 100);
      res.feed(new ArrayBuffer(0), true);
      expect((await p).length).to.equal(0);
    });

    it("accepts exactly the maximum and refuses one byte more with a 413", async () => {
      const ok = fakeRes();
      const p = H.readBuffer.call(host(), ok, 10);
      ok.feed(ab(10), true);
      expect((await p).length).to.equal(10);

      const res = fakeRes();
      const q = H.readBuffer.call(host(), res, 10);
      res.feed(ab(11), false);
      let err: any;
      try {
        await q;
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("Request too large");
      expect(res.writes[0]).to.deep.equal(["status", "413 Payload Too Large"]);
      // data still arriving after a refusal is ignored, not answered twice
      res.feed(ab(5), true);
      expect(res.writes).to.have.length(2);
    });

    it("rejects when the client aborted", async () => {
      const res = fakeRes();
      const p = H.readBuffer.call(host(), res, 100);
      res.aborted = true;
      res.feed(ab(1), false);
      let err: any;
      try {
        await p;
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("Request aborted");
    });
  });

  describe("processEndpoints routing", () => {
    const REMOTE = "10.9.9.9";
    let writes: any[][];
    let allCalls: any[][];
    const realAll = Endpoints.all;
    const realEncrypt = Endpoints.ExternalEncrypt;
    const realInternal = Endpoints.InternalInitalise;

    const make = (over: any = {}) =>
      host({
        dbConnection: { id: "db" },
        writeResponse: (...a: any[]) => writes.push(a),
        firewallCheck: () => true,
        ...over,
      });
    const res = { writable: true };
    const run = (h: any, method: string, url: string, remote = REMOTE, body?: any, headers: any = {}) =>
      H.processEndpoints.call(h, { headers: { "Accept-Encoding": "gz", ...headers }, method, url, connection: { remoteAddress: remote } }, res, body);
    const settle = () => new Promise((r) => setImmediate(r));

    beforeEach(() => {
      writes = [];
      allCalls = [];
      (Endpoints as any).all = (...a: any[]) => (allCalls.push(a), Promise.resolve({ statusCode: 200, content: { all: true } }));
    });
    afterEach(() => {
      (Endpoints as any).all = realAll;
      (Endpoints as any).ExternalEncrypt = realEncrypt;
      (Endpoints as any).InternalInitalise = realInternal;
    });

    for (const [method, url] of [["GET", "/a/hybrid/list"], ["GET", "/a/hybrid/feeds"], ["POST", "/a/hybrid/ban"], ["POST", "/a/hybrid/unban"]]) {
      it(`${method} ${url} is forbidden from anything but loopback`, () => {
        run(make(), method, url, REMOTE, { keyHash: "a".repeat(64) });
        expect(writes).to.deep.equal([[res, 403, "Forbidden", "gz"]]);
      });
    }

    it("serves all streams to a neighbour only", async () => {
      run(make(), "GET", "/a/all");
      await settle();
      expect(allCalls).to.deep.equal([[{ id: "db" }]]);
      expect(writes).to.deep.equal([[res, 200, JSON.stringify({ all: true }), "gz"]]);

      writes = [];
      allCalls = [];
      run(make({ firewallCheck: () => false }), "GET", "/a/all");
      expect(allCalls).to.deep.equal([]);
      expect(writes).to.deep.equal([[res, 403, "Forbidden", "gz"]]);
    });

    it("serves all streams from a start point to a neighbour", async () => {
      run(make(), "GET", "/a/all/abc");
      await settle();
      expect(allCalls).to.deep.equal([[{ id: "db" }, "abc"]]);
    });

    it("refuses an unknown GET path with 404 for a neighbour and 403 for anyone else", () => {
      run(make(), "GET", "/a/nothing-here");
      run(make({ firewallCheck: () => false }), "GET", "/a/nothing-here");
      expect(writes).to.deep.equal([
        [res, 404, "Not Found", "gz"],
        [res, 403, "Forbidden", "gz"],
      ]);
    });

    it("answers 404 when a neighbour's GET has no url at all", () => {
      run(make(), "GET", "");
      expect(writes).to.deep.equal([[res, 404, "Not Found", "gz"]]);
    });

    it("forbids a remote, non-neighbour caller of admin-reload when remote reload is enabled", () => {
      const saved = cfg().remote;
      cfg().remote = true;
      try {
        run(make({ firewallCheck: () => false }), "GET", "/a/admin-reload", REMOTE);
      } finally {
        cfg().remote = saved;
      }
      expect(writes).to.deep.equal([[res, 403, "Forbidden", "gz"]]);
    });

    it("hands an encrypt request the body and the encryption header", async () => {
      const calls: any[][] = [];
      (Endpoints as any).ExternalEncrypt = (...a: any[]) => (calls.push(a), Promise.resolve({ statusCode: 200, content: { enc: 1 } }));
      const h = make();
      run(h, "POST", "/a/encrypt", REMOTE, { tx: 1 }, { "x-activeledger-encrypt": "yes" });
      await settle();
      expect(calls).to.deep.equal([[h, { tx: 1 }, "yes", { id: "db" }]]);
      expect(writes).to.deep.equal([[res, 200, JSON.stringify({ enc: 1 }), "gz"]]);

      calls.length = 0;
      run(h, "POST", "/a/encrypt", REMOTE, { tx: 2 });
      expect(calls[0][2]).to.equal(false);
    });

    it("only lets a neighbour post an internal init", async () => {
      run(make({ firewallCheck: () => false }), "POST", "/a/init", REMOTE, {});
      expect(writes).to.deep.equal([[res, 403, "Forbidden", "gz"]]);

      const calls: any[][] = [];
      (Endpoints as any).InternalInitalise = (...a: any[]) => (calls.push(a), Promise.resolve({ statusCode: 200, content: {} }));
      const h = make();
      H.processEndpoints.call(
        h,
        { headers: { "X-Activeledger": "peer-ref" }, method: "POST", url: "/a/init", connection: { remoteAddress: REMOTE } },
        res,
        { b: 1 },
        undefined,
        true
      );
      expect(calls).to.deep.equal([[h, { b: 1 }, REMOTE, false, true, "peer-ref"]]);
    });

    it("answers 404 to an unknown POST path and to an unknown method", () => {
      run(make(), "POST", "/a/nothing", REMOTE, {});
      run(make(), "DELETE", "/a/all");
      expect(writes).to.deep.equal([
        [res, 404, "Not Found", "gz"],
        [res, 404, "Not Found", "gz"],
      ]);
    });
  });
});
