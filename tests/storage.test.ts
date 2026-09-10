import { LevelMe } from "../packages/storage/src/levelme";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Regression coverage for three real bugs found and fixed on hpe-14, none of
// which were previously guarded by anything in this suite - each was only
// caught by one-off manual verification scripts during that session. See
// commits 29f6b17, ac05364, e81cd7c.
describe("LevelMe write path (Activestorage) - hpe-14 regressions", () => {
  let tmpDir: string;
  let db: LevelMe;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-storage-test-"));
    db = new LevelMe(tmpDir + path.sep, "activeledger", "level");
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getMany() cache-hit / cache-miss consistency (29f6b17)", () => {
    it("returns identical data whether a doc is freshly fetched or already cached", async () => {
      await db.bulkDocs(
        [{ _id: "streamA", name: "alpha", counter: 1 }],
        { new_edits: true }
      );

      const [miss] = await db.getMany(["streamA"]);
      const [hit] = await db.getMany(["streamA"]);

      expect(miss.name).to.equal("alpha");
      expect(hit.name).to.equal("alpha");
      expect(hit).to.equal(miss); // same reference - the two paths are now consistent
    });

    it("filters out a genuinely missing key instead of crashing the whole batch", async () => {
      await db.bulkDocs(
        [{ _id: "streamA", name: "alpha", counter: 1 }],
        { new_edits: true }
      );

      // streamA:stream deliberately doesn't exist - an optional companion doc
      const result = await db.getMany(["streamA", "streamA:stream"]);
      expect(result).to.have.length(1);
      expect(result[0].name).to.equal("alpha");
    });
  });

  describe("bulkDocs() change-event shape and error signalling (ac05364)", () => {
    it("emits one flat object per document, not an array", async () => {
      const received: any[] = [];
      db.changes().on("change", (change) => received.push(change));

      await db.bulkDocs(
        [
          { _id: "streamB", name: "beta" },
          { _id: "streamB:meta", authorities: [] },
        ],
        { new_edits: true }
      );

      expect(received).to.have.length(2);
      for (const change of received) {
        expect(Array.isArray(change)).to.equal(false);
        expect(change).to.have.property("id");
      }
    });

    it("still returns true when a change listener throws on an unrelated bug", async () => {
      db.changes().on("change", () => {
        throw new Error("unrelated listener bug");
      });

      const result = await db.bulkDocs(
        [{ _id: "streamC", name: "gamma" }],
        { new_edits: true }
      );

      expect(result).to.equal(true);

      const [readBack] = await db.getMany(["streamC"]);
      expect(readBack.name).to.equal("gamma");
    });

    it("still returns false on a genuine write failure", async () => {
      const realBatch = (db as any).driver.batch.bind((db as any).driver);
      (db as any).driver.batch = async () => {
        const chain = await realBatch();
        chain.write = async () => {
          throw new Error("simulated disk failure");
        };
        return chain;
      };

      const result = await db.bulkDocs(
        [{ _id: "streamD", name: "delta" }],
        { new_edits: true }
      );

      expect(result).to.equal(false);
    });
  });

  // The revision rules every repair path in the codebase depends on, and
  // which nothing asserted until now. SPI's rewrite, quick-restore's
  // adoptDocument and the ordinary commit path each pick a different
  // combination of these flags, and picking the wrong one does not fail -
  // it silently writes the wrong revision, which is how a node ends up
  // claiming a position the network does not agree with.
  //
  // _rev here is content addressed: `<position>-md5(JSON.stringify({...doc,
  // _rev: null}))`. There is no revision tree; a document is one key.
  describe("prepareForWrite() revision semantics", () => {
    it("refuses a new_edits:false write when the local revision differs, and leaves the document alone", async () => {
      // The gate quick-restore relies on to avoid overwriting a stream a
      // live commit may be part-way through. Nothing else in the write path
      // checks it.
      await db.bulkDocs([{ _id: "streamX", value: "original" }], {
        new_edits: true,
      });
      const stored: any = await db.get("streamX");

      let threw: Error | null = null;
      try {
        await db.bulkDocs(
          [{ _id: "streamX", _rev: "39-notthelocalrevision", value: "incoming" }],
          { new_edits: false }
        );
      } catch (error) {
        threw = error as Error;
      }

      expect(threw, "a divergent new_edits:false write must throw").to.not.equal(null);
      expect(threw!.message).to.contain("Revision Mismatch");

      // And the refusal has to be total - a partial write here is worse
      // than the write it was protecting against
      const after: any = await db.get("streamX");
      expect(after._rev).to.equal(stored._rev);
      expect(after.value).to.equal("original");
    });

    it("overwrites a divergent document when force_rev is given", async () => {
      // The only combination that can repair a stream, used by both SPI
      // rewrite sites and quick-restore's divergent branch
      await db.bulkDocs([{ _id: "streamY", value: "stale" }], {
        new_edits: true,
      });

      const written = await db.bulkDocs(
        [{ _id: "streamY", _rev: "42-networkagreed", value: "repaired" }],
        { new_edits: true, force_rev: "42-networkagreed" }
      );
      expect(written).to.equal(true);

      // Read it back rather than trusting the return - the whole reason
      // this suite exists
      const after: any = await db.get("streamY");
      expect(after._rev).to.equal("42-networkagreed");
      expect(after.value).to.equal("repaired");
    });

    it("creates a missing document at the revision it was given, with new_edits:false", async () => {
      // A restore fetching a stream this node never had must keep the
      // network's position. Minting a fresh one instead would leave the
      // node claiming position 1 for a stream everyone else holds at 39,
      // which re-diverges the thing restore was fixing.
      await db.bulkDocs([{ _id: "streamZ", _rev: "39-fromthenetwork", value: "adopted" }], {
        new_edits: false,
      });

      const after: any = await db.get("streamZ");
      expect(after._rev).to.equal("39-fromthenetwork");
    });

    it("mints a fresh 1- revision for a missing document when new_edits is true", async () => {
      // The same call with the other flag, so the distinction is pinned
      // rather than implied by the test above
      await db.bulkDocs([{ _id: "streamW", _rev: "39-fromthenetwork", value: "adopted" }], {
        new_edits: true,
      });

      const after: any = await db.get("streamW");
      expect(after._rev).to.match(/^1-/);
      expect(after._rev).to.not.equal("39-fromthenetwork");
    });

    it("does not advance the revision when a document is rewritten unchanged", async () => {
      // A no-op write must not move the position, or every redundant write
      // would desync a node from its peers. Note the round trip through
      // get() - see the test below for why re-serialising by hand does not
      // count as "unchanged".
      await db.bulkDocs([{ _id: "streamV", value: "same" }], { new_edits: true });
      const first: any = await db.get("streamV");

      await db.bulkDocs([first], { new_edits: true });
      const second: any = await db.get("streamV");

      expect(second._rev).to.equal(first._rev);
    });

    it("derives the revision from the serialisation, and must keep doing so", async () => {
      // A guard against a future tidy-up, not a warning about key order.
      //
      // _rev is md5(JSON.stringify({...doc, _rev: null})), and
      // JSON.stringify follows insertion order - so this hash is a function
      // of the serialisation rather than of the content. That is fine here:
      // nothing outside this codebase ever computes a _rev, and every node
      // builds a given document through the same contract and the same
      // streamUpdater, so the order is identical everywhere and the hashes
      // agree. Divergence makes revisions differ; differing key order does
      // not arise.
      //
      // What this test exists to catch is someone canonicalising the hash
      // later - sorting keys before stringify, say - which reads as a
      // harmless tidy-up and is not. It changes every revision computation,
      // so a patched and an unpatched node would compute different
      // revisions for the same write and diverge for the length of a
      // rolling upgrade. If that change is ever wanted it needs to be
      // deliberate and coordinated, and this test failing is how it gets
      // noticed.
      await db.bulkDocs([{ _id: "orderA", x: 1, y: 2 }], { new_edits: true });
      await db.bulkDocs([{ _id: "orderB", y: 2, x: 1 }], { new_edits: true });

      const a: any = await db.get("orderA");
      const b: any = await db.get("orderB");

      const hashOf = (rev: string) => rev.split("-")[1];
      expect(hashOf(a._rev)).to.not.equal(hashOf(b._rev));
    });
  });

  describe("post() error signalling (e81cd7c)", () => {
    it("resolves { ok: true } on success", async () => {
      const result = await db.post({ _id: "streamE", name: "epsilon" });
      expect(result.ok).to.equal(true);
      expect(result.id).to.equal("streamE");
    });

    it("does not let a change listener bug affect the result either way", async () => {
      db.changes().on("change", () => {
        throw new Error("unrelated listener bug");
      });

      const result = await db.post({ _id: "streamF", name: "zeta" });
      expect(result.ok).to.equal(true);

      const [readBack] = await db.getMany(["streamF"]);
      expect(readBack.name).to.equal("zeta");
    });

    it("rejects on a genuine write failure instead of silently reporting success", async () => {
      const realBatch = (db as any).driver.batch.bind((db as any).driver);
      (db as any).driver.batch = async () => {
        const chain = await realBatch();
        chain.write = async () => {
          throw new Error("simulated disk failure");
        };
        return chain;
      };

      let threw = false;
      try {
        await db.post({ _id: "streamG", name: "eta" });
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });
});
