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
