import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { App, TemplatedApp, us_listen_socket, us_listen_socket_close, us_socket_local_port } from "uWebSockets.js";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "../packages/crypto/src";
import { P2PClient, P2PIdentity } from "../packages/activep2p/src";
import { HybridApi } from "../packages/network/src/network/hybridApi";
import { HybridBans } from "../packages/network/src/network/hybridAdmin";
import { startHybridP2P } from "../packages/network/src/network/hybridP2P";
import { FeedClient, FeedSession, registerHybridRoutes } from "../packages/network/src/network/hybridRoutes";

class Mem {
  docs = new Map<string, any>();
  failAllDocs = false;
  put(d: any) { this.docs.set(d._id, d); return this; }
  async get(id: string) { const d = this.docs.get(id); return d ? { ...d } : { notFound: true }; }
  async allDocs(o: any) {
    if (this.failAllDocs) throw new Error("db down");
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()].sort().filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    return { rows: keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k, ...(o.include_docs ? { doc: this.docs.get(k) } : {}) })) };
  }
}

const silence = () => {
  const real = { error: (ActiveLogger as any).error, debug: (ActiveLogger as any).debug };
  const logged: any[][] = [];
  (ActiveLogger as any).error = (...a: any[]) => logged.push(a);
  (ActiveLogger as any).debug = () => undefined;
  return { logged, restore: () => Object.assign(ActiveLogger, real) };
};

describe("FeedSession end conditions (cov)", () => {
  const api = (over: any = {}): any => ({
    feedSince: async () => [],
    head: async () => "umid:1,a",
    minVersion: () => "5.1.0",
    ...over,
  });

  it("stops after the first heartbeat when the client cannot be written to", async () => {
    let stops = 0;
    const events: any[] = [];
    const s = new FeedSession(api(), (e) => (events.push(e), false), "", 1000, 10_000, Date.now, async () => true, () => stops++);
    await s.start();
    expect(events.map((e) => e.type)).to.deep.equal(["heartbeat"]);
    expect(stops).to.equal(1);
    expect((s as any).timer, "a stopped session must not keep a poll timer").to.equal(undefined);
    s.stop();
    expect(stops).to.equal(1);
  });

  it("tells the client it is not authorised and stops, without asking for a head", async () => {
    let stops = 0;
    let heads = 0;
    const events: any[] = [];
    const s = new FeedSession(
      api({ head: async () => (heads++, "x") }),
      (e) => (events.push(e), true),
      "",
      1000,
      10_000,
      Date.now,
      async () => false,
      () => stops++
    );
    await s.start();
    expect(events).to.deep.equal([{ type: "error", error: "not authorised" }]);
    expect(heads).to.equal(0);
    expect(stops).to.equal(1);
    expect((s as any).timer, "a stopped session must not keep a poll timer").to.equal(undefined);
    s.stop();
  });
});

describe("Hybrid routes: failure paths (cov)", () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  const pem = kp.generate().pub.pkcs8pem;
  const keyHash = ActiveCrypto.keyHash(pem);
  let clock = Date.now();
  const sign = () => {
    const r = ActiveCrypto.signRequest(kp, keyHash, ++clock);
    return { "x-hybrid-key": r.key, "x-hybrid-timestamp": String(r.timestamp), "x-hybrid-signature": r.signature };
  };

  let app: TemplatedApp;
  let listen: us_listen_socket;
  let port: number;
  let db: Mem;
  let events: Mem;
  let lookup: (h: string) => Promise<any>;
  let feeds: Set<FeedClient>;
  let open: http.ClientRequest[];
  let log: ReturnType<typeof silence>;

  beforeEach(async () => {
    log = silence();
    db = new Mem();
    events = new Mem();
    open = [];
    lookup = async (h) => (h === keyHash ? { key: pem, type: "rsa", endpoints: [] } : undefined);
    const api = new HybridApi({
      db: db as any,
      events: events as any,
      registry: { lookup: (h) => lookup(h), list: async () => [] },
      ledgerConfig: () => ({ required: [], window: { days: 30 }, minVersion: "5.1.0" }),
      setupStreamId: () => "setup",
      banned: () => new Set(),
    });
    app = App();
    feeds = registerHybridRoutes(app, api, { maxFeeds: () => 5, maxBodyBytes: 64 });
    await new Promise<void>((resolve, reject) =>
      app.listen("127.0.0.1", 0, (token) => {
        if (!token) return reject(new Error("could not listen"));
        listen = token;
        port = us_socket_local_port(token);
        resolve();
      })
    );
  });
  afterEach(() => {
    open.forEach((r) => r.destroy());
    us_listen_socket_close(listen);
    log.restore();
  });

  const request = (method: string, p: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

  it("POST /h/streams answers 500 with no detail when authentication throws", async () => {
    lookup = async () => {
      throw new Error("registry exploded");
    };
    const r = await request("POST", "/h/streams", sign(), "[]");
    expect(r.status).to.equal(500);
    expect(JSON.parse(r.body)).to.deep.equal({ error: "internal error" });
    expect(log.logged.some((l) => l[1] === "Hybrid streams failed")).to.equal(true);
  });

  it("POST /h/streams ignores a client that left before sending its whole body, and keeps serving", async () => {
    let lookups = 0;
    lookup = async (h) => {
      lookups++;
      return h === keyHash ? { key: pem, type: "rsa", endpoints: [] } : undefined;
    };
    const h = sign();
    await new Promise<void>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port }, () => {
        sock.write(
          `POST /h/streams HTTP/1.1\r\nHost: x\r\nContent-Length: 40\r\nx-hybrid-key: ${h["x-hybrid-key"]}\r\nx-hybrid-timestamp: ${h["x-hybrid-timestamp"]}\r\nx-hybrid-signature: ${h["x-hybrid-signature"]}\r\n\r\n[{"id"`
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 40);
      });
      sock.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 40));
    // the half body was never authenticated or answered
    expect(lookups).to.equal(0);
    const ok = await request("GET", "/h/head", sign());
    expect(ok.status, ok.body).to.equal(200);
  });

  it("a feed whose first heartbeat cannot be built ends cleanly and frees its slot", async () => {
    events.failAllDocs = true;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/h/feed", headers: sign(), agent: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      open.push(req);
    });
    expect(result.body).to.not.contain("event: heartbeat");
    expect(feeds.size).to.equal(0);
    expect(log.logged.map((l) => l[1]), JSON.stringify(result)).to.include("Hybrid feed failed to start");
  });
});

describe("Hybrid P2P: one feed per key across connections (cov)", () => {
  const identity = (): P2PIdentity => {
    const g = new ActiveCrypto.KeyPair("rsa").generate();
    return { type: "rsa", publicKey: g.pub.pkcs8pem, privateKey: g.prv.pkcs8pem };
  };
  const supernode = identity();
  const hybridA = identity();
  const hybridB = identity();
  const hashA = ActiveCrypto.keyHash(hybridA.publicKey);
  const hashB = ActiveCrypto.keyHash(hybridB.publicKey);
  let server: any;
  let feeds: Set<FeedClient>;

  beforeEach(async () => {
    feeds = new Set();
    const api = new HybridApi({
      db: new Mem() as any,
      events: new Mem() as any,
      registry: {
        lookup: async (h) =>
          h === hashA ? { key: hybridA.publicKey, type: "rsa", endpoints: [] }
          : h === hashB ? { key: hybridB.publicKey, type: "rsa", endpoints: [] }
          : undefined,
        list: async () => [],
      },
      ledgerConfig: () => ({ required: [], minVersion: "5.1.0" }),
      setupStreamId: () => "setup",
      banned: () => new Set(),
    });
    server = await startHybridP2P(api, feeds, { port: 0, host: "127.0.0.1", identity: supernode, maxFeeds: () => 1 });
  });
  afterEach(async () => server.close());

  const dial = (id: P2PIdentity) =>
    P2PClient.connect({ host: "127.0.0.1", port: server.port, identity: id, expectedPeerKey: supernode.publicKey });

  it("a second connection with the same key takes over the feed, even at the cap", async () => {
    const first = await dial(hybridA);
    const second = await dial(hybridA);
    const gotFirst: any[] = [];
    const gotSecond: any[] = [];
    first.handle("feed", (m) => { gotFirst.push(m); });
    second.handle("feed", (m) => { gotSecond.push(m); });
    await first.request("feed", { from: "" }, 2000);
    const firstClient = [...feeds][0];
    await second.request("feed", { from: "x" }, 2000);
    expect(feeds.size).to.equal(1);
    const current = [...feeds][0];
    expect(current).to.not.equal(firstClient);
    expect(current.since).to.equal("x");
    expect(current.keyHash).to.equal(hashA);
    // the replaced session ended: its connection gets no heartbeat after the swap
    const before = gotFirst.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(gotFirst.length).to.equal(before);
    expect(gotSecond.some((m) => m.type === "heartbeat")).to.equal(true);
    first.close();
    second.close();
  });

  it("a different key is refused once the cap is reached", async () => {
    const a = await dial(hybridA);
    const b = await dial(hybridB);
    await a.request("feed", { from: "" }, 2000);
    let err: any;
    try {
      await b.request("feed", { from: "" }, 2000);
    } catch (e) {
      err = e;
    }
    expect(String(err?.message || err)).to.contain("feed limit reached");
    expect([...feeds].map((f) => f.keyHash)).to.deep.equal([hashA]);
    a.close();
    b.close();
  });
});

describe("HybridBans persistence failure (cov)", () => {
  it("keeps the ban in memory and logs when the file cannot be written", () => {
    const log = silence();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-bans-"));
      const bans = new HybridBans(path.join(dir, "missing-dir", "bans.json"));
      const h = "a".repeat(64);
      expect(bans.ban(h)).to.equal(true);
      expect(bans.set().has(h)).to.equal(true);
      expect(log.logged).to.have.length(1);
      expect(log.logged[0][1]).to.equal("Could not save hybrid bans");
      expect(bans.unban(h)).to.equal(true);
      expect(bans.set().has(h)).to.equal(false);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      log.restore();
    }
  });
});
