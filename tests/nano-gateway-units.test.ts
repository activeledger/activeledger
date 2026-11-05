import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { Allowlist } from "../packages/nano-gateway/src/allowlist";
import { NanoSSE } from "../packages/nano-gateway/src/sse";
import { ChangesWatcher } from "../packages/nano-gateway/src/changesWatcher";
import { verifyHandshake } from "../packages/nano-gateway/src/auth";
import {
  looksLikeDoc,
  getStream,
  getStreams,
} from "../packages/nano-gateway/src/routes/stream";
import { getTransaction } from "../packages/nano-gateway/src/routes/tx";
import { ActiveCrypto } from "@activeledger/activecrypto";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nanogw-"));

describe("nano-gateway Allowlist", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tmp();
    file = path.join(dir, "al.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("missing file means nobody approved and empty list", () => {
    const a = new Allowlist(file);
    expect(a.isApproved("x")).to.equal(false);
    expect(a.list()).to.deep.equal([]);
  });

  it("corrupt file is treated as empty", () => {
    fs.writeFileSync(file, "{not json");
    const a = new Allowlist(file);
    expect(a.list()).to.deep.equal([]);
    expect(a.isApproved("x")).to.equal(false);
  });

  it("add persists, stamps addedAt, and approves exactly that identity", () => {
    const a = new Allowlist(file);
    const before = Date.now();
    a.add({ identity: "n1", label: "one" });
    const [e] = a.list();
    expect(e.identity).to.equal("n1");
    expect(e.label).to.equal("one");
    expect(e.addedAt).to.be.within(before, Date.now());
    expect(a.isApproved("n1")).to.equal(true);
    expect(a.isApproved("n2")).to.equal(false);
    expect(fs.readFileSync(file, "utf8").endsWith("]\n")).to.equal(true);
    expect(new Allowlist(file).isApproved("n1")).to.equal(true);
  });

  it("add keeps a supplied addedAt and ignores duplicates", () => {
    const a = new Allowlist(file);
    a.add({ identity: "n1", addedAt: 5 });
    a.add({ identity: "n1", label: "dup", addedAt: 9 });
    expect(a.list()).to.deep.equal([{ identity: "n1", addedAt: 5 }]);
  });

  it("remove drops only the named identity", () => {
    const a = new Allowlist(file);
    a.add({ identity: "n1" });
    a.add({ identity: "n2" });
    a.remove("n1");
    expect(a.list().map((e) => e.identity)).to.deep.equal(["n2"]);
    a.remove("absent");
    expect(a.list().map((e) => e.identity)).to.deep.equal(["n2"]);
  });
});

class FakeRes {
  writable = true;
  log: string[] = [];
  corks = 0;
  aborted: (() => void) | null = null;
  cork(cb: () => void) {
    this.corks++;
    cb();
    return this;
  }
  writeStatus(s: string) {
    this.log.push(`status:${s}`);
    return this;
  }
  writeHeader(k: string, v: string) {
    this.log.push(`header:${k}=${v}`);
    return this;
  }
  write(c: string) {
    this.log.push(`write:${c}`);
    return true;
  }
  end(b?: string) {
    this.log.push(`end:${b}`);
    return this;
  }
  onAborted(h: () => void) {
    this.aborted = h;
    return this;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("nano-gateway NanoSSE", () => {
  it("writes SSE status and headers on construction", () => {
    const res = new FakeRes();
    const sse = new NanoSSE(res, 100);
    expect(res.log).to.deep.equal([
      "status:200 OK",
      "header:Content-Type=text/event-stream",
      "header:Cache-Control=no-cache",
      "header:Access-Control-Allow-Origin=*",
    ]);
    sse.close();
  });

  it("write frames data with and without id; falsy id 0 is kept", () => {
    const res = new FakeRes();
    const sse = new NanoSSE(res, 100);
    res.log = [];
    expect(sse.write({ a: 1 })).to.equal(true);
    expect(sse.write({ b: 2 }, "s1")).to.equal(true);
    expect(sse.write({ c: 3 }, 0)).to.equal(true);
    expect(res.log).to.deep.equal([
      'write:data:{"a":1}\n\n',
      'write:id:s1\ndata:{"b":2}\n\n',
      'write:id:0\ndata:{"c":3}\n\n',
    ]);
    sse.close();
  });

  it("write returns false and writes nothing when closed or not writable", () => {
    const res = new FakeRes();
    const sse = new NanoSSE(res, 100);
    res.log = [];
    res.writable = false;
    expect(sse.write({ a: 1 })).to.equal(false);
    res.writable = true;
    sse.close();
    expect(sse.write({ a: 1 })).to.equal(false);
    expect(res.log).to.deep.equal([]);
  });

  it("heartbeat emits comment frames at the interval and stops on close", async () => {
    const res = new FakeRes();
    const sse = new NanoSSE(res, 0.01);
    res.log = [];
    await sleep(60);
    expect(res.log.length).to.be.greaterThan(0);
    expect(res.log.every((l) => l === "write::\n\n")).to.equal(true);
    res.writable = false;
    res.log = [];
    await sleep(40);
    expect(res.log).to.deep.equal([]);
    res.writable = true;
    await sleep(40);
    expect(res.log.length).to.be.greaterThan(0);
    sse.close();
    sse.close();
    res.log = [];
    await sleep(40);
    expect(res.log).to.deep.equal([]);
  });

  it("heartbeat does not fire before the interval elapses", async () => {
    const res = new FakeRes();
    const sse = new NanoSSE(res, 10);
    res.log = [];
    await sleep(30);
    expect(res.log).to.deep.equal([]);
    sse.close();
  });

  it("closed instance stops heartbeat output even if writable", async () => {
    const res = new FakeRes();
    const sse = new NanoSSE(res, 0.01);
    sse.close();
    res.log = [];
    await sleep(40);
    expect(res.log).to.deep.equal([]);
  });

  it("abort marks unwritable, closes and calls onClose; works without onClose", () => {
    const res = new FakeRes();
    let closed = 0;
    const sse = new NanoSSE(res, 100, () => closed++);
    res.aborted!();
    expect(res.writable).to.equal(false);
    expect(closed).to.equal(1);
    expect(sse.write({})).to.equal(false);

    const res2 = new FakeRes();
    new NanoSSE(res2, 100);
    res2.aborted!();
    expect(res2.writable).to.equal(false);
  });
});

describe("nano-gateway ChangesWatcher", () => {
  const makeDb = () => {
    const feed: any = new EventEmitter();
    feed.cancelled = 0;
    feed.cancel = () => feed.cancelled++;
    const db: any = {
      args: null,
      changes(a: any) {
        db.args = a;
        return feed;
      },
    };
    return { db, feed };
  };

  it("starts a live feed with docs from `since`, defaulting to now", () => {
    const { db } = makeDb();
    new ChangesWatcher(db, new Set(["a"])).start(() => {}, () => {});
    expect(db.args).to.deep.equal({ live: true, since: "now", include_docs: true });
    const m = makeDb();
    new ChangesWatcher(m.db, new Set(["a"]), "42-x").start(() => {}, () => {});
    expect(m.db.args.since).to.equal("42-x");
  });

  it("forwards only watched state docs, skipping :-ids, deletes and rewrites", () => {
    const { db, feed } = makeDb();
    const got: any[] = [];
    new ChangesWatcher(db, new Set(["a", "a:stream", "d", "r", "k"])).start(
      (doc, seq) => got.push([doc._id, seq]),
      () => {}
    );
    feed.emit("change", { doc: { _id: "a", _rev: "1" }, seq: 1 });
    feed.emit("change", { doc: { _id: "a:stream", _rev: "1" }, seq: 2 });
    feed.emit("change", { doc: { _id: "zzz", _rev: "1" }, seq: 3 });
    feed.emit("change", { doc: { _id: "d", $activeledger: { delete: true } }, seq: 4 });
    feed.emit("change", { doc: { _id: "r", $activeledger: { rewrite: true } }, seq: 5 });
    feed.emit("change", { doc: { _id: "k", $activeledger: {} }, seq: 6 });
    expect(got).to.deep.equal([["a", 1], ["k", 6]]);
  });

  it("routes feed errors to onError; stop cancels once and is safe to repeat", () => {
    const { db, feed } = makeDb();
    const errs: unknown[] = [];
    const w = new ChangesWatcher(db, new Set());
    w.start(() => {}, (e) => errs.push(e));
    feed.emit("error", "boom");
    expect(errs).to.deep.equal(["boom"]);
    w.stop();
    w.stop();
    expect(feed.cancelled).to.equal(1);
    new ChangesWatcher(db, new Set()).stop();
  });
});

describe("nano-gateway routes", () => {
  it("looksLikeDoc requires an object with string _id", () => {
    expect(looksLikeDoc({ _id: "a" })).to.equal(true);
    expect(looksLikeDoc({ _id: 1 })).to.equal(false);
    expect(looksLikeDoc({})).to.equal(false);
    expect(looksLikeDoc(null)).to.equal(false);
    expect(looksLikeDoc("a")).to.equal(false);
    expect(looksLikeDoc(undefined)).to.equal(false);
  });

  it("getStream returns the doc, null for non-docs, null on throw; uses url[2]", async () => {
    let asked = "";
    const db: any = { get: async (id: string) => ((asked = id), { _id: id, v: 1 }) };
    expect(await getStream({ url: ["api", "stream", "abc"] } as any, db)).to.deep.equal({
      stream: { _id: "abc", v: 1 },
    });
    expect(asked).to.equal("abc");
    const weird: any = { get: async () => ({ error: "notfound" }) };
    expect(await getStream({ url: ["", "", "x"] } as any, weird)).to.deep.equal({ stream: null });
    const bad: any = { get: async () => { throw new Error("x"); } };
    expect(await getStream({ url: ["", "", "x"] } as any, bad)).to.deep.equal({ stream: null });
  });

  it("getStreams handles empty/non-array bodies without hitting the db", async () => {
    const db: any = { allDocs: async () => { throw new Error("must not call"); } };
    expect(await getStreams({ body: [] } as any, db)).to.deep.equal({ streams: [] });
    expect(await getStreams({ body: { a: 1 } } as any, db)).to.deep.equal({ streams: [] });
    expect(await getStreams({} as any, db)).to.deep.equal({ streams: [] });
  });

  it("getStreams queries by keys and drops missing docs", async () => {
    let args: any;
    const db: any = {
      allDocs: async (a: any) => {
        args = a;
        return { rows: [{ doc: { _id: "a" } }, { key: "b", error: "nf" }, { doc: null }, { doc: { _id: "c" } }] };
      },
    };
    const r = await getStreams({ body: ["a", "b", "c"] } as any, db);
    expect(args).to.deep.equal({ keys: ["a", "b", "c"], include_docs: true });
    expect(r).to.deep.equal({ streams: [{ _id: "a" }, { _id: "c" }] });
    const noRows: any = { allDocs: async () => undefined };
    expect(await getStreams({ body: ["a"] } as any, noRows)).to.deep.equal({ streams: [] });
  });

  it("getTransaction returns umid of the :umid doc, null otherwise", async () => {
    let asked = "";
    const db: any = { get: async (id: string) => ((asked = id), { _id: id, umid: { x: 1 } }) };
    expect(await getTransaction({ url: ["", "", "T1"] } as any, db)).to.deep.equal({ transaction: { x: 1 } });
    expect(asked).to.equal("T1:umid");
    const noUmid: any = { get: async (id: string) => ({ _id: id }) };
    expect(await getTransaction({ url: ["", "", "T"] } as any, noUmid)).to.deep.equal({ transaction: null });
    const notDoc: any = { get: async () => ({ error: "nf" }) };
    expect(await getTransaction({ url: ["", "", "T"] } as any, notDoc)).to.deep.equal({ transaction: null });
    const bad: any = { get: async () => { throw new Error("x"); } };
    expect(await getTransaction({ url: ["", "", "T"] } as any, bad)).to.deep.equal({ transaction: null });
  });
});

describe("nano-gateway verifyHandshake", () => {
  const kp = new ActiveCrypto.KeyPair("secp256k1");
  const keys = kp.generate();
  const signer = new ActiveCrypto.KeyPair("secp256k1", keys.prv.pkcs8pem);
  const identity = "nano-1";
  const allow: any = { isApproved: (i: string) => i === identity };
  const stream = (authorities: any) => ({
    get: async (id: string) => {
      if (id !== `${identity}:stream`) throw new Error("nf");
      return { _id: id, authorities };
    },
  }) as any;
  const goodAuth = [{ public: keys.pub.pkcs8pem, type: "secp256k1" }];
  const sign = (ts: string) => signer.sign(`${identity}:${ts}`);

  it("accepts a valid fresh signature", async () => {
    const ts = String(Date.now());
    const r = await verifyHandshake({ identity, timestamp: ts, signature: sign(ts) }, allow, stream(goodAuth), 60);
    expect(r).to.deep.equal({ ok: true });
  });

  it("accepts when a later authority matches", async () => {
    const other = new ActiveCrypto.KeyPair("secp256k1").generate();
    const ts = String(Date.now());
    const r = await verifyHandshake(
      { identity, timestamp: ts, signature: sign(ts) },
      allow,
      stream([{ public: other.pub.pkcs8pem, type: "secp256k1" }, ...goodAuth]),
      60
    );
    expect(r.ok).to.equal(true);
  });

  it("rejects each missing header", async () => {
    const ts = String(Date.now());
    const full: any = { identity, timestamp: ts, signature: sign(ts) };
    for (const k of ["identity", "timestamp", "signature"]) {
      const h = { ...full };
      delete h[k];
      const r = await verifyHandshake(h, allow, stream(goodAuth), 60);
      expect(r.ok).to.equal(false);
      expect(r.reason).to.match(/missing/);
    }
  });

  it("rejects unlisted identity without touching the db", async () => {
    const ts = String(Date.now());
    const db: any = { get: async () => { throw new Error("db touched"); } };
    const r = await verifyHandshake({ identity: "evil", timestamp: ts, signature: "s" }, allow, db, 60);
    expect(r).to.deep.equal({ ok: false, reason: "identity is not on the allowlist" });
  });

  it("rejects bad, stale and future timestamps; accepts at the window edge", async () => {
    const reasonRe = /timestamp/;
    const bad = await verifyHandshake({ identity, timestamp: "abc", signature: "s" }, allow, stream(goodAuth), 60);
    expect(bad.reason).to.match(reasonRe);
    const inf = await verifyHandshake({ identity, timestamp: "Infinity", signature: "s" }, allow, stream(goodAuth), 60);
    expect(inf.reason).to.match(reasonRe);
    const stale = String(Date.now() - 61000);
    const r1 = await verifyHandshake({ identity, timestamp: stale, signature: sign(stale) }, allow, stream(goodAuth), 60);
    expect(r1.reason).to.match(reasonRe);
    const future = String(Date.now() + 61000);
    const r2 = await verifyHandshake({ identity, timestamp: future, signature: sign(future) }, allow, stream(goodAuth), 60);
    expect(r2.reason).to.match(reasonRe);
    const inside = String(Date.now() - 50000);
    const r3 = await verifyHandshake({ identity, timestamp: inside, signature: sign(inside) }, allow, stream(goodAuth), 60);
    expect(r3.ok).to.equal(true);
  });

  it("rejects when the stream record is missing, malformed, or the db throws", async () => {
    const ts = String(Date.now());
    const h = { identity, timestamp: ts, signature: sign(ts) };
    const expected = { ok: false, reason: "identity has no on-ledger record" };
    expect(await verifyHandshake(h, allow, { get: async () => ({ error: "nf" }) } as any, 60)).to.deep.equal(expected);
    expect(await verifyHandshake(h, allow, { get: async () => { throw new Error("x"); } } as any, 60)).to.deep.equal(expected);
  });

  it("rejects when there are no authorities (missing or empty)", async () => {
    const ts = String(Date.now());
    const h = { identity, timestamp: ts, signature: sign(ts) };
    const expected = { ok: false, reason: "identity has no registered authorities on-ledger" };
    expect(await verifyHandshake(h, allow, stream(undefined), 60)).to.deep.equal(expected);
    expect(await verifyHandshake(h, allow, stream([]), 60)).to.deep.equal(expected);
  });

  it("rejects a signature from the wrong key or over the wrong payload", async () => {
    const ts = String(Date.now());
    const other = new ActiveCrypto.KeyPair("secp256k1");
    const ok2 = other.generate();
    const wrongKey = new ActiveCrypto.KeyPair("secp256k1", ok2.prv.pkcs8pem).sign(`${identity}:${ts}`);
    const r = await verifyHandshake({ identity, timestamp: ts, signature: wrongKey }, allow, stream(goodAuth), 60);
    expect(r.ok).to.equal(false);
    expect(r.reason).to.match(/did not verify/);
    const wrongPayload = signer.sign(`${identity}:${Number(ts) + 1}`);
    const r2 = await verifyHandshake({ identity, timestamp: ts, signature: wrongPayload }, allow, stream(goodAuth), 60);
    expect(r2.ok).to.equal(false);
  });
});
