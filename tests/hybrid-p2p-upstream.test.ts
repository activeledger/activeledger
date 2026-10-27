import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import { P2PConnection, P2PIdentity, P2PServer } from "../packages/activep2p/src";
import { HybridApi } from "../packages/network/src/network/hybridApi";
import { startHybridP2P } from "../packages/network/src/network/hybridP2P";
import { FeedClient } from "../packages/network/src/network/hybridRoutes";
import { identityFrom, UpstreamError } from "../packages/hybrid/src/http-upstream";
import { P2PUpstream, P2PUpstreamOptions } from "../packages/hybrid/src/p2p-upstream";

const keys = () => new ActiveCrypto.KeyPair("rsa").generate();
const p2pIdentity = (g = keys()): P2PIdentity => ({ type: "rsa", publicKey: g.pub.pkcs8pem, privateKey: g.prv.pkcs8pem });

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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the UpstreamError (or other error) the promise rejects with */
const failure = async (p: Promise<any>): Promise<any> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("hybrid P2P upstream", function () {
  this.timeout(10000);
  const supernodeKeys = keys();
  const supernode = p2pIdentity(supernodeKeys);
  const hybridKeys = keys();
  const hybrid = identityFrom({ prv: { pkcs8pem: hybridKeys.prv.pkcs8pem }, pub: { pkcs8pem: hybridKeys.pub.pkcs8pem } });
  const hybridHash = ActiveCrypto.keyHash(hybrid.publicPem);
  const NETWORK = "net-1";
  const setupFor = (publicKey: string) => ({
    _id: "setup",
    neighbourhood: [
      { host: "10.0.0.1", port: 5260, identity: { type: "rsa", public: publicKey } },
      { host: "10.0.0.2", port: 5260, identity: { type: "rsa", public: p2pIdentity().publicKey } },
    ],
  });

  let db: Mem, events: Mem, state: { retired: boolean; banned: boolean; registered: boolean };
  let feeds: Set<FeedClient>;
  let server: P2PServer;
  let forwarded: any[];
  let serverConns: P2PConnection[];
  let upstreams: P2PUpstream[];

  const addItem = (n: number) => {
    const umid = `u${n}`;
    events.put({ _id: `umid:${1000 + n},${umid}` }).put({
      _id: `attest:${umid}`, node: "n", umid, outcome: "committed", revsOut: {}, umidDocHash: "d", sig: "s", nodes: { n: { vote: true } },
    });
    db.put({ _id: `${umid}:umid`, umid: { $revs: { $i: {}, $o: {} } }, streams: { new: [], updated: [] } });
  };

  beforeEach(async () => {
    db = new Mem();
    events = new Mem();
    state = { retired: false, banned: false, registered: true };
    feeds = new Set();
    forwarded = [];
    serverConns = [];
    upstreams = [];
    const api = new HybridApi({
      db: db as any,
      events: events as any,
      registry: {
        lookup: async (h) => (state.registered && h === hybridHash ? { key: hybrid.publicPem, type: "rsa", endpoints: [], retired: state.retired } : undefined),
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
      maxFeeds: () => 5,
      forward: async (tx, relayer) => (forwarded.push({ tx, relayer }), { $summary: { commit: 1 } }),
    });
    server.on("connection", (c: P2PConnection) => serverConns.push(c));
  });
  afterEach(async () => {
    for (const u of upstreams) u.close();
    await server.close();
  });

  const upstream = (o: Partial<P2PUpstreamOptions> = {}, port = server.port) => {
    const u = new P2PUpstream({ host: "127.0.0.1", port, identity: hybrid, expectedPeerKey: supernode.publicKey, ...o });
    upstreams.push(u);
    return u;
  };

  describe("requests", () => {
    it("round-trips every request channel", async () => {
      db.put(setupFor(supernode.publicKey)).put({ _id: "a", _rev: "1-x" }).put({ _id: "a:stream", _rev: "1-y" });
      db.put({ _id: "u1:umid", umid: {} });
      events.put({ _id: "attest:u1", node: "n", umid: "u1", sig: "s", nodes: {} });
      const u = upstream({ network: () => NETWORK });
      const b = await u.bootstrap();
      expect(b.setup._id).to.equal("setup");
      expect(b.required).to.deep.equal([]);
      expect(b.cursor).to.be.a("string");
      const h = await u.head();
      expect(h.cursor).to.be.a("string");
      expect(h.time).to.be.a("number");
      const s = await u.streams([{ id: "a" }, { id: "nope" }]);
      expect(s.docs.map((d: any) => d._id)).to.deep.equal(["a", "a:stream"]);
      expect(s.missing.map((m: any) => m.id)).to.deep.equal(["nope"]);
      expect(await u.umid("u1")).to.include({ _id: "u1:umid" });
      expect(await u.umid("missing")).to.equal(undefined);
      expect(await u.attest("u1")).to.include({ node: "n" });
      expect(await u.peers()).to.deep.equal([]);
      expect(await u.submit({ $tx: { x: 1 } })).to.deep.equal({ $summary: { commit: 1 } });
      expect(forwarded).to.deep.equal([{ tx: { $tx: { x: 1 } }, relayer: hybridHash }]);
      // All of it on one connection
      expect(serverConns.length).to.equal(1);
    });

    it("maps an error the supernode answers with to kind http", async () => {
      const e = await failure(upstream().streams([{ bad: 1 } as any]));
      expect(e).to.be.instanceOf(UpstreamError);
      expect(e.kind).to.equal("http");
      expect(e.message).to.match(/expected \[\{id, rev\?\}\]/);
    });

    it("two concurrent calls share one connection attempt", async () => {
      const u = upstream();
      await Promise.all([u.head(), u.peers(), u.head()]);
      expect(serverConns.length).to.equal(1);
    });

    it("re-dials transparently after the supernode closes the connection", async () => {
      const u = upstream();
      await u.head();
      serverConns[0].drop("test");
      await wait(50);
      expect((await u.head()).cursor).to.be.a("string");
      expect(serverConns.length).to.equal(2);
    });

    it("a request in flight when the connection drops fails with kind network", async () => {
      const u = upstream();
      await u.head();
      const pending = u.umid("u1");
      serverConns[0].drop("test");
      const e = await pending.then(() => undefined, (x) => x);
      // Either the drop or the answer won the race; a lost connection is network
      if (e !== undefined) expect(e.kind).to.equal("network");
    });

    it("an unreachable supernode is network and undelivered", async () => {
      const port = server.port;
      await server.close();
      const e = await failure(upstream({}, port).head());
      expect(e.kind).to.equal("network");
      expect(e.undelivered).to.equal(true);
    });

    it("an unregistered key is refused at the handshake with a clear error", async () => {
      state.registered = false;
      const e = await failure(upstream().head());
      expect(e).to.be.instanceOf(UpstreamError);
      expect(e.kind).to.equal("network");
      expect(e.undelivered).to.equal(true);
      expect(e.message).to.match(/not registered, or is banned or retired/);
    });

    it("a key banned while connected loses the connection", async () => {
      const u = upstream();
      await u.head();
      state.banned = true;
      const e = await failure(u.head());
      expect(e.kind).to.be.oneOf(["network", "refused"]);
      expect(serverConns[0].closed).to.equal(true);
    });

    it("needs expectedPeerKey or network", () => {
      expect(() => new P2PUpstream({ host: "127.0.0.1", port: 1, identity: hybrid })).to.throw(/expectedPeerKey or network/);
    });
  });

  describe("supernode authentication", () => {
    it("accepts the pinned key", async () => {
      expect((await upstream().head()).cursor).to.be.a("string");
    });

    it("refuses a key other than the pinned one, before any request", async () => {
      const e = await failure(upstream({ expectedPeerKey: p2pIdentity().publicKey }).head());
      expect(e).to.be.instanceOf(UpstreamError);
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.match(/not the expected key/);
      expect(e.undelivered).to.equal(true);
      expect(serverConns.length).to.equal(0);
    });

    it("without a pin, only bootstrap may run until it has checked the key", async () => {
      db.put(setupFor(supernode.publicKey));
      const u = upstream({ expectedPeerKey: undefined, network: () => NETWORK });
      const e = await failure(u.head());
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.match(/bootstrap\(\) must check it first/);
      expect(serverConns.length).to.equal(0);
      const fe = await failure(u.feed("", async () => undefined, new AbortController().signal));
      expect(fe.kind).to.equal("protocol");

      await u.bootstrap();
      expect((await u.head()).cursor).to.be.a("string");
      // A re-dial is checked against the setup stream's nodes, and passes
      serverConns[0].drop("test");
      await wait(50);
      expect((await u.head()).cursor).to.be.a("string");
    });

    it("bootstrap refuses a supernode whose key is not a node of the setup stream", async () => {
      db.put(setupFor(p2pIdentity().publicKey));
      const u = upstream({ expectedPeerKey: undefined, network: () => NETWORK });
      const e = await failure(u.bootstrap());
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.match(/not a node of the setup stream/);
      await wait(50);
      expect(serverConns[0].closed).to.equal(true);
      // Still unverified
      expect((await failure(u.head())).kind).to.equal("protocol");
    });

    it("bootstrap refuses when the setup stream lists no node keys", async () => {
      const u = upstream({ expectedPeerKey: undefined, network: () => NETWORK });
      const e = await failure(u.bootstrap());
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.match(/lists no node keys/);
    });

    it("bootstrap with a pin also checks the setup stream when there is one", async () => {
      db.put(setupFor(p2pIdentity().publicKey));
      const e = await failure(upstream({ network: () => NETWORK }).bootstrap());
      expect(e.kind).to.equal("protocol");
      db.put(setupFor(supernode.publicKey));
      expect((await upstream({ network: () => NETWORK }).bootstrap()).setup._id).to.equal("setup");
    });

    it("a pinned upstream bootstraps a supernode with no setup yet", async () => {
      const b = await upstream({ network: () => NETWORK }).bootstrap();
      expect(b.setup).to.equal(undefined);
    });
  });

  describe("malformed responses", () => {
    let fake: P2PServer;
    let replies: { [channel: string]: any };
    beforeEach(async () => {
      replies = {};
      fake = await P2PServer.listen({ port: 0, host: "127.0.0.1", identity: supernode, isKnownPeer: () => true });
      for (const ch of ["bootstrap", "head", "streams", "peers", "feed"]) fake.handle(ch, () => replies[ch]);
    });
    afterEach(() => fake.close());

    it("are kind protocol", async () => {
      Object.assign(replies, { bootstrap: { contracts: "x", cursor: "" }, head: { cursor: 1, time: 1 }, streams: { docs: [] }, peers: {} });
      const u = upstream({}, fake.port);
      for (const p of [u.bootstrap(), u.head(), u.streams([{ id: "a" }]), u.peers()]) {
        const e = await failure(p);
        expect(e).to.be.instanceOf(UpstreamError);
        expect(e.kind).to.equal("protocol");
      }
    });

    it("a feed answer other than {ok} is kind protocol", async () => {
      replies.feed = { nope: true };
      const e = await failure(upstream({}, fake.port).feed("", async () => undefined, new AbortController().signal));
      expect(e.kind).to.equal("protocol");
    });

    it("a malformed feed push is kind protocol", async () => {
      fake.handle("feed", async (_p: any, conn: P2PConnection) => {
        await conn.push("feed", { type: "item", item: {} });
        return { ok: true };
      });
      const got: any[] = [];
      const e = await failure(upstream({}, fake.port).feed("", async (c) => void got.push(c), new AbortController().signal));
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.match(/malformed item/);
      expect(got).to.deep.equal([]);
    });

    it("a request with no answer is kind timeout", async () => {
      fake.handle("head", () => new Promise(() => undefined));
      const e = await failure(upstream({ timeoutMs: 100 }, fake.port).head());
      expect(e.kind).to.equal("timeout");
    });
  });

  describe("feed", () => {
    it("delivers items in order, awaiting each, with heartbeats in arrival order", async () => {
      addItem(1); addItem(2); addItem(3);
      const u = upstream();
      const ac = new AbortController();
      const seen: string[] = [];
      let active = 0, maxActive = 0;
      const done = u.feed(
        "",
        async (cursor, item) => {
          active++;
          maxActive = Math.max(maxActive, active);
          seen.push(`item ${cursor} ${(item as any).umid}`);
          await wait(cursor.endsWith("u1") ? 150 : 20);
          active--;
          if (seen.filter((s) => s.startsWith("item")).length === 3) ac.abort();
        },
        ac.signal,
        (head) => void seen.push(`beat ${head}`)
      );
      await done;
      expect(maxActive).to.equal(1);
      expect(seen.filter((s) => s.startsWith("item"))).to.deep.equal([
        "item umid:1001,u1 u1", "item umid:1002,u2 u2", "item umid:1003,u3 u3",
      ]);
      // The first heartbeat comes before any item, as the supernode sent it
      expect(seen[0]).to.match(/^beat /);
    });

    it("resolves on abort, only once the running onItem has returned", async () => {
      addItem(1);
      const ac = new AbortController();
      let finished = false;
      const p = upstream().feed("", async () => {
        ac.abort();
        await wait(100);
        finished = true;
      }, ac.signal);
      await p;
      expect(finished).to.equal(true);
      // Closing the feed's connection ends the supernode's session
      await wait(50);
      expect(feeds.size).to.equal(0);
    });

    it("resolves at once when already aborted", async () => {
      const ac = new AbortController();
      ac.abort();
      await upstream().feed("", async () => undefined, ac.signal);
      expect(serverConns.length).to.equal(0);
    });

    it("rejects with the error onItem throws, and delivers nothing after it", async () => {
      addItem(1); addItem(2);
      const got: string[] = [];
      const boom = new Error("boom");
      const e = await failure(upstream().feed("", async (c) => {
        got.push(c);
        throw boom;
      }, new AbortController().signal));
      expect(e).to.equal(boom);
      await wait(100);
      expect(got.length).to.equal(1);
    });

    it("an idle feed rejects with kind timeout", async () => {
      const e = await failure(upstream({ idleTimeoutMs: 200 }).feed("", async () => undefined, new AbortController().signal));
      expect(e.kind).to.equal("timeout");
    });

    it("the supernode dropping the connection rejects with kind network", async () => {
      const u = upstream();
      let beat!: () => void;
      const beaten = new Promise<void>((r) => (beat = r));
      const p = u.feed("", async () => undefined, new AbortController().signal, () => beat());
      await beaten;
      serverConns[serverConns.length - 1].drop("test");
      const e = await failure(p);
      expect(e.kind).to.equal("network");
    });

    it("a key banned while feeding gets kind refused", async () => {
      const realNow = Date.now;
      let offset = 0;
      // The feed session reads the clock it was given; jump it to the next heartbeat
      Date.now = () => realNow() + offset;
      try {
        const u = upstream();
        let beat!: () => void;
        const beaten = new Promise<void>((r) => (beat = r));
        const p = u.feed("", async () => undefined, new AbortController().signal, () => beat());
        await beaten;
        state.banned = true;
        offset = 11_000;
        const e = await failure(p);
        expect(e).to.be.instanceOf(UpstreamError);
        expect(e.kind).to.equal("refused");
        expect(e.refused).to.equal(true);
      } finally {
        Date.now = realNow;
      }
    });

    it("a later feed never receives an earlier feed's pushes, nor the reverse", async () => {
      addItem(1);
      const u = upstream();
      const first: string[] = [];
      const ac1 = new AbortController();
      await u.feed("", async (c) => {
        first.push(c);
        ac1.abort();
      }, ac1.signal);
      addItem(2);
      const second: string[] = [];
      const ac2 = new AbortController();
      await u.feed("umid:1001,u1", async (c) => {
        second.push(c);
        ac2.abort();
      }, ac2.signal);
      await wait(700);
      expect(first).to.deep.equal(["umid:1001,u1"]);
      expect(second).to.deep.equal(["umid:1002,u2"]);
      expect(feeds.size).to.equal(0);
    });

    it("close() ends a running feed", async () => {
      const u = upstream();
      let beat!: () => void;
      const beaten = new Promise<void>((r) => (beat = r));
      const p = u.feed("", async () => undefined, new AbortController().signal, () => beat());
      await beaten;
      u.close();
      expect((await failure(p)).kind).to.equal("network");
    });
  });
});
