import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveOptions } from "@activeledger/activeoptions";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { SourceLookup, splitRev, writeAtRev } from "../packages/hybrid/src/lookup";
import { docHash } from "../packages/hybrid/src/verify";
import { listDivergences, writeDivergence } from "../packages/hybrid/src/divergence";
import { ContractBuilder, applyExecutionOptions, isContractStream } from "../packages/hybrid/src/contracts";

const clone = (v: any) => JSON.parse(JSON.stringify(v));

/** Serves documents as POST /h/streams does, and records the order of calls */
class FakeUpstream {
  public docs = new Map<string, any>();
  public umids = new Map<string, any>();
  public down = false;
  constructor(public id: string, docs: any[], private log: string[] = []) {
    for (const d of docs) this.docs.set(d._id, clone(d));
  }
  async streams(reqs: { id: string; rev?: string }[]) {
    this.log.push(this.id);
    if (this.down) throw new Error("down");
    const docs: any[] = [];
    const missing: any[] = [];
    for (const r of reqs) {
      const s = this.docs.get(r.id);
      if (!s || (r.rev && s._rev !== r.rev)) {
        missing.push(r);
        continue;
      }
      docs.push(clone(s));
      for (const suffix of [":stream", ":volatile"]) {
        const m = this.docs.get(r.id + suffix);
        if (m) docs.push(clone(m));
      }
    }
    return { docs, missing };
  }
  async umid(umid: string) {
    return this.umids.get(umid);
  }
}

const state = { _id: "st", _rev: "7-net", value: 42 };
const meta = { _id: "st:stream", _rev: "3-meta", umid: "u7", name: "st" };

describe("Hybrid lookup", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  let log: string[];
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-lookup-"));
    store = await openEmbeddedStorage(dir);
    log = [];
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const get = async (id: string) => {
    const d = await store.data.get(id);
    return d && d._id ? d : undefined;
  };
  const lookup = (peers: FakeUpstream[], supernodes: FakeUpstream[]) =>
    new SourceLookup({ store: store as any, sources: { peers: peers as any[], supernodes: supernodes as any[] } });

  it("splits a $revs value into meta and state revisions", () => {
    expect(splitRev("3-meta:7-net")).to.deep.equal({ meta: "3-meta", state: "7-net" });
    expect(splitRev("7-net")).to.deep.equal({ state: "7-net" });
    expect(splitRev(undefined)).to.deep.equal({});
  });

  it("fetches an unknown stream at its revision, with its meta, keeping the network's revisions", async () => {
    const r = await lookup([new FakeUpstream("p1", [state, meta], log)], []).ensure([
      { id: "st", rev: "3-meta:7-net", sha256: docHash(state), metaSha256: docHash(meta) },
    ]);
    expect(r.missing).to.deep.equal([]);
    expect(await get("st")).to.deep.equal(state);
    expect(await get("st:stream")).to.deep.equal(meta);
  });

  it("never takes a stream from a peer unless state and meta both match signed hashes", async () => {
    const peer = (): FakeUpstream => new FakeUpstream("p1", [state, meta], log);
    // Nothing signed to check against (an input at its $revs): not from a peer
    expect((await lookup([peer()], []).ensure([{ id: "st", rev: "3-meta:7-net" }])).missing).to.deep.equal(["st"]);
    // State hash only: the meta (authorities!) would be unverified
    expect((await lookup([peer()], []).ensure([{ id: "st", rev: "3-meta:7-net", sha256: docHash(state) }])).missing).to.deep.equal(["st"]);
    // A forged meta fails its hash
    const forged = new FakeUpstream("p1", [state, { ...meta, authorities: ["evil"] }], log);
    expect((await lookup([forged], []).ensure([{ id: "st", rev: "3-meta:7-net", sha256: docHash(state), metaSha256: docHash(meta) }])).missing).to.deep.equal(["st"]);
    expect(await get("st")).to.equal(undefined);
    expect(await get("st:stream")).to.equal(undefined);
  });

  it("does not take volatile from a peer", async () => {
    const volatile = { _id: "st:volatile", v: 1 };
    await lookup([new FakeUpstream("p1", [state, meta, volatile], log)], []).ensure([
      { id: "st", rev: "3-meta:7-net", sha256: docHash(state), metaSha256: docHash(meta) },
    ]);
    expect(await get("st")).to.deep.equal(state);
    expect(await get("st:volatile")).to.equal(undefined);
  });

  it("takes volatile from a supernode", async () => {
    const volatile = { _id: "st:volatile", _rev: "1-v", v: 1 };
    await lookup([], [new FakeUpstream("sn1", [state, meta, volatile], log)]).ensure([{ id: "st", rev: "7-net" }]);
    expect(await get("st:volatile")).to.not.equal(undefined);
  });

  it("overwrites a present but different copy with the network's revision", async () => {
    await store.data.bulkDocs([{ _id: "st", _rev: "6-old", value: 1 }], { new_edits: false });
    const r = await lookup([], [new FakeUpstream("sn1", [state, meta], log)]).ensure([{ id: "st", rev: "7-net" }]);
    expect(r.missing).to.deep.equal([]);
    expect(await get("st")).to.deep.equal(state);
  });

  it("asks nobody for a stream already held at that revision", async () => {
    await store.data.bulkDocs([clone(state), clone(meta)], { new_edits: false });
    const r = await lookup([new FakeUpstream("p1", [], log)], []).ensure([{ id: "st", rev: "3-meta:7-net" }]);
    expect(r.missing).to.deep.equal([]);
    expect(log).to.deep.equal([]);
  });

  it("never writes a document whose sha256 does not match, and tries the next source", async () => {
    const forged = { ...state, value: 1000 };
    const r = await lookup(
      [new FakeUpstream("p1", [forged, meta], log)],
      [new FakeUpstream("sn1", [forged, meta], log)]
    ).ensure([{ id: "st", rev: "7-net", sha256: docHash(state) }]);
    expect(r.missing).to.deep.equal(["st"]);
    expect(await get("st")).to.equal(undefined);
    expect(await get("st:stream")).to.equal(undefined);

    const r2 = await lookup(
      [new FakeUpstream("p1", [forged, meta], log)],
      [new FakeUpstream("sn1", [state, meta], log)]
    ).ensure([{ id: "st", rev: "7-net", sha256: docHash(state) }]);
    expect(r2.missing).to.deep.equal([]);
    expect(await get("st")).to.deep.equal(state);
  });

  it("asks peers before supernodes for verifiable streams and tolerates a source that fails", async () => {
    const p1 = new FakeUpstream("p1", [state, meta], log);
    p1.down = true;
    const r = await lookup([p1, new FakeUpstream("p2", [], log)], [new FakeUpstream("sn1", [state, meta], log)]).ensure([
      { id: "st", rev: "7-net", sha256: docHash(state), metaSha256: docHash(meta) },
    ]);
    expect(r.missing).to.deep.equal([]);
    expect(log).to.deep.equal(["p1", "p2", "sn1"]);
  });

  it("goes straight to a supernode for a stream no signed hash covers", async () => {
    const r = await lookup([new FakeUpstream("p1", [state, meta], log)], [new FakeUpstream("sn1", [state, meta], log)]).ensure([
      { id: "st", rev: "7-net" },
    ]);
    expect(r.missing).to.deep.equal([]);
    expect(log).to.deep.equal(["sn1"]);
  });

  it("refuses a meta at another revision than $revs names", async () => {
    const r = await lookup([new FakeUpstream("p1", [state, { ...meta, _rev: "4-other" }], log)], []).ensure([
      { id: "st", rev: "3-meta:7-net" },
    ]);
    expect(r.missing).to.deep.equal(["st"]);
    expect(await get("st")).to.equal(undefined);
  });

  it("refreshes to the tip from supernodes only and never moves a stream backwards", async () => {
    await store.data.bulkDocs([{ _id: "ahead", _rev: "9-local" }], { new_edits: false });
    const r = await lookup(
      [new FakeUpstream("p1", [], log)],
      [new FakeUpstream("sn1", [state, meta, { _id: "ahead", _rev: "8-net" }], log)]
    ).refreshToTip(["st", "ahead", "nowhere"]);
    expect(r.missing).to.deep.equal(["nowhere"]);
    // Peers are never asked for a tip: there is no signed hash to check one against
    expect(log).to.deep.equal(["sn1"]);
    expect(await get("st")).to.deep.equal(state);
    expect((await get("ahead"))._rev).to.equal("9-local");
  });

  it("writeAtRev keeps the given revision and leaves an identical copy alone", async () => {
    expect(await writeAtRev(store.data as any, clone(state))).to.equal(true);
    expect(await writeAtRev(store.data as any, clone(state))).to.equal(true);
    expect((await get("st"))._rev).to.equal("7-net");
    expect(await writeAtRev(store.data as any, { _id: "norev" })).to.equal(false);
  });

  describe("divergence records", () => {
    it("lists records oldest first, from a time", async () => {
      const rec = (umid: string, at: string): any => ({
        umid,
        kind: "output-mismatch",
        supernodeTally: { yes: 3, no: 0 },
        localResult: {},
        $revs: { $i: {}, $o: {} },
        at,
      });
      await writeDivergence(store as any, rec("b", "2026-10-02T00:00:00.000Z"));
      await writeDivergence(store as any, rec("a", "2026-10-01T00:00:00.000Z"));
      await store.events.post({ _id: "umid:1,x" });
      expect((await listDivergences(store as any)).map((r) => r.umid)).to.deep.equal(["a", "b"]);
      expect((await listDivergences(store as any, "2026-10-01T12:00:00Z")).map((r) => r.umid)).to.deep.equal(["b"]);
      expect((await listDivergences(store as any, new Date("2026-10-03"))).length).to.equal(0);
      const [first] = await listDivergences(store as any);
      expect(first).to.deep.equal(rec("a", "2026-10-01T00:00:00.000Z"));
    });
  });

  describe("contract files", () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-contracts-")) + "/";
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const code = (v: number) => Buffer.from(`export default class C { v(): number { return ${v}; } }`).toString("base64");
    const contractState = (over: any = {}) => ({
      _id: "c0ffee",
      _rev: "1-c",
      name: "token",
      namespace: "acme",
      contract: { "0.0.2": code(2), "0.0.10": code(10) },
      compiled: { "0.0.2": "x", "0.0.10": "y" },
      ...over,
    });

    it("recognises contract streams", () => {
      expect(isContractStream(contractState())).to.equal(true);
      expect(isContractStream({ _id: "x", _rev: "1", value: 1 })).to.equal(false);
      expect(isContractStream({ ...contractState(), _id: "c0ffee:stream" })).to.equal(false);
    });

    it("writes every version, the highest as latest", async () => {
      const builder = new ContractBuilder({ store: store as any, sources: { peers: [], supernodes: [] }, verify: async () => true, rootDir: root });
      await store.data.bulkDocs([{ _id: "c0ffee:stream", _rev: "1-m" }], { new_edits: false });
      const r = await builder.rebuild(contractState());
      expect(r.built).to.deep.equal(["0.0.2", "0.0.10"]);
      expect(fs.readFileSync(`${root}acme/c0ffee@0.0.2.js`, "utf8")).to.contain("return 2");
      expect(fs.readFileSync(`${root}acme/c0ffee.js`, "utf8")).to.contain("return 10");
    });

    it("rebuilds a first-seen contract for an entry, recovering umid-referenced source from an upstream", async () => {
      const base64 = code(3);
      const { ContractSource } = await import("@activeledger/activecontracts/lib/source");
      const s = contractState({
        contract: { "1.0.0": { umid: "deploy1", hash: ContractSource.hash(base64) } },
        compiled: { "1.0.0": "z" },
        identity: "idstream",
      });
      const sn = new FakeUpstream("sn1", [s, { _id: "c0ffee:stream", _rev: "1-m", umid: "deploy1" }]);
      sn.umids.set("deploy1", { _id: "deploy1:umid", umid: { $umid: "deploy1", $tx: { $i: { idstream: { contract: base64 } } } } });
      const sources = { peers: [], supernodes: [sn as any] };
      const builder = new ContractBuilder({
        store: store as any,
        sources,
        lookup: new SourceLookup({ store: store as any, sources }),
        verify: async () => true,
        rootDir: root,
      });
      await builder.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@1.0.0" } });
      expect(fs.readFileSync(`${root}acme/c0ffee@1.0.0.js`, "utf8")).to.contain("return 3");
      // Default contracts ship with the node
      await builder.ensureFor({ $tx: { $namespace: "default", $contract: "onboard" } });
      expect(fs.existsSync(`${root}default`)).to.equal(false);
    });

    it("does not build a local contract stream that was never verified, whatever put it there", async () => {
      await store.data.bulkDocs([contractState(), { _id: "c0ffee:stream", _rev: "1-m" }], { new_edits: false });
      const builder = new ContractBuilder({ store: store as any, sources: { peers: [], supernodes: [] }, rootDir: root });
      await builder.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@0.0.2" } });
      expect(fs.existsSync(`${root}acme/c0ffee.js`)).to.equal(false);
      // Written from a verified feed item, it is trusted
      await builder.onWritten([contractState()]);
      expect(fs.existsSync(`${root}acme/c0ffee.js`)).to.equal(true);
    });

    it("refuses a contract stream older than the revision the transaction names, and takes the highest verified one", async () => {
      const newer = { ...contractState(), _rev: "9-new" };
      const older = { ...contractState(), _rev: "2-old" };
      const meta = { _id: "c0ffee:stream", _rev: "1-m" };
      const sources = { peers: [], supernodes: [new FakeUpstream("sn1", [older, meta]) as any, new FakeUpstream("sn2", [newer, meta]) as any] };
      const builder = new ContractBuilder({ store: store as any, sources, verify: async () => true, rootDir: root });
      await builder.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@0.0.2" }, $revs: { $i: { c0ffee: "1-m:9-new" }, $o: {} } });
      expect((await store.data.get("c0ffee"))._rev).to.equal("9-new");
      expect(fs.existsSync(`${root}acme/c0ffee.js`)).to.equal(true);

      // Only an older state exists anywhere: a transaction needing a newer one builds nothing
      const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-contracts-"));
      const lone = new ContractBuilder({
        store: { data: { get: async () => ({ error: true }), bulkDocs: async () => ({ ok: true }) } } as any,
        sources: { peers: [], supernodes: [new FakeUpstream("sn1", [older, meta]) as any] },
        verify: async () => true,
        rootDir: root2,
      });
      await lone.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@0.0.2" }, $revs: { $i: { c0ffee: "1-m:9-new" }, $o: {} } });
      expect(fs.existsSync(`${root2}acme/c0ffee.js`)).to.equal(false);
    });

    it("does not reuse a built older revision for a transaction that needs a newer one, and keys trust on content", async () => {
      await store.data.bulkDocs([{ ...contractState(), _rev: "2-old" }, { _id: "c0ffee:stream", _rev: "1-m" }], { new_edits: false });
      const builder = new ContractBuilder({ store: store as any, sources: { peers: [], supernodes: [] }, verify: async () => true, rootDir: root });
      await builder.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@0.0.2" } });
      expect(fs.existsSync(`${root}acme/c0ffee.js`)).to.equal(true);
      fs.rmSync(`${root}acme/c0ffee.js`);
      // Built at 2-old; a transaction needing 9-new must not be served by the cache
      await builder.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@0.0.2" }, $revs: { $i: { c0ffee: "1-m:9-new" }, $o: {} } });
      expect(fs.existsSync(`${root}acme/c0ffee.js`)).to.equal(false);

      // Same revision string, different content: trust does not carry over
      let verified = 0;
      const b2 = new ContractBuilder({ store: store as any, sources: { peers: [], supernodes: [] }, verify: async () => (verified++, true), rootDir: root });
      const state = contractState();
      await store.data.bulkDocs([{ ...state, _rev: "5-x" }], { new_edits: false });
      await b2.rebuild({ ...state, _rev: "5-x" });
      await b2.rebuild({ ...state, _rev: "5-x" });
      expect(verified).to.equal(1);
      const swapped = { ...state, _rev: "5-x", namespace: "acme", contract: { "0.0.2": Buffer.from("evil").toString("base64") } };
      await b2.rebuild(swapped);
      expect(verified).to.equal(2);
    });

    it("compiles nothing it cannot verify: no verifier, or a verifier that says no", async () => {
      const base64 = code(3);
      const { ContractSource } = await import("@activeledger/activecontracts/lib/source");
      const s = contractState({
        contract: { "1.0.0": { umid: "deploy1", hash: ContractSource.hash(base64) } },
        compiled: { "1.0.0": "z" },
        identity: "idstream",
      });
      const sn = new FakeUpstream("sn1", [s, { _id: "c0ffee:stream", _rev: "1-m", umid: "deploy1" }]);
      sn.umids.set("deploy1", { _id: "deploy1:umid", umid: { $umid: "deploy1", $tx: { $i: { idstream: { contract: base64 } } } } });
      const sources = { peers: [], supernodes: [sn as any] };
      for (const verify of [undefined, async () => false]) {
        const builder = new ContractBuilder({ store: store as any, sources, verify, rootDir: root });
        await builder.ensureFor({ $tx: { $namespace: "acme", $contract: "c0ffee@1.0.0" } });
        expect(fs.existsSync(`${root}acme/c0ffee@1.0.0.js`)).to.equal(false);
        // And nothing unverified was kept in the store either
        expect(await store.data.get("c0ffee")).to.not.have.property("contract");
      }
    });

    it("applies the setup stream's security and at least build 40300", () => {
      const security = ActiveOptions.get("security", null);
      const build = ActiveOptions.get("build", 0);
      try {
        applyExecutionOptions({ security: { namespace: { acme: { std: [] } }, signedOutputs: true, hardenedKeys: false } });
        expect(ActiveOptions.get<any>("security", null).signedOutputs).to.equal(true);
        expect(ActiveOptions.get<number>("build", 0)).to.be.at.least(40300);
      } finally {
        ActiveOptions.set("security", security);
        ActiveOptions.set("build", build);
      }
    });
  });
});
