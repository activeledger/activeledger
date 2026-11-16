import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { LevelMe } from "../packages/storage/src/levelme";
import { Attestation } from "../packages/protocol/src/protocol/attest";
import { HybridApi } from "../packages/network/src/network/hybridApi";

const sha = (d: any) => ActiveCrypto.Hash.getHash(ActiveCrypto.canonicalJson(d));

describe("Commit attestations made when asked for (Activeprotocol / Activenetwork)", () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  const pem = kp.generate().pub.pkcs8pem;
  const entry: any = {
    $umid: "u1",
    $revs: { $i: {}, $o: {} },
    $nodes: { a: { vote: true, sig: "sig-a" }, b: { vote: false }, c: { vote: undefined }, d: null },
  };
  /** What the store holds after the commit, with the revisions it assigned */
  const stored: any = {
    s1: { _id: "s1", _rev: "1-a", v: 1 },
    "s1:stream": { _id: "s1:stream", _rev: "1-b" },
    "u1:umid": { _id: "u1:umid", _rev: "1-c", umid: {} },
  };
  const store = (reads: string[] = []) => ({
    get: async (id: string) => (reads.push(id), stored[id]),
  });
  /** What was sent: no revisions, which the store assigns in its own process */
  const written = () => [{ _id: "s1" }, { _id: "s1:stream" }, { _id: "s1:volatile" }, { _id: "u1:umid" }];

  beforeEach(() => {
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
  });
  afterEach(() => {
    Attestation.key = undefined;
    ActiveOptions.set("build", 0);
  });

  describe("facts, read back at commit", () => {
    it("hashes what the store holds, leaves out volatile and the umid document, and keeps the signed votes", async () => {
      const reads: string[] = [];
      const f = (await Attestation.facts(store(reads), entry, written()))!;
      expect(Object.keys(f.revsOut)).to.deep.equal(["s1", "s1:stream"]);
      expect(f.revsOut.s1).to.deep.equal({ rev: "1-a", sha256: sha(stored.s1) });
      expect(f.umidDocHash).to.equal(sha(stored["u1:umid"]));
      expect(f.nodes).to.deep.equal({ a: { vote: true, sig: "sig-a" }, b: { vote: false } });
      expect(reads).to.deep.equal(["s1", "s1:stream", "u1:umid"]);
    });

    it("reads nothing when attestations are off", async () => {
      const reads: string[] = [];
      Attestation.key = undefined;
      expect(await Attestation.facts(store(reads), entry, written())).to.equal(undefined);
      expect(reads).to.deep.equal([]);
    });

    it("never fails the commit: a read that fails is logged and gives nothing", async () => {
      const errors: any[] = [];
      const real = (ActiveLogger as any).error;
      (ActiveLogger as any).error = (...a: any[]) => errors.push(a);
      try {
        const down = {
          get: async () => {
            throw new Error("store down");
          },
        };
        expect(await Attestation.facts(down, entry, written())).to.equal(undefined);
        expect(errors).to.have.length(1);
        expect(errors[0][1]).to.equal("Commit attestation facts failed for u1");
      } finally {
        (ActiveLogger as any).error = real;
      }
    });

    describe("against the real store", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-lazy-"));
      after(() => fs.rmSync(dir, { recursive: true, force: true }));

      it("describes what is stored, for a new document and an update", async () => {
        const db = new LevelMe(dir + path.sep, "lazy", "level", true);
        const batch = () => [
          { _id: "a1", x: 1, big: "y".repeat(70000) },
          { _id: "a1:stream", name: "n", txs: ["u1"] },
          { _id: "a1:volatile", v: 1 },
          { _id: "u1:umid", umid: { $umid: "u1" }, streams: { new: [], updated: [] }, events: [] },
        ];
        for (const round of [0, 1]) {
          const docs: any[] = batch();
          if (round) for (const d of docs) d._rev = (await db.get(d._id))._rev;
          await db.bulkDocs(docs, undefined, 10);
          const f = (await Attestation.facts(db, entry, docs))!;
          for (const id of ["a1", "a1:stream"]) {
            const now = await db.get(id);
            expect(f.revsOut[id], `${id} round ${round}`).to.deep.equal({ rev: now._rev, sha256: sha(now) });
          }
        }
      });
    });
  });

  describe("signing from the facts", () => {
    it("makes the attestation a hybrid verifies, the same every time", async () => {
      const facts = (await Attestation.facts(store(), entry, written()))!;
      const a = Attestation.attestation("node-ref", "u1", entry.$revs, facts)!;
      expect(a.node).to.equal("node-ref");
      expect(a.outcome).to.equal("committed");
      const digest = ActiveCrypto.commitDigest("u1", "committed", entry.$revs, a.revsOut, a.umidDocHash);
      expect(ActiveCrypto.verifyDigest(pem, "rsa", digest, a.sig)).to.equal(true);
      expect(Attestation.attestation("node-ref", "u1", entry.$revs, facts)).to.deep.equal(a);
    });

    it("gives nothing when this node has no key", async () => {
      const facts = (await Attestation.facts(store(), entry, written()))!;
      Attestation.key = undefined;
      expect(Attestation.attestation("n", "u1", entry.$revs, facts)).to.equal(undefined);
    });
  });

  describe("HybridApi", () => {
    class Mem {
      docs = new Map<string, any>();
      put(d: any) {
        this.docs.set(d._id, d);
        return this;
      }
      async get(id: string) {
        const d = this.docs.get(id);
        return d ? { ...d } : { notFound: true };
      }
      async allDocs(o: any) {
        const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
        const keys = [...this.docs.keys()].sort().filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
        return { rows: keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k })) };
      }
    }
    const DATE = "2030-01-01T00:00:00.000Z";
    const MS = new Date(DATE).getTime();

    const setup = async (withSigner = true) => {
      const facts = (await Attestation.facts(store(), entry, written()))!;
      const db = new Mem();
      const events = new Mem();
      let clock = 1000;
      const signs: string[] = [];
      db.put({ _id: "u1:umid", umid: { $umid: "u1", $datetime: DATE, $revs: entry.$revs }, streams: { new: [], updated: [] } });
      events.put({ _id: `umid:${MS},u1`, ...facts });
      const api = new HybridApi({
        db: db as any,
        events: events as any,
        registry: { lookup: async () => undefined, list: async () => [] },
        ledgerConfig: () => ({}),
        setupStreamId: () => "setup",
        banned: () => new Set(),
        now: () => clock,
        ...(withSigner
          ? { attest: (umid: string, revs: any, f: any) => (signs.push(umid), Attestation.attestation("node-ref", umid, revs, f)) }
          : {}),
      });
      return { api, db, events, signs, tick: (ms: number) => (clock += ms) };
    };

    it("signs a commit that kept only facts the first time it is asked, and serves the next from memory", async () => {
      const { api, signs } = await setup();
      const first = await api.attest("u1");
      expect(first.node).to.equal("node-ref");
      expect(first.sig).to.be.a("string");
      expect(first).to.not.have.property("nodes");
      expect(await api.attest("u1")).to.deep.equal(first);
      expect(signs).to.have.length(1);
    });

    it("signs again once the memory of it has expired, to the same attestation", async () => {
      const { api, signs, tick } = await setup();
      const first = await api.attest("u1");
      tick(119_000);
      await api.attest("u1");
      expect(signs).to.have.length(1);
      tick(2_000);
      expect(await api.attest("u1")).to.deep.equal(first);
      expect(signs).to.have.length(2);
    });

    it("answers a feed item from the same facts, with the votes kept at commit", async () => {
      const { api, signs } = await setup();
      const items = await api.feedSince("", 10);
      expect(items).to.have.length(1);
      const item = items[0].item as any;
      expect(item.outcome).to.equal("committed");
      expect(item.nodes).to.deep.equal({ a: { vote: true, sig: "sig-a" }, b: { vote: false } });
      expect(item.attestation.umid).to.equal("u1");
      expect(item.revsOut).to.deep.equal(item.attestation.revsOut);
      await api.attest("u1");
      expect(signs).to.have.length(1);
    });

    it("prefers a stored attestation from before this was lazy", async () => {
      const { api, events, signs } = await setup();
      events.put({ _id: "attest:u1", node: "old", umid: "u1", outcome: "committed", revsOut: {}, umidDocHash: "d", sig: "stored", nodes: {} });
      expect((await api.attest("u1")).sig).to.equal("stored");
      expect(signs).to.have.length(0);
    });

    it("has nothing to give for a commit without facts, or where this node cannot sign", async () => {
      const bare = await setup();
      bare.events.docs.set(`umid:${MS},u1`, { _id: `umid:${MS},u1` });
      expect(await bare.api.attest("u1")).to.equal(undefined);
      expect(await (await setup(false)).api.attest("u1")).to.equal(undefined);
    });
  });
});
