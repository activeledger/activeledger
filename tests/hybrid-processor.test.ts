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

describe("Hybrid processor", function () {
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

  describe("committed, local result matches", () => {
    it("saves the outputs and the received :umid doc byte-for-byte, and votes yes", async () => {
      const { item, signed, umid } = committedItem(2);
      execute = async () => result({ documents: localDocs(umid, 2) });

      const out = await processor.apply(item, from());
      expect(out.action).to.equal("saved");
      expect(out.vote).to.equal("yes");
      expect(out.divergence).to.equal(undefined);
      expect(await get(S)).to.deep.equal(signed[S]);
      expect(await get(`${S}:stream`)).to.deep.equal(signed[`${S}:stream`]);
      expect(await get(`${umid}:umid`)).to.deep.equal(item.umidDoc);
      expect(executions[0].$umid).to.equal(umid);
      expect(executions[0].$revs).to.deep.equal(REVS);
      expect(events.map((e) => e.type)).to.deep.equal(["paid", "tx.committed"]);
      expect(events[0]).to.deep.include({ contract: "pay", umid, payload: { to: "bob" } });
      expect(await listDivergences(store as any)).to.deep.equal([]);
    });

    it("settles a duplicate without executing again", async () => {
      const { item, umid } = committedItem(2);
      execute = async () => result({ documents: localDocs(umid, 2) });
      await processor.apply(item, from());
      const again = await processor.apply(clone(item), from());
      expect(again.action).to.equal("settled");
      expect(again.vote).to.equal("yes");
      expect(executions).to.have.length(1);
    });

    it("drops an item with an invalid vote signature without executing", async () => {
      const { item } = committedItem(2);
      item.nodes[nodes[1].ref].sig = item.nodes[nodes[2].ref].sig;
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.reasons.join()).to.contain("invalid vote signature");
      expect(executions).to.have.length(0);
      expect((await get(S))._rev).to.equal("1-aaa");
    });
  });

  describe("committed, mismatch and supernode-dependent (adopt mode)", () => {
    it("does not adopt on a single attestation", async () => {
      const { item, signed, umid } = committedItem(5);
      peers = [new FakeUpstream("p1", Object.values(signed))];
      execute = async () => result({ documents: localDocs(umid, 2), supernodeDependent: true, dependence: ["isSupernode"] });

      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.vote).to.equal("no");
      expect(out.reasons.join()).to.contain("matching commit attestations");
      // The local result was put back: the stream is still at $revs
      expect(await get(S)).to.deep.equal(BEFORE_STATE);
      expect(await get(`${S}:stream`)).to.deep.equal(BEFORE_META);
      expect(await get(`${umid}:umid`)).to.equal(undefined);
    });

    it("adopts with a quorum (supernode attestations) and warns adopt.undeclared without declarations", async () => {
      const { item, signed, umid } = committedItem(5);
      for (const [i, n] of [nodes[1], nodes[2]].entries()) {
        const sn = new FakeUpstream(`sn${i + 2}`);
        sn.attestations.set(umid, attest(n, item));
        supernodes.push(sn);
      }
      peers = [new FakeUpstream("p1", Object.values(signed))];
      execute = async () => result({ documents: localDocs(umid, 2), supernodeDependent: true, dependence: ["isSupernode"] });

      const out = await processor.apply(item, from());
      expect(out.action).to.equal("adopted");
      expect(out.vote).to.equal("yes");
      expect(out.warnings).to.deep.equal(["adopt.undeclared"]);
      expect(out.divergence).to.equal(undefined);
      expect(await get(S)).to.deep.equal(signed[S]);
      expect(await get(`${S}:stream`)).to.deep.equal(signed[`${S}:stream`]);
      expect(await get(`${umid}:umid`)).to.deep.equal(item.umidDoc);
      expect(events.find((e) => e.type === "adopt.undeclared")).to.deep.include({ umid, contract: "pay" });
      expect(await listDivergences(store as any)).to.deep.equal([]);
    });

    it("adopts a declared change (verified yes, no warning)", async () => {
      const { item, signed, umid } = committedItem(5, { quorum: true });
      supernodes = [new FakeUpstream("sn1", Object.values(signed))];
      execute = async () =>
        result({
          documents: localDocs(umid, 2),
          supernodeDependent: true,
          adopt: [{ streams: [S], shape: { balance: "number" } }],
        });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("adopted");
      expect(out.warnings).to.deep.equal([]);
      expect(await get(S)).to.deep.equal(signed[S]);
    });

    it("treats a change outside the declaration as a divergence and repairs", async () => {
      const { item, signed, umid } = committedItem(5, { quorum: true });
      peers = [new FakeUpstream("p1", Object.values(signed))];
      execute = async () =>
        result({
          documents: localDocs(umid, 2),
          supernodeDependent: true,
          adopt: [{ streams: [S], shape: { signature: "string?" } }],
        });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("repaired");
      expect(out.vote).to.equal("yes");
      expect(out.divergence!.kind).to.equal("adopt-rejected");
      expect(await get(S)).to.deep.equal(signed[S]);
      const records = await listDivergences(store as any);
      expect(records.map((r) => r.kind)).to.deep.equal(["adopt-rejected"]);
      expect(events.some((e) => e.type === "divergence")).to.equal(true);
    });
  });

  describe("committed, mismatch, not supernode-dependent (SPI)", () => {
    it("repairs from a majority of hybrid peers and records the divergence", async () => {
      const { item, signed, umid } = committedItem(5);
      const wrong = signedDocs(umid, 9);
      peers = [
        new FakeUpstream("p1", Object.values(signed)),
        new FakeUpstream("p2", Object.values(signed)),
        new FakeUpstream("p3", [wrong[S], signed[`${S}:stream`]]),
      ];
      execute = async () => result({ documents: localDocs(umid, 2) });

      const out = await processor.apply(item, from());
      expect(out.action).to.equal("repaired");
      expect(out.vote).to.equal("yes");
      expect(out.divergence!.kind).to.equal("output-mismatch");
      expect(await get(S)).to.deep.equal(signed[S]);
      expect(await get(`${umid}:umid`)).to.deep.equal(item.umidDoc);
      const [record] = await listDivergences(store as any);
      expect(record).to.deep.include({ umid, kind: "output-mismatch" });
      expect(record.supernodeTally).to.deep.equal({ yes: 3, no: 0 });
      expect(record.revsOut).to.deep.equal(item.revsOut);
      expect((record.localResult as any).outputs[S].rev).to.equal(stored(localDocs(umid, 2)[S], 2)._rev);
    });

    it("escalates to the supernodes' majority when the peers do not agree", async () => {
      const { item, signed, umid } = committedItem(5);
      peers = [new FakeUpstream("p1", Object.values(signed)), new FakeUpstream("p2"), new FakeUpstream("p3")];
      supernodes = [
        new FakeUpstream("sn1", Object.values(signed)),
        new FakeUpstream("sn2", Object.values(signed)),
        new FakeUpstream("sn3", Object.values(signedDocs(umid, 7))),
      ];
      execute = async () => result({ documents: localDocs(umid, 2) });

      const out = await processor.apply(item, from());
      expect(out.action).to.equal("repaired");
      expect(supernodes[1].calls.streams).to.equal(1);
      expect(await get(S)).to.deep.equal(signed[S]);
    });

    it("accepts a single peer when revsOut is quorum-signed", async () => {
      const { item, signed, umid } = committedItem(5, { quorum: true });
      peers = [new FakeUpstream("p1", Object.values(signed)), new FakeUpstream("p2"), new FakeUpstream("p3")];
      supernodes = [];
      execute = async () => result({ documents: localDocs(umid, 2) });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("repaired");
      expect(await get(S)).to.deep.equal(signed[S]);
    });

    it("never adopts a document whose sha256 does not match revsOut", async () => {
      const { item, signed, umid } = committedItem(5, { quorum: true });
      const forged = { ...signed[S], balance: 1000 };
      peers = [new FakeUpstream("p1", [forged, signed[`${S}:stream`]])];
      supernodes = [];
      execute = async () => result({ documents: localDocs(umid, 2) });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.divergence!.kind).to.equal("output-mismatch");
      expect(await get(S)).to.deep.equal(BEFORE_STATE);
    });
  });

  describe("failure handling", () => {
    it("retries an execution error once", async () => {
      const { item, umid } = committedItem(2);
      let n = 0;
      execute = async () => {
        if (n++ === 0) throw new Error("boom");
        return result({ documents: localDocs(umid, 2) });
      };
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("saved");
      expect(executions).to.have.length(2);
    });

    it("after a second error repairs by SPI and records the divergence", async () => {
      const { item, signed } = committedItem(2, { quorum: true });
      peers = [new FakeUpstream("p1", Object.values(signed))];
      execute = async () => {
        throw new Error("boom");
      };
      const out = await processor.apply(item, from());
      expect(executions).to.have.length(2);
      expect(out.action).to.equal("repaired");
      expect(out.vote).to.equal("yes");
      expect(out.divergence!.kind).to.equal("execution-error");
      expect(await get(S)).to.deep.equal(signed[S]);
    });

    it("when SPI also fails, records the divergence and the next item still applies", async () => {
      const orderer = new ItemOrderer({ processor, store: store as any });
      const broken = committedItem(2);
      execute = async () => {
        throw new Error("boom");
      };
      const out = await orderer.submit(broken.item, from());
      expect(out.action).to.equal("dropped");
      expect(out.divergence!.kind).to.equal("execution-error");
      expect((out.divergence!.localResult as any).error).to.contain("boom");
      expect(await get(S)).to.deep.equal(BEFORE_STATE);

      const next = committedItem(2);
      execute = async () => result({ documents: localDocs(next.umid, 2) });
      const out2 = await orderer.submit(next.item, from());
      expect(out2.action).to.equal("saved");
      expect(await get(S)).to.deep.equal(next.signed[S]);
      expect((await listDivergences(store as any)).map((r) => r.umid)).to.deep.equal([broken.umid]);
    });
  });

  describe("failed items", () => {
    it("records a divergence when a failed item passes locally", async () => {
      const { item, umid } = failedItem();
      execute = async () => result({ documents: localDocs(umid, 2) });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("recorded");
      expect(out.divergence!.kind).to.equal("failed-but-passed");
      expect(executions[0].$revs).to.deep.equal(REVS);
      // A dry run: nothing written
      expect(await get(S)).to.deep.equal(BEFORE_STATE);
      expect(events.map((e) => e.type)).to.deep.equal(["tx.failed", "divergence"]);
    });

    it("writes nothing for a supernode-dependent pass", async () => {
      const { item } = failedItem();
      execute = async () => result({ supernodeDependent: true });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("recorded");
      expect(out.divergence).to.equal(undefined);
      expect(await listDivergences(store as any)).to.deep.equal([]);
    });

    it("writes nothing when it also fails locally", async () => {
      const { item } = failedItem();
      execute = async () => result({ vote: false, committed: false, error: "no" });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("recorded");
      expect(out.divergence).to.equal(undefined);
    });

    it("does not trust a failed item whose yes votes reach consensus when another upstream shows it committed", async () => {
      const { item, umid } = failedItem(3, 0);
      const other = new FakeUpstream("sn2");
      other.umids.set(umid, umidDocFor(umid));
      supernodes.push(other);
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.reasons.join()).to.contain("shows it committed");
      expect(executions).to.have.length(0);
      expect(supernodes[0].calls.umid).to.equal(undefined);
    });

    it("judges a self-contradicting failed item normally when another upstream has no commit", async () => {
      const { item } = failedItem(3, 0);
      supernodes.push(new FakeUpstream("sn2"));
      execute = async () => result({ vote: false, committed: false });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("recorded");
      expect(executions).to.have.length(1);
    });

    it("drops a self-contradicting failed item no other upstream can check", async () => {
      const { item } = failedItem(3, 0);
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(executions).to.have.length(0);
    });
  });

  describe("inputs", () => {
    it("fetches a stream that is behind at exactly the item's $revs before executing", async () => {
      const { item, signed, umid } = committedItem(2);
      // The local copy is one transaction behind
      await store.data.bulkDocs([{ ...BEFORE_STATE, _rev: "2-bbb" }], { new_edits: true, force_rev: "0-old" });
      const behind = await get(S);
      expect(behind._rev).to.equal("0-old");
      peers = [new FakeUpstream("p1", [BEFORE_STATE, BEFORE_META])];
      execute = async () => result({ documents: localDocs(umid, 2) });
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("saved");
      expect(await get(S)).to.deep.equal(signed[S]);
    });

    it("drops an item whose inputs cannot be had", async () => {
      const { item } = committedItem(2);
      item.$revs = { $i: { [S]: "1-mmm:1-aaa", unknown: "4-x:4-y" }, $o: {} };
      // Re-sign for the changed $revs
      item.nodes = votes(item.umid, item.$revs, 3);
      item.umidDoc = umidDocFor(item.umid, item.$revs);
      item.attestation = attest(nodes[0], item);
      const out = await processor.apply(item, from());
      expect(out.action).to.equal("dropped");
      expect(out.reasons.join()).to.contain("unknown");
      expect(executions).to.have.length(0);
    });
  });
});

describe("Hybrid item orderer", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-orderer-"));
    store = await openEmbeddedStorage(dir);
    await store.data.bulkDocs([{ _id: "a", _rev: "1-a" }], { new_edits: false });
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const item = (umid: string, revs: any, revsOut: any = {}) =>
    ({ umid, outcome: "committed", $revs: revs, attestation: { revsOut } }) as any;

  /** Applies by moving each $revs stream to the next position */
  const advancing = (log: string[]) => ({
    apply: async (it: any) => {
      log.push(it.umid);
      for (const id of Object.keys(it.$revs.$i)) {
        const at = parseInt(it.$revs.$i[id].split("-")[0], 10);
        await store.data.bulkDocs([{ _id: id, _rev: `${at}-${id}` }], { new_edits: true, force_rev: `${at + 1}-${id}` });
      }
      return { umid: it.umid, action: "saved", vote: "yes", warnings: [], reasons: [] } as any;
    },
  });

  it("holds an out-of-order item until the item before it applies", async () => {
    const log: string[] = [];
    const orderer = new ItemOrderer({ processor: advancing(log), store: store as any, waitMs: 10000 });
    const second = orderer.submit(item("second", { $i: { a: "2-a" }, $o: {} }), {} as any);
    await new Promise((r) => setTimeout(r, 30));
    expect(log).to.deep.equal([]);
    expect(orderer.pending).to.equal(1);
    const first = orderer.submit(item("first", { $i: { a: "1-a" }, $o: {} }), {} as any);
    await Promise.all([first, second]);
    expect(log).to.deep.equal(["first", "second"]);
  });

  it("runs a waiting item after the timeout, so lookup can fetch what it lacks", async () => {
    const log: string[] = [];
    const orderer = new ItemOrderer({ processor: advancing(log), store: store as any, waitMs: 50 });
    const started = Date.now();
    await orderer.submit(item("late", { $i: { a: "5-a" }, $o: {} }), {} as any);
    expect(log).to.deep.equal(["late"]);
    expect(Date.now() - started).to.be.at.least(45);
  });

  it("runs items that share no streams concurrently, and items that share one in turn", async () => {
    let running = 0;
    let max = 0;
    const order: string[] = [];
    const processor = {
      apply: async (it: any) => {
        running++;
        max = Math.max(max, running);
        order.push(`start ${it.umid}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end ${it.umid}`);
        running--;
        return { umid: it.umid, action: "saved", vote: "yes", warnings: [], reasons: [] } as any;
      },
    };
    const orderer = new ItemOrderer({ processor, store: store as any });
    await Promise.all([
      orderer.submit(item("x", { $i: { x: "1-x" }, $o: {} }), {} as any),
      orderer.submit(item("y", { $i: { y: "1-y" }, $o: {} }), {} as any),
    ]);
    expect(max).to.equal(2);

    order.length = 0;
    max = 0;
    await Promise.all([
      orderer.submit(item("p", { $i: { x: "1-x" }, $o: {} }), {} as any),
      orderer.submit(item("q", { $i: {}, $o: {} }, { "x:stream": { rev: "1", sha256: "" } }), {} as any),
    ]);
    expect(max).to.equal(1);
    expect(order).to.deep.equal(["start p", "end p", "start q", "end q"]);
  });

  it("respects the concurrency cap and gives a duplicate the same outcome", async () => {
    let running = 0;
    let max = 0;
    let calls = 0;
    const processor = {
      apply: async (it: any) => {
        calls++;
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { umid: it.umid, action: "saved", vote: "yes", warnings: [], reasons: [] } as any;
      },
    };
    const orderer = new ItemOrderer({ processor, store: store as any, concurrency: 2 });
    const all = ["m1", "m2", "m3", "m4"].map((u) => orderer.submit(item(u, { $i: { [u]: "1-x" }, $o: {} }), {} as any));
    const dup = orderer.submit(item("m1", { $i: { m1: "1-x" }, $o: {} }), {} as any);
    expect(dup).to.equal(all[0]);
    await Promise.all(all);
    expect(max).to.equal(2);
    expect(calls).to.equal(4);
    await orderer.idle();
  });
});
