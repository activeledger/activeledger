import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { subscribe } from "../packages/nano-gateway/src/routes/subscribe";

class FakeRes {
  writable = true;
  log: string[] = [];
  aborted: (() => void) | null = null;
  cork(cb: () => void) { cb(); return this; }
  writeStatus(s: string) { this.log.push(`status:${s}`); return this; }
  writeHeader(k: string, v: string) { this.log.push(`header:${k}=${v}`); return this; }
  write(c: string) { this.log.push(`write:${c}`); return true; }
  end(b?: string) { this.log.push(`end:${b}`); return this; }
  onAborted(h: () => void) { this.aborted = h; return this; }
}

describe("nano-gateway subscribe", () => {
  const keys = new ActiveCrypto.KeyPair("secp256k1").generate();
  const signer = new ActiveCrypto.KeyPair("secp256k1", keys.prv.pkcs8pem);
  const identity = "nano-1";

  const setup = () => {
    const feed: any = new EventEmitter();
    feed.cancelled = 0;
    feed.cancel = () => feed.cancelled++;
    const db: any = {
      since: undefined as any,
      get: async (id: string) => ({ _id: id, authorities: [{ public: keys.pub.pkcs8pem, type: "secp256k1" }] }),
      changes(a: any) { db.since = a.since; return feed; },
    };
    const opts: any = {
      db,
      allowlist: { isApproved: (i: string) => i === identity },
      authWindowSeconds: 60,
      heartbeatSeconds: 100,
    };
    return { feed, db, opts, res: new FakeRes() };
  };
  const goodBody = (extra: any = {}) => {
    const timestamp = Date.now();
    return { identity, timestamp, signature: signer.sign(`${identity}:${timestamp}`), streamIds: ["s1"], ...extra };
  };

  it("403s with the auth reason and never starts a feed", async () => {
    const { opts, res, db } = setup();
    let started = false;
    db.changes = () => { started = true; };
    const out = await subscribe({ body: { ...goodBody(), identity: "evil" } } as any, {}, res, opts);
    expect(out).to.equal("handled");
    expect(res.log).to.deep.equal([
      "status:403 Forbidden",
      "header:Content-Type=application/json",
      `end:${JSON.stringify({ error: "identity is not on the allowlist" })}`,
    ]);
    expect(started).to.equal(false);
  });

  it("403s with missing headers message when body is absent", async () => {
    const { opts, res } = setup();
    await subscribe({} as any, {}, res, opts);
    expect(res.log[0]).to.equal("status:403 Forbidden");
    expect(res.log[2]).to.match(/missing x-nano/);
  });

  it("400s on empty or non-array streamIds after auth passes", async () => {
    for (const streamIds of [[], "s1", undefined]) {
      const { opts, res, db } = setup();
      let started = false;
      db.changes = () => { started = true; };
      await subscribe({ body: goodBody({ streamIds }) } as any, {}, res, opts);
      expect(res.log).to.deep.equal([
        "status:400 Bad Request",
        "header:Content-Type=application/json",
        `end:${JSON.stringify({ error: "streamIds must be a non-empty array" })}`,
      ]);
      expect(started).to.equal(false);
    }
  });

  it("streams updates for subscribed ids only, with seq as event id", async () => {
    const { opts, res, feed, db } = setup();
    const out = await subscribe({ body: goodBody({ streamIds: ["s1", "s2"] }) } as any, {}, res, opts);
    expect(out).to.equal("handled");
    expect(res.log[0]).to.equal("status:200 OK");
    expect(db.since).to.equal("now");
    res.log = [];
    feed.emit("change", { doc: { _id: "other", _rev: "1" }, seq: 1 });
    expect(res.log).to.deep.equal([]);
    const before = Date.now();
    feed.emit("change", { doc: { _id: "s2", _rev: "3", v: 9 }, seq: "7-abc" });
    expect(res.log.length).to.equal(1);
    const m = /^write:id:7-abc\ndata:(.*)\n\n$/.exec(res.log[0])!;
    const ev = JSON.parse(m[1]);
    expect(ev.event).to.equal("update");
    expect(ev.stream).to.deep.equal({ _id: "s2", _rev: "3", v: 9 });
    expect(ev.time).to.be.within(before, Date.now());
  });

  it("resumes from the Last-Event-ID header", async () => {
    const { opts, res, db } = setup();
    await subscribe({ body: goodBody() } as any, { headers: { "Last-Event-ID": "55-x" } }, res, opts);
    expect(db.since).to.equal("55-x");
  });

  it("emits an error event on feed error, and cancels the feed when the client aborts", async () => {
    const { opts, res, feed } = setup();
    await subscribe({ body: goodBody() } as any, {}, res, opts);
    res.log = [];
    feed.emit("error", new Error("db down"));
    const m = /^write:data:(.*)\n\n$/.exec(res.log[0])!;
    const ev = JSON.parse(m[1]);
    expect(ev.event).to.equal("error");
    expect(ev.message).to.equal("Error: db down");
    expect(feed.cancelled).to.equal(0);
    res.aborted!();
    expect(feed.cancelled).to.equal(1);
    res.log = [];
    feed.emit("change", { doc: { _id: "s1", _rev: "1" }, seq: 1 });
    expect(res.log).to.deep.equal([]);
  });
});
