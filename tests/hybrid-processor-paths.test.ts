import { expect } from "chai";
import "mocha";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { docHash, verifyContext } from "../packages/hybrid/src/verify";
import { Processor } from "../packages/hybrid/src/processor";
import { ItemOrderer } from "../packages/hybrid/src/orderer";
import { SourceLookup } from "../packages/hybrid/src/lookup";
import { listDivergences } from "../packages/hybrid/src/divergence";

// Processing a feed item (hybrid design, section 2): verify, prepare inputs,
// committed (match / adopt / SPI repair), failed, failure handling, ordering.

const NETWORK = "setup-stream-id";
const nodes = Array.from({ length: 4 }, (_, i) => {
  const keys = new ActiveCrypto.KeyPair("rsa").generate();
  const host = `10.0.0.${i + 1}`;
  return {
    host,
    port: 5260,
    pair: new ActiveCrypto.KeyPair("rsa", keys.prv.pkcs8pem),
    public: keys.pub.pkcs8pem,
    ref: ActiveCrypto.Hash.getHash(host + 5260 + NETWORK, "sha1"),
  };
});
// 60% of 4: three yes votes, three matching attestations
const setupDoc = {
  _id: NETWORK,
  consensus: { reached: 60 },
  neighbourhood: nodes.map((n) => ({ host: n.host, port: n.port, identity: { type: "rsa", public: n.public } })),
};
const ctx = verifyContext(setupDoc, NETWORK);

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
/** The document LevelMe stores for a write at `pos` (new_edits:true) */
const stored = (doc: any, pos: number) => ({ ...doc, _rev: `${pos}-${md5(JSON.stringify({ ...doc, _rev: null }))}` });
const clone = (v: any) => JSON.parse(JSON.stringify(v));

const S = "s1";
const BEFORE_STATE = { _id: S, _rev: "1-aaa", balance: 1 };
const BEFORE_META = { _id: `${S}:stream`, _rev: "1-mmm", umid: "earlier", name: "s" };
const REVS = { $i: { [S]: "1-mmm:1-aaa" }, $o: {} };

/** What a local execution writes (pre-store _rev, as the dry run returns it) */
const localDocs = (umid: string, balance: number) => ({
  [S]: { ...BEFORE_STATE, balance },
  [`${S}:stream`]: { ...BEFORE_META, umid },
});
/** The documents the supernodes stored for that execution */
const signedDocs = (umid: string, balance: number) => ({
  [S]: stored(localDocs(umid, balance)[S], 2),
  [`${S}:stream`]: stored(localDocs(umid, balance)[`${S}:stream`], 2),
});
const revsOutOf = (docs: any) => {
  const out: any = {};
  for (const id of Object.keys(docs)) out[id] = { rev: docs[id]._rev, sha256: docHash(docs[id]) };
  return out;
};

let seq = 0;
const umidDocFor = (umid: string, revs: any = REVS) => ({
  _id: `${umid}:umid`,
  _rev: "1-0123456789abcdef0123456789abcdef",
  umid: {
    $umid: umid,
    $tx: { $namespace: "default", $contract: "pay", $entry: "run", $i: { [S]: {} }, $o: {} },
    $sigs: {},
    $revs: revs,
    $selfsign: false,
    $datetime: "2026-10-23T10:00:00.000Z",
    $origin: "n1",
    $remoteAddr: "127.0.0.1",
  },
  streams: { new: [], updated: [{ id: S, prev: "earlier" }] },
  events: [{ name: "paid", data: { to: "bob" }, phase: "commit", contract: "pay" }],
});

const attest = (n: (typeof nodes)[number], item: any) => {
  const a: any = {
    node: n.ref,
    umid: item.umid,
    outcome: "committed",
    revsOut: item.revsOut,
    umidDocHash: docHash(item.umidDoc),
  };
  a.sig = ActiveCrypto.signDigest(n.pair, ActiveCrypto.commitDigest(a.umid, a.outcome, item.$revs, a.revsOut, a.umidDocHash));
  return a;
};

const votes = (umid: string, revs: any, yes: number, no = 0) => {
  const out: any = {};
  nodes.slice(0, yes).forEach((n) => {
    out[n.ref] = { vote: true, sig: ActiveCrypto.signDigest(n.pair, ActiveCrypto.voteDigest(umid, true, revs)) };
  });
  nodes.slice(yes, yes + no).forEach((n) => {
    out[n.ref] = { vote: false, sig: ActiveCrypto.signDigest(n.pair, ActiveCrypto.voteDigest(umid, false, revs)) };
  });
  return out;
};

/** A committed item whose attested outputs are signedDocs(umid, balance) */
const committedItem = (balance = 2, opts: { quorum?: boolean } = {}) => {
  const umid = `u${++seq}`;
  const signed = signedDocs(umid, balance);
  const item: any = {
    umid,
    outcome: "committed",
    umidDoc: umidDocFor(umid),
    $revs: REVS,
    revsOut: revsOutOf(signed),
    streams: { new: [], updated: [] },
    nodes: votes(umid, REVS, 3),
  };
  item.attestation = attest(nodes[0], item);
  if (opts.quorum) item.attestations = [attest(nodes[1], item), attest(nodes[2], item)];
  return { item, signed, umid };
};

const failedItem = (yes = 1, no = 2) => {
  const umid = `f${++seq}`;
  const tx = clone(umidDocFor(umid).umid);
  delete tx.$revs;
  return { umid, item: { umid, outcome: "failed", tx, $revs: REVS, nodes: votes(umid, REVS, yes, no) } as any };
};

/** An upstream serving documents as POST /h/streams does */
class FakeUpstream {
  public calls: { [m: string]: number } = {};
  public docs = new Map<string, any>();
  public attestations = new Map<string, any>();
  public umids = new Map<string, any>();
  public down = false;
  constructor(public id: string, docs: any[] = []) {
    for (const d of docs) this.docs.set(d._id, clone(d));
  }
  private hit(m: string) {
    this.calls[m] = (this.calls[m] ?? 0) + 1;
    if (this.down) throw new Error(`${this.id} down`);
  }
  async streams(reqs: { id: string; rev?: string }[]) {
    this.hit("streams");
    const docs: any[] = [];
    const missing: any[] = [];
    for (const r of reqs) {
      const s = this.docs.get(r.id);
      if (!s || (r.rev && s._rev !== r.rev)) {
        missing.push(r);
        continue;
      }
      docs.push(clone(s));
      const m = this.docs.get(`${r.id}:stream`);
      if (m) docs.push(clone(m));
    }
    return { docs, missing };
  }
  async attest(umid: string) {
    this.hit("attest");
    return this.attestations.get(umid);
  }
  async umid(umid: string) {
    this.hit("umid");
    return this.umids.get(umid);
  }
  async bootstrap(): Promise<any> {
    throw new Error("unused");
  }
  async head(): Promise<any> {
    throw new Error("unused");
  }
  async feed(): Promise<void> {}
  async peers() {
    return [];
  }
  async submit() {
    return {};
  }
}

const result = (over: any = {}) => ({
  umid: "x",
  vote: true,
  committed: true,
  documents: {},
  volatile: {},
  events: [],
  supernodeDependent: false,
  dependence: [],
  adopt: [],
  ...over,
});

describe("Hybrid processor - paths a mutation pass found unchecked", function () {
  this.timeout(20000);
  let dir: string;
  let store: IEmbeddedStorage;
  let peers: FakeUpstream[];
  let supernodes: FakeUpstream[];
  let events: any[];
  let execute: (entry: any) => Promise<any>;
  let executions: any[];
  let processor: Processor;
  const from = () => supernodes[0] as any;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-processor-"));
    store = await openEmbeddedStorage(dir);
    await store.data.bulkDocs([clone(BEFORE_STATE), clone(BEFORE_META)], { new_edits: false });
    peers = [];
    supernodes = [new FakeUpstream("sn1")];
    events = [];
    executions = [];
    execute = async () => result();
    const sources = () => ({ peers: peers as any[], supernodes: supernodes as any[] });
    processor = new Processor({
      store: store as any,
      sources,
      lookup: new SourceLookup({ store: store as any, sources }),
      events: { emit: async (e) => void events.push(e) },
      context: () => ctx,
      contracts: null,
      execute: async (entry: any) => {
        executions.push(entry);
        return execute(entry);
      },
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = async (id: string) => {
    const d = await store.data.get(id);
    return d && d._id ? d : undefined;
  };


  // ---- builders for items the shared ones cannot make -------------------------
  const build = (opts: { revs?: any; docs?: any; events?: any; umid?: string } = {}) => {
    const umid = opts.umid ?? `p${++seq}`;
    const revs = opts.revs ?? REVS;
    const signed = opts.docs ?? signedDocs(umid, 2);
    const umidDoc: any = umidDocFor(umid, revs);
    if ("events" in opts) umidDoc.events = opts.events;
    const item: any = {
      umid,
      outcome: "committed",
      umidDoc,
      $revs: revs,
      revsOut: revsOutOf(signed),
      streams: { new: [], updated: [] },
      nodes: votes(umid, revs, 3),
    };
    item.attestation = attest(nodes[0], item);
    return { item, signed, umid };
  };

  describe("not bootstrapped", () => {
    it("drops the item without touching anything when there is no verification context yet", async () => {
      const lonely = new Processor({
        store: store as any,
        sources: { peers: [], supernodes: [] },
        lookup: {} as any,
        events: { emit: async () => undefined },
        context: () => undefined,
        contracts: null,
      });
      const { item } = build();
      const out = await lonely.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.vote).to.equal("no");
      expect(out.reasons).to.deep.equal(["not bootstrapped"]);
      expect(out.retry).to.equal(undefined);
    });

    it("exposes the contract builder it was given, or none", () => {
      expect(processor.contractBuilder).to.equal(null);
      const given: any = { onWritten: async () => undefined };
      const withBuilder = new Processor({
        store: store as any,
        sources: { peers: [], supernodes: [] },
        lookup: {} as any,
        events: { emit: async () => undefined },
        context: () => ctx,
        contracts: given,
      });
      expect(withBuilder.contractBuilder).to.equal(given);
    });
  });

  describe("committed - what is already here", () => {
    it("settles as superseded when the streams have already moved past the item", async () => {
      const { item, umid } = build();
      await store.data.bulkDocs(
        [{ _id: S, _rev: "3-aaaa1111", balance: 9 }, { _id: `${S}:stream`, _rev: "3-bbbb2222", umid: "later", name: "s" }],
        { new_edits: false, force_rev: undefined } as any
      ).catch(() => undefined);
      // put them at a later revision whatever the store does with the write mode
      for (const d of [{ _id: S, _rev: "3-aaaa1111", balance: 9 }, { _id: `${S}:stream`, _rev: "3-bbbb2222", umid: "later", name: "s" }]) {
        const held = await get(d._id);
        await store.data.bulkDocs([d], held ? { new_edits: true, force_rev: d._rev } : { new_edits: false });
      }
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("settled");
      expect(out.vote).to.equal("no");
      expect(out.reasons.join()).to.contain("superseded");
      expect(executions).to.have.length(0);
      expect(await get(`${umid}:umid`)).to.equal(undefined);
    });

    it("does not call a different revision at the same position progress (a fork) and asks to retry", async () => {
      const { item } = build();
      for (const d of [{ _id: S, _rev: "2-ffff0000", balance: 9 }, { _id: `${S}:stream`, _rev: "2-ffff1111", umid: "fork", name: "s" }]) {
        const held = await get(d._id);
        await store.data.bulkDocs([d], held ? { new_edits: true, force_rev: d._rev } : { new_edits: false });
      }
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.retry).to.equal(true);
      expect(out.reasons.join()).to.contain("streams not available at $revs");
      expect(executions).to.have.length(0);
    });

    it("keeps waiting, not settling, when an output the item changed is not held at all", async () => {
      const { item } = build();
      await store.data.purge({ _id: S }).catch(() => undefined);
      await store.data.purge({ _id: `${S}:stream` }).catch(() => undefined);
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.retry).to.equal(true);
    });

    it("records a divergence when an output has the attested revision but not the attested content", async () => {
      const { item, signed } = build();
      // the stream sits at the attested revision with different content
      const liar = { ...signed[S], balance: 1234 };
      for (const d of [liar, signed[`${S}:stream`]]) {
        const held = await get(d._id);
        await store.data.bulkDocs([d], held ? { new_edits: true, force_rev: d._rev } : { new_edits: false });
      }
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("settled");
      expect(out.vote).to.equal("no");
      expect(out.reasons.join()).to.contain("content hash differs");
      expect(out.divergence?.kind).to.equal("output-hash-mismatch");
    });
  });

  describe("committed - items with little in them", () => {
    it("runs an item that names no streams at all", async () => {
      const { item, umid } = build({ revs: { $i: {}, $o: {} }, docs: {} });
      execute = async () => result({ documents: {} });
      const out = await processor.apply(item, from());
      expect(executions).to.have.length(1);
      expect(out.action).to.equal("saved");
      expect(await get(`${umid}:umid`)).to.deep.equal(item.umidDoc);
    });

    it("copes with a $revs that has no outputs side", async () => {
      const revs = { $i: { [S]: "1-mmm:1-aaa" } };
      const { item, umid } = build({ revs });
      execute = async () => result({ documents: localDocs(umid, 2) });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("saved");
    });

    it("ignores empty entries in the documents a local run returns", async () => {
      const { item, umid } = build();
      execute = async () => result({ documents: { ...localDocs(umid, 2), ghost: null, hollow: {} } });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("saved");
      expect(out.vote).to.equal("yes");
    });

    it("writes the volatile documents a local run returns, which are per node", async () => {
      const { item, umid } = build();
      const volatile = { _id: `${S}:volatile`, _rev: "1-eeee0000", note: "mine" };
      execute = async () => result({ documents: localDocs(umid, 2), volatile: { [volatile._id]: volatile } });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("saved");
      expect((await get(`${S}:volatile`))?.note).to.equal("mine");
    });

    it("emits the events the local run raised when the received :umid doc carries none", async () => {
      const { item, umid } = build({ events: undefined });
      execute = async () => result({ documents: localDocs(umid, 2), events: [{ name: "local-only", data: { a: 1 }, contract: "pay" }] });
      await processor.apply(item, from());
      expect(events.map((e) => e.type)).to.include("local-only");
    });

    it("prefers the events in the received :umid doc over the local ones", async () => {
      const { item, umid } = build();
      execute = async () => result({ documents: localDocs(umid, 2), events: [{ name: "local-only", data: {} }] });
      await processor.apply(item, from());
      expect(events.map((e) => e.type)).to.include("paid");
      expect(events.map((e) => e.type)).to.not.include("local-only");
    });
  });

  describe("committed - adopting without a declared dependence", () => {
    it("reports an empty dependence when the run named none", async () => {
      const { item, signed, umid } = committedItem(5, { quorum: true });
      supernodes[0].docs = new Map(Object.values(signed).map((d: any) => [d._id, clone(d)]));
      execute = async () => {
        const r: any = result({ documents: localDocs(umid, 2), supernodeDependent: true });
        delete r.dependence;
        delete r.adopt;
        return r;
      };
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("adopted");
      const undeclared = events.find((e) => e.type === "adopt.undeclared");
      expect(undeclared?.payload.dependence).to.deep.equal([]);
      expect(undeclared?.payload.entry).to.equal("run");
    });
  });

  describe("committed - SPI repair that cannot write", () => {
    it("drops the item and says the write failed when the store does not confirm it", async () => {
      const { item, signed, umid } = committedItem(5, { quorum: true });
      peers = [new FakeUpstream("p1", Object.values(signed)), new FakeUpstream("p2", Object.values(signed))];
      execute = async () => result({ documents: localDocs(umid, 2) }); // wrong balance: output mismatch -> repair
      const realBulk = store.data.bulkDocs.bind(store.data);
      (store.data as any).bulkDocs = async (docs: any[], options: any) =>
        docs.some((d) => d._id === S || d._id === `${S}:stream`) && options && (options.new_edits === false || options.force_rev) ? {} : realBulk(docs, options);
      const out = await processor.apply(item, from());
      (store.data as any).bulkDocs = realBulk;
      expect(out.action).to.equal("dropped");
      expect(out.vote).to.equal("no");
      expect(out.reasons.join()).to.contain("SPI could not repair");
    });
  });

  describe("failed items", () => {
    for (const [label, patch] of [
      ["no transaction", { tx: undefined }],
      ["a transaction that is not an object", { tx: "x" }],
      ["a transaction without $tx", { tx: { $umid: "x" } }],
    ] as const) {
      it(`drops a failed item with ${label}`, async () => {
        const { item } = failedItem(1, 2);
        const out = await processor.apply({ ...item, ...patch }, from());
        expect(out.action).to.equal("dropped");
        expect(out.reasons).to.deep.equal(["failed item carries no transaction"]);
        expect(out.retry).to.equal(undefined);
      });
    }

    describe("when its own yes votes reach consensus", () => {
      it("is dropped when another upstream shows the transaction committed", async () => {
        const { item, umid } = failedItem(3, 0);
        const other = new FakeUpstream("sn2");
        other.umids.set(umid, { umid: { $umid: umid } });
        supernodes = [new FakeUpstream("sn1"), other];
        const out = await processor.apply(item, supernodes[0] as any);
        expect(out.action).to.equal("dropped");
        expect(out.reasons.join()).to.contain("sn2 shows it committed");
        expect(executions).to.have.length(0);
      });

      it("never asks the upstream it came from", async () => {
        const { item, umid } = failedItem(3, 0);
        const origin = new FakeUpstream("sn1");
        origin.umids.set(umid, { umid: { $umid: umid } });
        supernodes = [origin];
        const out = await processor.apply(item, { id: "sn1" } as any); // a different object, the same upstream
        expect(origin.calls.umid ?? 0).to.equal(0);
        expect(out.retry).to.equal(true);
      });

      it("asks to retry when no other upstream could confirm it", async () => {
        const { item } = failedItem(3, 0);
        supernodes = [new FakeUpstream("sn1")];
        const out = await processor.apply(item, supernodes[0] as any);
        expect(out.action).to.equal("dropped");
        expect(out.retry).to.equal(true);
        expect(out.reasons).to.deep.equal(["failed item reaches consensus and no other upstream could confirm it"]);
      });

      it("carries on and records it when another upstream does not show it committed", async () => {
        const { item } = failedItem(3, 0);
        supernodes = [new FakeUpstream("sn1"), new FakeUpstream("sn2")];
        execute = async () => result({ vote: false, committed: false });
        const out = await processor.apply(item, supernodes[0] as any);
        expect(out.action).to.equal("recorded");
        expect(executions).to.have.length(1);
      });
    });

    describe("what a local run of a failed item means", () => {
      it("is a divergence only when the run both voted yes and committed", async () => {
        for (const [vote, committed, expectVote] of [
          [true, true, "yes"],
          [true, false, "no"],
          [false, true, "no"],
          [false, false, "no"],
        ] as const) {
          const { item } = failedItem(1, 2);
          execute = async () => result({ vote, committed });
          const out = await processor.apply(item, from());
          expect(out.action, `${vote}/${committed}`).to.equal("recorded");
          expect(out.vote, `${vote}/${committed}`).to.equal(expectVote);
          expect(!!out.divergence, `${vote}/${committed}`).to.equal(vote && committed);
        }
      });
    });
  });

  describe("a contract's data stream that does not exist yet", () => {
    const DATA = "c0ffee:data";
    const withData = (state: string) => ({ $i: { [S]: "1-mmm:1-aaa" }, $o: { [DATA]: state } });

    it("is new, not missing, when every upstream says it has nothing for it", async () => {
      const { item, umid } = build({ revs: withData("0-context:0-context"), docs: signedDocs("x", 2) });
      execute = async () => result({ documents: localDocs(umid, 2) });
      const out = await processor.apply(item, from());
      expect(out.retry, out.reasons.join()).to.equal(undefined);
      expect(executions).to.have.length(1);
    });

    it("is still missing when a concrete revision of it cannot be had", async () => {
      const { item } = build({ revs: withData("2-abcdef12:2-abcdef12"), docs: signedDocs("x", 2) });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.retry).to.equal(true);
      expect(out.reasons.join()).to.contain(DATA);
      expect(executions).to.have.length(0);
    });

    it("is still missing when an upstream cannot answer, because that proves nothing", async () => {
      const { item } = build({ revs: withData("0-context:0-context"), docs: signedDocs("x", 2) });
      supernodes[0].down = true;
      const out = await processor.apply(item, from());
      expect(out.retry).to.equal(true);
      expect(out.reasons.join()).to.contain(DATA);
    });
  });

  describe("an item whose outputs name nothing, with streams it cannot get", () => {
    it("is not taken for being already covered by newer state", async () => {
      const unavailable = { $i: { [S]: "5-eeeeeeee:5-ffffffff" }, $o: {} };
      const { item } = build({ revs: unavailable, docs: {} });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.retry).to.equal(true);
      expect(executions).to.have.length(0);
    });
  });

  describe("what a local run says about itself in a divergence", () => {
    it("reports an empty dependence when the run named none", async () => {
      const { item, umid } = committedItem(5, { quorum: true });
      peers = [new FakeUpstream("p1", Object.values(committedItem(5).signed)), new FakeUpstream("p2")];
      supernodes[0].docs = new Map(Object.values(signedDocs(umid, 5)).map((d: any) => [d._id, clone(d)]));
      execute = async () => {
        const r: any = result({ documents: localDocs(umid, 2) });
        delete r.dependence;
        return r;
      };
      const out = await processor.apply(item, from());
      expect(out.divergence?.localResult.dependence).to.deep.equal([]);
    });
  });

  describe("events without a contract of their own", () => {
    it("are emitted under the transaction's contract", async () => {
      const { item, umid } = build({ events: [{ name: "plain", data: { a: 1 } }] });
      execute = async () => result({ documents: localDocs(umid, 2) });
      await processor.apply(item, from());
      const plain = events.find((e) => e.type === "plain");
      expect(plain?.contract).to.equal("pay");
      expect(plain?.payload).to.deep.equal({ a: 1 });
    });
  });

  describe("SPI across hybrids - who is asked, for what, and in what order", () => {
    const spiOf = (revsOut: any, quorumSigned = false) => (processor as any).spi(revsOut, quorumSigned);

    class Spy extends FakeUpstream {
      public requests: any[][] = [];
      async streams(reqs: { id: string; rev?: string }[]) {
        this.requests.push(clone(reqs));
        return super.streams(reqs);
      }
    }

    it("asks peers for the exact attested revisions and never asks supernodes when the peers settle it", async () => {
      const { signed } = committedItem(5);
      const revsOut = revsOutOf(signed);
      const p1 = new Spy("p1", Object.values(signed));
      const p2 = new Spy("p2", Object.values(signed));
      const sn = new Spy("sn1");
      peers = [p1, p2];
      supernodes = [sn];
      const r = await spiOf(revsOut);
      expect(r.missing).to.deep.equal([]);
      expect(p1.requests[0]).to.deep.equal([{ id: S, rev: revsOut[S].rev }]);
      expect(sn.requests, "the supernodes are not troubled").to.have.length(0);
    });

    it("asks supernodes for the latest, not a pinned revision, when the peers cannot settle it", async () => {
      const { signed } = committedItem(5);
      const revsOut = revsOutOf(signed);
      const sn = [1, 2, 3].map((i) => new Spy(`sn${i}`, Object.values(signed)));
      peers = [];
      supernodes = sn;
      await spiOf(revsOut);
      expect(sn[0].requests[0]).to.deep.equal([{ id: S }]);
    });

    it("sends one request for a stream and its :stream meta", async () => {
      const { signed } = committedItem(5);
      const revsOut = revsOutOf(signed);
      const reqs = (Processor as any).requests(revsOut, true);
      expect(reqs).to.deep.equal([{ id: S, rev: revsOut[S].rev }]);
      const other = { ...revsOut, "t1": { rev: "2-aa", sha256: "x" } };
      expect((Processor as any).requests(other, true).map((r: any) => r.id)).to.deep.equal([S, "t1"]);
    });

    it("indexes only documents that have an id, keeping every version of one id", () => {
      const index = (Processor as any).index([null, { _id: "a", v: 1 }, { _id: 5 }, "x", { _id: "a", v: 2 }]);
      expect([...index.keys()]).to.deep.equal(["a"]);
      expect(index.get("a").map((d: any) => d.v)).to.deep.equal([1, 2]);
      expect((Processor as any).index("nope").size).to.equal(0);
    });

    it("asks for the attested revision when fetching signed outputs", async () => {
      const { signed } = committedItem(5);
      const revsOut = revsOutOf(signed);
      const sn = new Spy("sn1", Object.values(signed));
      supernodes = [sn];
      const r = await (processor as any).fetchSigned(revsOut);
      expect(r.missing).to.deep.equal([]);
      expect(sn.requests[0][0]).to.deep.equal({ id: S, rev: revsOut[S].rev });
    });

    it("repairs the streams that have a winner even when an earlier one has none", async () => {
      const T = "t1";
      const revsOut = {
        [S]: { rev: "2-aaaa0000", sha256: "x" },
        [T]: { rev: "2-bbbb0000", sha256: "y" },
      };
      // S: the three supernodes disagree, no majority. T: all three are ahead of the attested revision
      const ahead = { _id: T, _rev: "3-cccc0000", v: 1 };
      const disagree = [
        { _id: S, _rev: "5-11110000" },
        { _id: S, _rev: "5-22220000" },
        { _id: S, _rev: "5-33330000" },
      ];
      supernodes = disagree.map((d, i) => new FakeUpstream(`sn${i}`, [d, ahead]));
      peers = [];
      const r = await spiOf(revsOut);
      expect(r.docs[T]).to.deep.equal(ahead);
      expect(r.docs[S]).to.equal(undefined);
      expect(r.missing).to.deep.equal([S]);
    });
  });
});
