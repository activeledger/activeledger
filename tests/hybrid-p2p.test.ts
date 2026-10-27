import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import { P2PClient, P2PIdentity } from "../packages/activep2p/src";
import { HybridApi } from "../packages/network/src/network/hybridApi";
import { startHybridP2P } from "../packages/network/src/network/hybridP2P";
import { FeedClient } from "../packages/network/src/network/hybridRoutes";

const identity = (): P2PIdentity => {
  const g = new ActiveCrypto.KeyPair("rsa").generate();
  return { type: "rsa", publicKey: g.pub.pkcs8pem, privateKey: g.prv.pkcs8pem };
};

class Mem {
  docs = new Map<string, any>();
  put(d: any) { this.docs.set(d._id, d); return this; }
  async get(id: string) { const d = this.docs.get(id); return d ? { ...d } : { notFound: true }; }
  async allDocs(o: any) {
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()].sort().filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    return { rows: keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k, ...(o.include_docs ? { doc: this.docs.get(k) } : {}) })) };
  }
}

describe("supernode hybrid P2P listener", () => {
  const supernode = identity();
  const hybrid = identity();
  const hybridHash = ActiveCrypto.keyHash(hybrid.publicKey);
  let db: Mem, events: Mem, state: { retired: boolean; banned: boolean; registered: boolean };
  let feeds: Set<FeedClient>;
  let server: any;
  let forwarded: any[];

  beforeEach(async () => {
    db = new Mem();
    events = new Mem();
    state = { retired: false, banned: false, registered: true };
    feeds = new Set();
    forwarded = [];
    const api = new HybridApi({
      db: db as any,
      events: events as any,
      registry: {
        lookup: async (h) => (state.registered && h === hybridHash ? { key: hybrid.publicKey, type: "rsa", endpoints: [], retired: state.retired } : undefined),
        list: async () => [],
      },
      ledgerConfig: () => ({ required: [], minVersion: "5.1.0" }),
      setupStreamId: () => "setup",
      banned: () => (state.banned ? new Set([hybridHash]) : new Set()),
    });
    server = await startHybridP2P(api, feeds, {
      port: 0,
      host: "127.0.0.1",
      identity: supernode,
      maxFeeds: () => 1,
      forward: async (tx, relayer) => (forwarded.push({ tx, relayer }), { $summary: { commit: 1 } }),
    });
  });
  afterEach(async () => server.close());

  const dial = (id: P2PIdentity = hybrid) =>
    P2PClient.connect({ host: "127.0.0.1", port: server.port, identity: id, expectedPeerKey: supernode.publicKey });

  it("serves the request channels to a registered hybrid", async () => {
    db.put({ _id: "setup", network: true }).put({ _id: "a", _rev: "1-x" }).put({ _id: "a:stream", _rev: "1-y" });
    db.put({ _id: "u1:umid", umid: {} });
    events.put({ _id: "attest:u1", node: "n", umid: "u1", sig: "s", nodes: {} });
    const c = await dial();
    expect((await c.request("bootstrap", {}, 2000)).setup._id).to.equal("setup");
    expect((await c.request("streams", [{ id: "a" }], 2000)).docs.map((d: any) => d._id)).to.deep.equal(["a", "a:stream"]);
    expect(await c.request("umid", { umid: "u1" }, 2000)).to.include({ _id: "u1:umid" });
    expect(await c.request("attest", { umid: "u1" }, 2000)).to.include({ node: "n" });
    expect(await c.request("peers", {}, 2000)).to.deep.equal([]);
    expect(await c.request("umid", { umid: "../x" }, 2000)).to.equal(undefined);
    c.close();
  });

  it("refuses an unregistered key at the handshake", async () => {
    state.registered = false;
    let err: any;
    try { await dial(); } catch (e) { err = e; }
    expect(err).to.be.instanceOf(Error);
  });

  it("pushes the feed down the open connection, then heartbeats", async () => {
    events.put({ _id: "umid:1000,u1" }).put({ _id: "attest:u1", node: "n", umid: "u1", outcome: "committed", revsOut: {}, umidDocHash: "d", sig: "s", nodes: { n: { vote: true } } });
    db.put({ _id: "u1:umid", umid: { $revs: { $i: {}, $o: {} } }, streams: { new: [], updated: [] } });
    const c = await dial();
    const got: any[] = [];
    c.handle("feed", (m) => { got.push(m); });
    expect(await c.request("feed", { from: "" }, 2000)).to.deep.equal({ ok: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(got.some((m) => m.type === "heartbeat")).to.equal(true);
    const item = got.find((m) => m.type === "item");
    expect(item.cursor).to.equal("umid:1000,u1");
    expect(item.item.umid).to.equal("u1");
    expect([...feeds].map((f) => f.keyHash)).to.deep.equal([hybridHash]);
    c.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(feeds.size).to.equal(0);
  });

  it("caps feeds, and a repeat feed request from the same key replaces the first", async () => {
    const c = await dial();
    await c.request("feed", { from: "" }, 2000);
    await c.request("feed", { from: "" }, 2000);
    expect(feeds.size).to.equal(1);
    c.close();
  });

  it("drops a hybrid that is retired or banned while connected", async () => {
    const c = await dial();
    state.banned = true;
    let err: any;
    try { await c.request("bootstrap", {}, 2000); } catch (e) { err = e; }
    expect(err).to.be.instanceOf(Error);
  });

  it("hands a forwarded transaction to the normal entry point, naming the relayer", async () => {
    const c = await dial();
    const r = await c.request("tx-forward", { $tx: { x: 1 } }, 2000);
    expect(r).to.deep.equal({ $summary: { commit: 1 } });
    expect(forwarded[0].relayer).to.equal(hybridHash);
    c.close();
  });
});
