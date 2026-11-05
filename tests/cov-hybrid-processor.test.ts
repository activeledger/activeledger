import { expect } from "chai";
import "mocha";
import { ActiveLogger } from "@activeledger/activelogger";
import { Processor } from "../packages/hybrid/src/processor";
import { docHash } from "../packages/hybrid/src/verify";

/** A document store that keeps what it is given */
const fakeData = (over: any = {}) => {
  const docs = new Map<string, any>();
  const purged: string[] = [];
  return {
    docs,
    purged,
    get: async (id: string) => {
      if (!docs.has(id)) throw new Error("missing");
      return docs.get(id);
    },
    bulkDocs: async (list: any[]) => {
      for (const d of list) docs.set(d._id, d);
      return { ok: true };
    },
    purge: async (d: any) => {
      purged.push(d._id);
      docs.delete(d._id);
    },
    ...over,
  };
};

describe("Hybrid Processor internals (cov)", () => {
  let errors: any[][];
  const origError = (ActiveLogger as any).error;
  beforeEach(() => {
    errors = [];
    (ActiveLogger as any).error = (...a: any[]) => errors.push(a);
  });
  afterEach(() => {
    (ActiveLogger as any).error = origError;
  });

  const make = (data: any, events: any = { post: async () => ({ ok: true }) }, emitted: any[] = []) =>
    new Processor({
      store: { data, events } as any,
      sources: { peers: [], supernodes: [] },
      lookup: {} as any,
      events: { emit: async (e: any) => void emitted.push(e) },
      context: () => undefined,
      contracts: null,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    }) as any;

  describe("memory of applied items", () => {
    it("forgets the oldest once it holds more than 10000", () => {
      const p = make(fakeData());
      for (let i = 0; i <= 10000; i++) p.remember(`k${i}`);
      expect(p.done.size).to.equal(10000);
      expect(p.done.has("k0")).to.equal(false);
      expect(p.done.has("k1")).to.equal(true);
      expect(p.done.has("k10000")).to.equal(true);
    });
    it("keeps everything up to exactly 10000", () => {
      const p = make(fakeData());
      for (let i = 0; i < 10000; i++) p.remember(`k${i}`);
      expect(p.done.size).to.equal(10000);
      expect(p.done.has("k0")).to.equal(true);
    });
  });

  describe("committed, umid doc not what was attested", () => {
    it("drops the item and writes nothing", async () => {
      const data = fakeData();
      const p = make(data);
      const item: any = { umid: "u1", outcome: "committed", umidDoc: { _id: "u1:umid", x: 1 }, attestation: { umidDocHash: "0".repeat(64), revsOut: {} } };
      const out = await p.committed(item, {}, { yes: 3, no: 0 });
      expect(out.action).to.equal("dropped");
      expect(out.vote).to.equal("no");
      expect(out.retry).to.equal(undefined);
      expect(out.reasons).to.deep.equal(["umid doc does not match the attestation's umidDocHash"]);
      expect(data.docs.size).to.equal(0);
    });
  });

  describe("writeUmidDoc", () => {
    const doc = { _id: "u1:umid", _rev: "1-0123456789abcdef0123456789abcdef", umid: { $umid: "u1" } };
    it("stores the received document as it came", async () => {
      const data = fakeData();
      await make(data).writeUmidDoc({ umid: "u1", umidDoc: doc, attestation: { umidDocHash: docHash(doc) } });
      expect(data.docs.get("u1:umid")).to.deep.equal(doc);
    });
    it("refuses a document that does not match its hash, or has none", async () => {
      const data = fakeData();
      for (const item of [
        { umid: "u1", umidDoc: doc, attestation: { umidDocHash: "bad" } },
        { umid: "u1", umidDoc: doc, attestation: {} },
        { umid: "u1", umidDoc: undefined, attestation: { umidDocHash: docHash(doc) } },
        { umid: "u1", umidDoc: doc },
      ]) {
        let err: any;
        try {
          await make(data).writeUmidDoc(item);
        } catch (e) {
          err = e;
        }
        expect(err.message).to.equal("u1: umid doc does not match umidDocHash");
      }
      expect(data.docs.size).to.equal(0);
    });
    it("fails when the store does not confirm the write", async () => {
      const data = fakeData({ bulkDocs: async () => ({}) });
      let err: any;
      try {
        await make(data).writeUmidDoc({ umid: "u1", umidDoc: doc, attestation: { umidDocHash: docHash(doc) } });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("u1: writing the :umid doc failed");
    });
  });

  describe("rollback", () => {
    it("puts back what was there and removes what was not", async () => {
      const data = fakeData();
      data.docs.set("kept", { _id: "kept", _rev: "2-new", v: "after" });
      data.docs.set("added", { _id: "added", _rev: "1-x" });
      await make(data).rollback({ kept: { _id: "kept", _rev: "1-old", v: "before" } }, ["kept", "added", "never-written"]);
      expect(data.docs.get("kept")).to.deep.include({ _rev: "1-old", v: "before" });
      expect(data.docs.has("added")).to.equal(false);
      expect(data.purged).to.deep.equal(["added"]);
    });
    it("logs a failed rollback of one document and carries on with the rest", async () => {
      const data = fakeData();
      data.docs.set("a", { _id: "a", _rev: "1-x" });
      data.docs.set("b", { _id: "b", _rev: "1-x" });
      const purge = data.purge;
      data.purge = async (d: any) => {
        if (d._id === "a") throw new Error("locked");
        return purge(d);
      };
      await make(data).rollback({}, ["a", "b"]);
      expect(data.docs.has("b")).to.equal(false);
      expect(data.docs.has("a")).to.equal(true);
      expect(errors.length).to.equal(1);
      expect(errors[0][0].message).to.equal("locked");
      expect(errors[0][1]).to.equal("Rollback of a failed");
    });
  });

  describe("divergence records", () => {
    const item: any = { umid: "u9", $revs: { $i: {}, $o: {} }, attestation: { revsOut: { s: { rev: "1-a", sha256: "h" } } } };
    it("still returns the record and raises the event when the record cannot be stored", async () => {
      const emitted: any[] = [];
      const p = make(fakeData(), { post: async () => { throw new Error("events down"); } }, emitted);
      const rec = await p.diverge(item, "umid-doc-mismatch", { yes: 3, no: 1 }, { r: 1 }, { $i: {}, $o: {} });
      expect(rec.umid).to.equal("u9");
      expect(rec.kind).to.equal("umid-doc-mismatch");
      expect(rec.at).to.equal("2026-01-02T03:04:05.000Z");
      expect(rec.supernodeTally).to.deep.equal({ yes: 3, no: 1 });
      expect(rec.revsOut).to.deep.equal(item.attestation.revsOut);
      expect(errors.length).to.equal(1);
      expect(errors[0][1]).to.equal("Divergence record for u9 not written");
      expect(emitted.map((e) => e.type)).to.deep.equal(["divergence"]);
      expect(emitted[0].payload).to.deep.equal({ kind: "umid-doc-mismatch" });
    });
    it("stores the record when it can", async () => {
      const posted: any[] = [];
      const p = make(fakeData(), { post: async (d: any) => (posted.push(d), { ok: true, id: d._id }) });
      await p.diverge({ ...item, attestation: undefined }, "output-hash-mismatch", { yes: 1, no: 0 }, {});
      expect(posted.length).to.equal(1);
      expect(posted[0]._id).to.match(/^divergence:\d+,u9$/);
      expect(posted[0]).to.not.have.property("revsOut");
      expect(posted[0]).to.not.have.property("localRevs");
      expect(errors).to.deep.equal([]);
    });
  });

  describe("adopt, attested outputs cannot be written", () => {
    it("rolls back the local writes and asks to retry", async () => {
      const p = make(fakeData());
      const rolled: any[] = [];
      p.gatherQuorum = async () => ({ reached: true, count: 3 });
      p.fetchSigned = async () => ({ docs: { s1: { _id: "s1", _rev: "2-a" } }, missing: [] });
      p.writeDocs = async () => false;
      p.rollback = async (before: any, touched: string[]) => void rolled.push([before, touched]);
      const item: any = { umid: "u5", attestation: { revsOut: { s1: { rev: "2-a", sha256: "h" } } } };
      const before = { s1: { _id: "s1", _rev: "1-a" } };
      const out = await p.adopt(item, { reachedPercent: 60, networkSize: 4 }, { yes: 3, no: 0 }, { documents: {}, adopt: [] }, before, ["s1"], { result: {}, revs: {} });
      expect(out.action).to.equal("dropped");
      expect(out.retry).to.equal(true);
      expect(out.reasons).to.deep.equal(["writing the attested outputs failed"]);
      expect(rolled).to.deep.equal([[before, ["s1"]]]);
    });
    it("asks to retry, without writing, when the quorum is not reached", async () => {
      const p = make(fakeData());
      let wrote = 0;
      p.gatherQuorum = async () => ({ reached: false, count: 1 });
      p.writeDocs = async () => (wrote++, true);
      p.rollback = async () => undefined;
      const out = await p.adopt({ umid: "u6", attestation: { revsOut: {} } }, { reachedPercent: 60, networkSize: 4 }, { yes: 1, no: 0 }, { documents: {} }, {}, [], { result: {}, revs: {} });
      expect(out.retry).to.equal(true);
      expect(out.reasons).to.deep.equal(["adopt needs 60% matching commit attestations, have 1/4"]);
      expect(wrote).to.equal(0);
    });
  });
});
