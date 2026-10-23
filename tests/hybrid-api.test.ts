import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import { HybridApi, HybridDb, RegisteredHybrid, recordFailed } from "../packages/network/src/network/hybridApi";

// An in-memory store with the allDocs range rules of LevelMe: startkey
// inclusive, endkey exclusive, ordered by key.
class MemDb implements HybridDb {
  docs = new Map<string, any>();
  put(doc: any) {
    this.docs.set(doc._id, doc);
    return this;
  }
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? { ...d } : { notFound: true };
  }
  async allDocs(o: any) {
    // Mirror prepareAllDocs: the endkey's last character becomes a high one
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()]
      .sort()
      .filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    const rows = keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k, ...(o.include_docs ? { doc: this.docs.get(k) } : {}) }));
    return { rows };
  }
}

const kp = new ActiveCrypto.KeyPair("rsa");
const pem = kp.generate().pub.pkcs8pem;
const keyHash = ActiveCrypto.keyHash(pem);

const make = (over: Partial<RegisteredHybrid> | null = {}, banned: string[] = []) => {
  const db = new MemDb();
  const events = new MemDb();
  const registered: RegisteredHybrid | undefined =
    over === null ? undefined : { key: pem, type: "rsa", endpoints: [], ...over };
  const api = new HybridApi({
    db,
    events,
    registry: {
      lookup: async (h) => (h === keyHash ? registered : undefined),
      list: async () => (registered ? [{ ...registered, keyHash }] : []),
    },
    ledgerConfig: () => ({ required: ["req1", { id: "vol1", volatile: true }], window: { days: 30 }, minVersion: "5.1.0" }),
    setupStreamId: () => "setup",
    banned: () => new Set(banned),
  });
  return { api, db, events };
};

const signed = (when = Date.now()) => {
  const r = ActiveCrypto.signRequest(kp, keyHash, when);
  return { key: r.key, timestamp: String(r.timestamp), signature: r.signature };
};

describe("HybridApi", () => {
  describe("authenticate", () => {
    it("accepts a registered key with a fresh signature", async () => {
      const r = await make().api.authenticate(signed());
      expect(r.ok).to.equal(true);
    });

    it("accepts a signature once and refuses its replay", async () => {
      const { api } = make();
      const headers = signed();
      expect((await api.authenticate(headers)).ok).to.equal(true);
      const again: any = await api.authenticate(headers);
      expect(again.ok).to.equal(false);
      expect(again.reason).to.match(/replayed/);
      // The same request signed again for the same instant is a replay too
      const sameInstant = signed(Number(headers.timestamp));
      expect(((await api.authenticate(sameInstant)) as any).reason).to.match(/replayed/);
      // A fresh signature is fine
      expect((await api.authenticate(signed(Date.now() + 1))).ok).to.equal(true);
    });

    it("refuses each failure with its own status", async () => {
      const cases: [any, number, RegExp][] = [
        [{}, 401, /missing/],
        [signed(), 403, /not registered/],
        [signed(Date.now() - 600000), 401, /bad signature or timestamp/],
        [{ ...signed(), signature: "zz" }, 401, /bad signature/],
      ];
      for (const [headers, status, reason] of cases) {
        const { api } = make(headers === cases[1][0] ? null : {});
        const r: any = await api.authenticate(headers);
        expect(r.ok).to.equal(false);
        expect(r.status).to.equal(status);
        expect(r.reason).to.match(reason);
      }
      const retired: any = await make({ retired: true }).api.authenticate(signed());
      expect(retired.reason).to.match(/retired/);
      const banned: any = await make({}, [keyHash]).api.authenticate(signed());
      expect(banned.status).to.equal(403);
      expect(banned.reason).to.match(/banned/);
    });
  });

  describe("streams", () => {
    it("returns state and meta, and reports a wrong or missing revision", async () => {
      const { api, db } = make();
      db.put({ _id: "a", _rev: "2-x" }).put({ _id: "a:stream", _rev: "1-y", authorities: [] });
      const r = await api.streams([{ id: "a", rev: "2-x" }, { id: "a", rev: "9-z" }, { id: "nope" }]);
      expect(r.docs.map((d) => d._id)).to.deep.equal(["a", "a:stream"]);
      expect(r.missing).to.deep.equal([{ id: "a", rev: "9-z" }, { id: "nope" }]);
    });

    it("refuses ids that name another document of the stream or an internal one", async () => {
      const { api, db } = make();
      db.put({ _id: "vol1", _rev: "1-a" }).put({ _id: "vol1:volatile", v: 1, _rev: "1-b" });
      db.put({ _id: "_design/x", _rev: "1-c" }).put({ _id: "u1:umid", _rev: "1-d" });
      const ids = ["vol1:volatile", "vol1:stream", "u1:umid", "_design/x", "", "a".repeat(129), "x/y"];
      const r = await api.streams(ids.map((id) => ({ id })));
      expect(r.docs).to.deep.equal([]);
      expect(r.missing).to.have.length(ids.length);
      expect(await api.umid("vol1:volatile")).to.equal(undefined);
      expect(await api.attest("../x")).to.equal(undefined);
    });

    it("serves volatile only when required-volatile AND volatileShared", async () => {
      const { api, db } = make();
      db.put({ _id: "vol1", _rev: "1-a" }).put({ _id: "vol1:volatile", v: 1 });
      db.put({ _id: "req1", _rev: "1-a" }).put({ _id: "req1:stream", volatileShared: true }).put({ _id: "req1:volatile", v: 2 });

      // Listed required-volatile, but meta does not share it
      db.put({ _id: "vol1:stream", volatileShared: false });
      expect((await api.streams([{ id: "vol1" }])).docs.map((d) => d._id)).to.not.include("vol1:volatile");

      // Shared in meta, but not listed required-volatile
      expect((await api.streams([{ id: "req1" }])).docs.map((d) => d._id)).to.not.include("req1:volatile");

      // Both
      db.put({ _id: "vol1:stream", volatileShared: true });
      expect((await api.streams([{ id: "vol1" }])).docs.map((d) => d._id)).to.include("vol1:volatile");
    });
  });

  describe("feed", () => {
    const seed = (events: MemDb, db: MemDb) => {
      // Two commits and a failure, interleaved in time
      for (const [ms, umid] of [[1000, "u1"], [3000, "u3"]] as const) {
        events.put({ _id: `umid:${ms},${umid}` });
        events.put({ _id: `attest:${umid}`, node: "n1", umid, outcome: "committed", revsOut: { s: { rev: "1-a", sha256: "h" } }, umidDocHash: "d", sig: "sg", nodes: { n1: { vote: true, sig: "v" } } });
        db.put({ _id: `${umid}:umid`, umid: { $revs: { $i: {}, $o: { s: "1-a" } } }, streams: { new: [], updated: [] } });
      }
      events.put({ _id: "fail:2000,u2" });
      events.put({ _id: "failed:u2", tx: { $tx: 1 }, $revs: { $i: {}, $o: {} }, nodes: { n1: { vote: true } } });
    };

    it("orders committed and failed items by time under one cursor", async () => {
      const { api, db, events } = make();
      seed(events, db);
      const items = await api.feedSince("");
      expect(items.map((i) => i.item.umid)).to.deep.equal(["u1", "u2", "u3"]);
      expect(items.map((i) => i.item.outcome)).to.deep.equal(["committed", "failed", "committed"]);
      expect(items[1].item.tx).to.deep.equal({ $tx: 1 });
    });

    it("resumes strictly after a cursor of either kind", async () => {
      const { api, db, events } = make();
      seed(events, db);
      expect((await api.feedSince("umid:1000,u1")).map((i) => i.item.umid)).to.deep.equal(["u2", "u3"]);
      expect((await api.feedSince("fail:2000,u2")).map((i) => i.item.umid)).to.deep.equal(["u3"]);
      expect(await api.feedSince("umid:3000,u3")).to.deep.equal([]);
    });

    it("carries the umid doc, tally and attestation of a committed item", async () => {
      const { api, db, events } = make();
      seed(events, db);
      const [first] = await api.feedSince("", 1);
      expect(first.cursor).to.equal("umid:1000,u1");
      expect(first.item.nodes).to.deep.equal({ n1: { vote: true, sig: "v" } });
      expect(first.item.attestation).to.include({ node: "n1", umidDocHash: "d", sig: "sg" });
      expect(first.item.$revs.$o).to.deep.equal({ s: "1-a" });
    });

    it("stops at an item whose documents are not written yet", async () => {
      const { api, db, events } = make();
      seed(events, db);
      events.docs.delete("attest:u3");
      expect((await api.feedSince("")).map((i) => i.item.umid)).to.deep.equal(["u1", "u2"]);
    });

    it("honours the limit", async () => {
      const { api, db, events } = make();
      seed(events, db);
      expect(await api.feedSince("", 2)).to.have.length(2);
    });

    it("finds the head by widening the window", async () => {
      const { api, db, events } = make();
      seed(events, db);
      expect(await api.head(5000)).to.equal("umid:3000,u3");
      events.put({ _id: "fail:4000,u4" });
      expect(await api.head(5000)).to.equal("fail:4000,u4");
      expect(await make().api.head()).to.equal("");
    });
  });

  describe("attest / umid / peers / bootstrap", () => {
    it("serves an attestation without the internal fields or the tally", async () => {
      const { api, events } = make();
      events.put({ _id: "attest:u1", _rev: "1-a", node: "n", umid: "u1", sig: "s", nodes: { n: { vote: true } } });
      expect(await api.attest("u1")).to.deep.equal({ node: "n", umid: "u1", sig: "s" });
      expect(await api.attest("nope")).to.equal(undefined);
    });

    it("lists only non-retired hybrids", async () => {
      expect(await make({ retired: true }).api.peers()).to.deep.equal([]);
      const peers = await make({ label: "x" }).api.peers();
      expect(peers[0]).to.include({ keyHash, label: "x" });
    });

    it("bootstraps with setup, required, contracts and the cursor", async () => {
      const { api, db, events } = make();
      db.put({ _id: "setup", network: true });
      db.put({ _id: "c1", namespace: "ns", contract: {}, compiled: {} });
      db.put({ _id: "plain", x: 1 });
      events.put({ _id: "umid:1000,u1" });
      const b = await api.bootstrap();
      expect(b.setup._id).to.equal("setup");
      expect(b.required).to.have.length(2);
      expect(b.minVersion).to.equal("5.1.0");
      expect(b.contracts).to.deep.equal(["c1"]);
      expect(b.cursor).to.equal("umid:1000,u1");
    });
  });
});

describe("recordFailed", () => {
  const entry = (nodes: any): any => ({
    $umid: "u9",
    $tx: { $contract: "c" },
    $sigs: {},
    $datetime: new Date(5000).toISOString(),
    $revs: { $i: {}, $o: {} },
    $nodes: nodes,
  });
  const store = (committed = false) => {
    const events = new MemDb();
    const posts: any[] = [];
    return {
      posts,
      events: { post: async (d: any) => (posts.push(d), events.put(d), {}) },
      db: { exists: async () => committed },
    };
  };

  it("keeps a failure with a true vote under the fail index", async () => {
    const s = store();
    const ok = await recordFailed(s.events, s.db, entry({ a: { vote: true, sig: "x" }, b: { vote: false } }), 40300);
    expect(ok).to.equal(true);
    expect(s.posts.map((p) => p._id)).to.deep.equal(["failed:u9", "fail:5000,u9"]);
    expect(s.posts[0].nodes).to.deep.equal({ a: { vote: true, sig: "x" }, b: { vote: false } });
    expect(s.posts[0].tx.$tx).to.deep.equal({ $contract: "c" });
  });

  it("keeps nothing for no true vote, below the build, or a committed umid", async () => {
    const none = store();
    expect(await recordFailed(none.events, none.db, entry({ a: { vote: false } }), 40300)).to.equal(false);
    const old = store();
    expect(await recordFailed(old.events, old.db, entry({ a: { vote: true } }), 40299)).to.equal(false);
    const done = store(true);
    expect(await recordFailed(done.events, done.db, entry({ a: { vote: true } }), 40300)).to.equal(false);
    expect([...none.posts, ...old.posts, ...done.posts]).to.deep.equal([]);
  });

  it("never throws when the events database does", async () => {
    const s = store();
    const bad = { post: async () => { throw new Error("down"); } };
    expect(await recordFailed(bad, s.db, entry({ a: { vote: true } }), 40300)).to.equal(false);
  });
});
