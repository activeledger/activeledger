import { LevelMe } from "../packages/storage/src/levelme";
import { ActiveClone } from "../packages/utilities/src/clone";
import { ActiveCacheManager } from "../packages/options/src/cache";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * LevelMe's less-travelled paths: the legacy rev-tree read, allDocs option
 * handling, sequence keys, backup/restore, and what happens when a value on
 * disk is damaged or a write fails part-way.
 *
 * storage.test.ts and storage-read-write.test.ts cover the ordinary read and
 * write paths. These are the places a wrong answer is quiet: a store that
 * hangs instead of rejecting on a damaged value, a read cache that outlives
 * the bytes it was built from, or a failed write that leaves half a batch.
 *
 * Every test gets its own directory AND its own database name, because the
 * read cache is shared per name across LevelMe instances in the process.
 */
describe("LevelMe store behaviour (Activestorage)", () => {
  const SEQ = "ÿby-sequenceÿ";
  const DOC = "ÿdocument-storeÿ";

  let tmpDir: string;
  let name: string;
  let counter = 0;
  let db: LevelMe;
  let closed: boolean;

  const open = (dir = tmpDir, dbName = name) =>
    new LevelMe(dir + path.sep, dbName, "level");

  // Put raw bytes straight into the underlying store, bypassing LevelMe
  const rawPut = (key: string, value: Buffer | string) =>
    (db as any).driver.put(key, value);

  const rawSeq = async (seq: number, doc: any) =>
    rawPut(
      SEQ + seq.toString().padStart(16, "0"),
      await ActiveClone.serialize(doc)
    );

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-levelme-"));
    name = `levelmestore${++counter}`;
    db = open();
    closed = false;
    await db.info();
  });

  afterEach(async () => {
    if (!closed) {
      await db.close();
    }
    ActiveCacheManager.fetch(`streams:${name}`).clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("opening, closing and reopening", () => {
    it("info() names the database", async () => {
      const info = await db.info();
      expect(info.db_name).to.equal(name);
    });

    it("keeps what was written across a close and a fresh open", async () => {
      await db.post({ _id: "durable", n: 1 });
      await db.close();
      closed = true;

      // A different instance has a different (empty) cache only if the
      // shared one is cleared, so this really reads the disk
      ActiveCacheManager.fetch(`streams:${name}`).clear();
      const again = open();
      try {
        expect((await again.get("durable")).n).to.equal(1);
      } finally {
        await again.close();
      }
    });

    it("the same instance reopens itself after close()", async () => {
      await db.post({ _id: "reopen", n: 1 });
      await db.close();
      closed = true;
      ActiveCacheManager.fetch(`streams:${name}`).clear();

      expect((await db.get("reopen")).n).to.equal(1);
      closed = false;
    });

    it("rejects, rather than hanging, when the database is locked by another instance", async () => {
      const other = open();
      let message = "";
      try {
        await other.get("anything");
      } catch (e) {
        message = String(e && (e as any).message);
      }
      expect(message).to.not.equal("");
    });

    it("recovers once the lock holder lets go", async () => {
      await db.post({ _id: "shared", n: 7 });
      const other = open();
      let failed = false;
      try {
        await other.get("shared");
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);

      // The failed open must not leave a stuck "opening" promise behind
      await db.close();
      closed = true;
      ActiveCacheManager.fetch(`streams:${name}`).clear();
      try {
        expect((await other.get("shared")).n).to.equal(7);
      } finally {
        await other.close();
      }
    });

    it("info() still answers when the database cannot be opened", async () => {
      const other = open();
      const info = await other.info();
      expect(info.db_name).to.equal(name);
    });

    it("concurrent first reads share one open", async () => {
      await db.post({ _id: "c", n: 1 });
      await db.close();
      closed = true;
      ActiveCacheManager.fetch(`streams:${name}`).clear();

      const results = await Promise.all([
        db.get("c"),
        db.get("c"),
        db.getSeq("nothing").catch(() => "miss"),
      ]);
      expect(results[0].n).to.equal(1);
      expect(results[1].n).to.equal(1);
      expect(results[2]).to.equal("miss");
      closed = false;
    });
  });

  describe("get()", () => {
    it("rejects with notFound for a missing id", async () => {
      let err: any;
      try {
        await db.get("never-written");
      } catch (e) {
        err = e;
      }
      expect(err).to.exist;
      expect(err.notFound).to.equal(true);
    });

    it("a missing id does not poison the cache for a later write", async () => {
      try {
        await db.get("late");
      } catch {
        /* expected */
      }
      await db.post({ _id: "late", n: 2 });
      expect((await db.get("late")).n).to.equal(2);
    });
  });

  describe("legacy rev-tree root documents", () => {
    const legacyRoot = (id: string, seqRef: number) => ({
      _id: id,
      _rev: "3-abc",
      winningRev: "3-abc",
      rev_map: { "3-abc": seqRef },
      rev_tree: [{ pos: 1, ids: ["abc"] }],
      seq: seqRef,
    });

    it("resolves a root document to the data document its winning revision points at", async () => {
      await rawPut(DOC + "old", await ActiveClone.serialize(legacyRoot("old", 12)));
      await rawSeq(12, { _id: "old", _rev: "3-abc", value: "resolved" });

      expect((await db.get("old")).value).to.equal("resolved");
    });

    it("get(key, true) returns the root itself, not the data document", async () => {
      await rawPut(DOC + "old", await ActiveClone.serialize(legacyRoot("old", 12)));
      await rawSeq(12, { _id: "old", _rev: "3-abc", value: "resolved" });

      const raw = await db.get("old", true);
      expect(raw.winningRev).to.equal("3-abc");
      expect(raw.value).to.equal(undefined);
    });

    it("answers an empty document when the sequence document it points at is gone", async () => {
      await rawPut(DOC + "orphan", await ActiveClone.serialize(legacyRoot("orphan", 99)));

      expect(await db.get("orphan")).to.deep.equal({});
    });

    it("leaves a current-format document alone", async () => {
      await db.post({ _id: "new", winningRev: "x", value: 1 });
      expect((await db.get("new")).value).to.equal(1);
    });
  });

  describe("allDocs()", () => {
    beforeEach(async () => {
      await db.bulkDocs(
        ["a", "b", "c", "d", "e"].map((id) => ({ _id: id, v: id })),
        { new_edits: true }
      );
    });

    const ids = (r: any) => r.rows.map((x: any) => x.id || x._id);

    it("returns ids in key order with the CouchDB row shape", async () => {
      const r: any = await db.allDocs({});
      expect(ids(r)).to.deep.equal(["a", "b", "c", "d", "e"]);
      expect(r.total_rows).to.equal(5);
      expect(r.rows[0].key).to.equal("a");
      expect(r.rows[0].value.rev).to.match(/^1-/);
    });

    it("include_docs returns the whole document", async () => {
      const r: any = await db.allDocs({ include_docs: true, limit: 1 });
      expect(r.rows[0].v).to.equal("a");
    });

    it("skip passes over leading documents and reports the offset", async () => {
      const r: any = await db.allDocs({ skip: 2 });
      expect(ids(r)).to.deep.equal(["c", "d", "e"]);
      expect(r.offset).to.equal(2);
    });

    it("skip and limit together return a window, not limit minus skip", async () => {
      const r: any = await db.allDocs({ skip: 1, limit: 2 });
      expect(ids(r)).to.deep.equal(["b", "c"]);
    });

    it("accepts skip as a string, as it arrives from a query string", async () => {
      const r: any = await db.allDocs({ skip: "1" as any, limit: 2 });
      expect(ids(r)).to.deep.equal(["b", "c"]);
      expect(r.offset).to.equal(1);
    });

    it("endkey is exclusive and startkey inclusive", async () => {
      const r: any = await db.allDocs({ startkey: "b", endkey: "d" });
      expect(ids(r)).to.deep.equal(["b", "c"]);
    });

    it("a start key past the last document gives an empty result", async () => {
      const r: any = await db.allDocs({ startkey: "zzz" });
      expect(r.rows).to.deep.equal([]);
      expect(r.total_rows).to.equal(0);
    });

    it("an empty store gives an empty result", async () => {
      const fresh = open(
        fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-levelme-empty-")),
        name + "empty"
      );
      try {
        const r: any = await fresh.allDocs({});
        expect(r.rows).to.deep.equal([]);
      } finally {
        await fresh.close();
        ActiveCacheManager.fetch(`streams:${name}empty`).clear();
        fs.rmSync((fresh as any).driver.location, { recursive: true, force: true });
      }
    });

    it("keys returns only the documents that exist, wrapped as rows", async () => {
      const r: any = await db.allDocs({ keys: ["b", "missing", "d"] });
      expect(r.rows.map((x: any) => x.doc._id)).to.deep.equal(["b", "d"]);
      expect(r.total_rows).to.equal(2);
    });

    it("rejects when the stream fails", async () => {
      const driver = (db as any).driver;
      const real = driver.createReadStream.bind(driver);
      driver.createReadStream = (o: any) => {
        const s = real(o);
        setImmediate(() => s.emit("error", new Error("read failed")));
        return s;
      };
      let message = "";
      try {
        await db.allDocs({});
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).to.equal("read failed");
    });

    it("rejects, rather than hanging, when a stored value is damaged", async () => {
      await rawPut(DOC + "bad", "this is not a document");

      let message = "";
      const outcome = await Promise.race([
        db.allDocs({}).then(
          () => "resolved",
          (e) => {
            message = String(e && e.message);
            return "rejected";
          }
        ),
        new Promise((r) => setTimeout(() => r("hung"), 1500)),
      ]);
      expect(outcome).to.equal("rejected");
      expect(message).to.not.equal("");
    });
  });

  describe("deleting", () => {
    it("del() clears both cached shapes, so neither is served afterwards", async () => {
      await db.post({ _id: "gone", n: 1 });
      await db.get("gone");
      await db.get("gone", true);

      await db.del("gone");

      for (const raw of [false, true]) {
        let err: any;
        try {
          await db.get("gone", raw);
        } catch (e) {
          err = e;
        }
        expect(err && err.notFound, `raw=${raw}`).to.equal(true);
      }
    });

    it("del() of a key that never existed is harmless", async () => {
      await db.del("nothing-here");
      await db.post({ _id: "nothing-here", n: 1 });
      expect((await db.get("nothing-here")).n).to.equal(1);
    });

    it("a document can be recreated after deletion, starting again at revision 1", async () => {
      await db.post({ _id: "again", n: 1 });
      await db.post({ _id: "again", n: 2 });
      await db.del("again");
      const r = await db.post({ _id: "again", n: 3 });
      expect(r.rev).to.match(/^1-/);
    });

    it("delSeq() removes only the sequence keys named", async () => {
      await rawSeq(1, { _id: "x", _rev: "1-a" });
      await rawSeq(2, { _id: "y", _rev: "1-b" });
      await rawSeq(3, { _id: "z", _rev: "1-c" });
      await db.post({ _id: "keepdoc", n: 1 });

      await db.delSeq(["0000000000000001", "0000000000000003"]);

      let err: any;
      try {
        await db.getSeq("0000000000000001");
      } catch (e) {
        err = e;
      }
      expect(err && err.notFound).to.equal(true);
      expect(await db.getSeq("0000000000000002")).to.be.instanceOf(Buffer);
      expect((await db.get("keepdoc")).n).to.equal(1);
    });

    it("delSeq() with no keys or unknown keys changes nothing", async () => {
      await rawSeq(5, { _id: "x", _rev: "1-a" });
      await db.delSeq([]);
      await db.delSeq(["0000000000000099"]);
      expect(await db.getSeq("0000000000000005")).to.be.instanceOf(Buffer);
    });
  });

  describe("writeRaw()", () => {
    it("stores a value that reads back as the same document", async () => {
      await db.writeRaw("rawdoc", { _id: "rawdoc", _rev: "1-x", n: 5 });
      expect((await db.get("rawdoc")).n).to.equal(5);
    });

    it("a raw overwrite replaces what an earlier read cached", async () => {
      await db.post({ _id: "swap", n: 1 });
      expect((await db.get("swap")).n).to.equal(1);
      expect((await db.get("swap", true)).n).to.equal(1);

      await db.writeRaw("swap", { _id: "swap", _rev: "9-forced", n: 2 });

      expect((await db.get("swap")).n).to.equal(2);
      expect((await db.get("swap", true)).n).to.equal(2);
    });
  });

  describe("compact()", () => {
    it("completes on a store holding data", async () => {
      await db.post({ _id: "c1", n: 1 });
      await db.compact();
      expect((await db.get("c1")).n).to.equal(1);
    });

    it("rejects when the driver cannot compact", async () => {
      const driver = (db as any).driver;
      const real = driver.compactRange;
      driver.compactRange = undefined;
      let reason: any;
      try {
        await db.compact();
      } catch (e) {
        reason = e;
      } finally {
        driver.compactRange = real;
      }
      expect(reason).to.equal("Compact Range not found");
    });

    it("rejects when the driver's compaction fails", async () => {
      const driver = (db as any).driver;
      const real = driver.compactRange;
      driver.compactRange = async () => {
        throw new Error("compaction broke");
      };
      let reason: any;
      try {
        await db.compact();
      } catch (e) {
        reason = e;
      } finally {
        driver.compactRange = real;
      }
      expect(reason.message).to.equal("compaction broke");
    });
  });

  describe("failed and interrupted writes", () => {
    const failNextWrite = () => {
      const driver = (db as any).driver;
      const realBatch = driver.batch.bind(driver);
      driver.batch = async () => {
        const chain = await realBatch();
        chain.write = async () => {
          driver.batch = realBatch;
          throw new Error("simulated disk failure");
        };
        return chain;
      };
    };

    it("a failed bulk write leaves nothing behind and the next write succeeds", async () => {
      failNextWrite();
      const ok = await db.bulkDocs(
        [
          { _id: "p", n: 1 },
          { _id: "q", n: 2 },
        ],
        { new_edits: true }
      );
      expect(ok).to.equal(false);

      expect(await db.getMany(["p", "q"])).to.deep.equal([]);

      expect(
        await db.bulkDocs([{ _id: "p", n: 1 }], { new_edits: true })
      ).to.equal(true);
      expect((await db.get("p")).n).to.equal(1);
    });

    it("a failed bulk write is not announced as a change", async () => {
      const seen: any[] = [];
      db.changes().on("change", (c) => seen.push(c));
      failNextWrite();
      await db.bulkDocs([{ _id: "silent", n: 1 }], { new_edits: true });
      expect(seen).to.deep.equal([]);
    });

    it("a failed post() does not leave a stale cached copy, and a retry lands", async () => {
      await db.post({ _id: "retry", n: 1 });
      expect((await db.get("retry")).n).to.equal(1);

      failNextWrite();
      let failed = false;
      try {
        await db.post({ _id: "retry", n: 2 });
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);
      expect((await db.get("retry")).n).to.equal(1);

      await db.post({ _id: "retry", n: 2 });
      expect((await db.get("retry")).n).to.equal(2);
    });

    it("a revision conflict part-way through a bulk write writes none of it", async () => {
      await db.post({ _id: "held", n: 1 });
      let err: Error | undefined;
      try {
        await db.bulkDocs(
          [
            { _id: "fresh", _rev: "1-x", n: 1 },
            { _id: "held", _rev: "1-wrong", n: 2 },
          ],
          { new_edits: false }
        );
      } catch (e) {
        err = e as Error;
      }
      expect(err && err.message).to.contain("Revision Mismatch");
      expect(await db.getMany(["fresh"])).to.deep.equal([]);
      expect((await db.get("held")).n).to.equal(1);
    });

    it("rejects, rather than crashing, on a damaged document it is asked to update", async () => {
      await rawPut(DOC + "damaged", "not a document");
      let rejected = false;
      try {
        await db.post({ _id: "damaged", n: 1 });
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
    });
  });

  describe("damaged values on read", () => {
    it("get() rejects for a value that is not a document", async () => {
      await rawPut(DOC + "junk", "{broken json");
      let rejected = false;
      try {
        await db.get("junk");
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
    });

    it("getMany() skips a stored value that has no _id", async () => {
      await rawPut(DOC + "noid", await ActiveClone.serialize({ x: 1 }));
      await db.post({ _id: "fine", n: 1 });
      const docs = await db.getMany(["noid", "fine"]);
      expect(docs.map((d) => d._id)).to.deep.equal(["fine"]);
    });

    it("getMany() of no keys is empty", async () => {
      expect(await db.getMany([])).to.deep.equal([]);
    });
  });

  describe("changesFromSeq()", () => {
    it('answers immediately for since="now" without touching the store', async () => {
      expect(await db.changesFromSeq({ since: "now" })).to.deep.equal({
        results: [],
        last_seq: 0,
      });
    });

    it("is empty when no sequence documents exist", async () => {
      await db.post({ _id: "doc", n: 1 });
      const r = await db.changesFromSeq({});
      expect(r.results).to.deep.equal([]);
    });

    describe("with sequence documents", () => {
      beforeEach(async () => {
        for (let i = 1; i <= 8; i++) {
          await rawSeq(i, { _id: `d${i}`, _rev: `1-h${i}`, n: i });
        }
        await db.post({ _id: "plain", n: 1 });
      });

      const seqs = (r: any) => r.results.map((x: any) => x.seq);

      it("returns sequences in order, parsed from the key, with the default limit of 5", async () => {
        const r = await db.changesFromSeq({});
        expect(seqs(r)).to.deep.equal([1, 2, 3, 4, 5]);
        expect(r.results[0]).to.deep.equal({
          id: "d1",
          seq: 1,
          changes: [{ rev: "1-h1" }],
        });
      });

      it("never returns a data document as a change", async () => {
        const r = await db.changesFromSeq({ limit: 100 });
        expect(r.results.map((x) => x.id)).to.not.include("plain");
        expect(r.results).to.have.length(8);
      });

      it("since is exclusive", async () => {
        const r = await db.changesFromSeq({ since: 3, limit: 2 });
        expect(seqs(r)).to.deep.equal([4, 5]);
      });

      it("since past the end is empty", async () => {
        expect((await db.changesFromSeq({ since: 8 })).results).to.deep.equal([]);
      });

      it("descending reverses the order", async () => {
        const r = await db.changesFromSeq({
          descending: true,
          limit: 3,
        });
        expect(seqs(r)).to.deep.equal([8, 7, 6]);
      });

      it('descending given as the string "true", as it arrives from a query string', async () => {
        const r = await db.changesFromSeq({
          descending: "true" as any,
          limit: 2,
        });
        expect(seqs(r)).to.deep.equal([8, 7]);
      });

      it("a false descending stays ascending", async () => {
        const r = await db.changesFromSeq({
          descending: false,
          limit: 2,
        });
        expect(seqs(r)).to.deep.equal([1, 2]);
      });

      it("include_docs attaches the document; otherwise it does not", async () => {
        const withDocs = await db.changesFromSeq({
          include_docs: true,
          limit: 1,
        });
        expect(withDocs.results[0].doc).to.deep.include({ _id: "d1", n: 1 });

        const without = await db.changesFromSeq({ limit: 1 });
        expect(without.results[0]).to.not.have.property("doc");
      });

      it('include_docs given as the string "false" attaches nothing', async () => {
        const r = await db.changesFromSeq({
          include_docs: "false" as any,
          limit: 1,
        });
        expect(r.results[0]).to.not.have.property("doc");
      });

      it("limit given as a string is honoured", async () => {
        const r = await db.changesFromSeq({ limit: "2" as any });
        expect(seqs(r)).to.have.length(2);
      });

      it("returns every row, in order, when the documents are large enough to be compressed", async () => {
        // Compressed values deserialize asynchronously; none may be dropped
        // or reordered because the stream ended before they finished
        for (let i = 20; i <= 24; i++) {
          await rawSeq(i, {
            _id: `big${i}`,
            _rev: `1-b${i}`,
            blob: "x".repeat(50000) + i,
          });
        }
        const raw = await (db as any).driver.get(SEQ + "0000000000000020");
        expect(raw.length).to.be.greaterThan(0);

        const r = await db.changesFromSeq({ since: 19, limit: 10, include_docs: true });
        expect(seqs(r)).to.deep.equal([20, 21, 22, 23, 24]);
        expect(r.results.map((x) => x.doc.blob.slice(-2))).to.deep.equal([
          "20", "21", "22", "23", "24",
        ]);
      });

      it("rejects when the stream fails", async () => {
        const driver = (db as any).driver;
        const real = driver.createReadStream.bind(driver);
        driver.createReadStream = (o: any) => {
          const s = real(o);
          setImmediate(() => s.emit("error", new Error("seq read failed")));
          return s;
        };
        let message = "";
        try {
          await db.changesFromSeq({});
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).to.equal("seq read failed");
      });

      it("rejects, rather than hanging, when a sequence value is damaged", async () => {
        await rawPut(SEQ + "0000000000000009", "garbage, not a document");
        const outcome = await Promise.race([
          db.changesFromSeq({ since: 8 }).then(
            () => "resolved",
            () => "rejected"
          ),
          new Promise((r) => setTimeout(() => r("hung"), 1500)),
        ]);
        expect(outcome).to.equal("rejected");
      });
    });
  });

  describe("backup() and restore()", () => {
    let file: string;

    beforeEach(() => {
      file = path.join(tmpDir, "backup.alb");
    });

    it("writes one line per stored document and removes its status marker", async () => {
      await db.bulkDocs(
        [
          { _id: "b1", n: 1 },
          { _id: "b2", n: 2 },
        ],
        { new_edits: true }
      );
      await db.backup(file);

      expect(fs.existsSync(`${file}.status`)).to.equal(false);
      const lines = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l);
      expect(lines).to.have.length(2);
      expect(lines.map((l) => JSON.parse(l)._id).sort()).to.deep.equal(["b1", "b2"]);
    });

    it("round-trips documents with newlines in them and documents large enough to be compressed", async () => {
      const awkward = { _id: "awk", text: "line one\nline two\n", blob: "y".repeat(40000) };
      await db.bulkDocs([awkward], { new_edits: true });
      await db.backup(file);

      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-levelme-restore-"));
      const target = open(dir2, name + "awk");
      try {
        await target.restore(file);
        const [doc] = await target.getMany(["awk"]);
        expect(doc.text).to.equal(awkward.text);
        expect(doc.blob).to.equal(awkward.blob);
      } finally {
        await target.close();
        ActiveCacheManager.fetch(`streams:${name}awk`).clear();
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    it("what was backed up can be restored into an empty store", async () => {
      await db.bulkDocs(
        [
          { _id: "r1", n: 1 },
          { _id: "r2", n: 2 },
        ],
        { new_edits: true }
      );
      await db.backup(file);

      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-levelme-restore-"));
      const target = open(dir2, name + "target");
      try {
        await target.restore(file);
        // restore() must not answer until every write has landed
        const docs = await target.getMany(["r1", "r2"]);
        expect(docs.map((d) => d.n).sort()).to.deep.equal([1, 2]);
        expect(fs.existsSync(`${file}.status`)).to.equal(false);
      } finally {
        await target.close();
        ActiveCacheManager.fetch(`streams:${name}target`).clear();
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    it("restore() skips a line it cannot parse and carries on", async () => {
      fs.writeFileSync(
        file,
        "not json\n" + JSON.stringify({ _id: "ok", n: 3 }) + "\n"
      );
      await db.restore(file);
      expect((await db.getMany(["ok"]))[0].n).to.equal(3);
    });

    it("restore() of a file that does not exist rejects and does not leave the store half-open", async () => {
      let rejected = false;
      try {
        await db.restore(path.join(tmpDir, "absent.alb"));
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true);
      await db.post({ _id: "after", n: 1 });
      expect((await db.get("after")).n).to.equal(1);
    });
  });
});
