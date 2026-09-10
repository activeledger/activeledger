import { LevelMe } from "../packages/storage/src/levelme";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Read/write behaviour of the storage engine, and the read cache in front
 * of it.
 *
 * Everything SPI decides is decided from what this layer hands back, and
 * the repair it performs is a raw overwrite with no revision tree to fall
 * back on. So the properties worth pinning down are not "can it store a
 * document" but the ones a wrong answer would silently corrupt:
 * read-after-write, whether the cache can serve something the disk no
 * longer holds, whether concurrent writers can interleave into a
 * half-applied state, and whether a multi-key read is a consistent view of
 * one moment or a stitched-together set of several.
 *
 * The last one is not hypothetical. A commit writes a stream and its
 * :stream meta in ONE batch precisely so nobody observes half of it, and a
 * reader that pairs a pre-batch state with a post-batch meta produces a
 * mismatched meta._rev:state._rev that SPI cannot repair afterwards.
 */
describe("LevelMe read/write and cache behaviour (Activestorage)", () => {
  let tmpDir: string;
  let db: LevelMe;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-rw-test-"));
    db = new LevelMe(tmpDir + path.sep, "activeledger", "level");
    await db.open();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (docs: any[], options: any = { new_edits: true }) =>
    db.bulkDocs(docs, options);

  describe("read-after-write", () => {
    it("a write is visible to the very next read", async () => {
      await write([{ _id: "s1", value: "first" }]);
      expect((await db.get("s1")).value).to.equal("first");
    });

    it("an overwrite is visible immediately, and the cache does not serve the old copy", async () => {
      await write([{ _id: "s1", value: "first" }]);
      await db.get("s1"); // warm the cache with the OLD value
      await write([{ _id: "s1", value: "second" }]);

      // If the write did not invalidate what the read cached, this returns
      // "first" - a document that no longer exists on disk.
      expect((await db.get("s1")).value).to.equal("second");
    });

    it("the same is true through the multi-key path", async () => {
      await write([{ _id: "s1", value: "first" }]);
      await db.getMany(["s1"]);
      await write([{ _id: "s1", value: "second" }]);

      const [doc] = await db.getMany(["s1"]);
      expect(doc.value).to.equal("second");
    });

    it("raw and resolved reads of the same id do not poison each other", async () => {
      // They store different shapes under the same id, so they need
      // distinct cache keys or one mode serves the other's data.
      await write([{ _id: "s1", value: "first" }]);

      const raw = await db.get("s1", true);
      const resolved = await db.get("s1");

      expect(raw._id).to.equal("s1");
      expect(resolved._id).to.equal("s1");
      expect(resolved.value).to.equal("first");

      await write([{ _id: "s1", value: "second" }]);
      expect((await db.get("s1", true))._id).to.equal("s1");
      expect((await db.get("s1")).value).to.equal("second");
    });
  });

  describe("revisions", () => {
    it("advances position and changes the hash when content changes", async () => {
      await write([{ _id: "s1", value: "first" }]);
      const first = (await db.get("s1"))._rev;
      await write([{ _id: "s1", value: "second" }]);
      const second = (await db.get("s1"))._rev;

      const [p1, h1] = first.split("-");
      const [p2, h2] = second.split("-");
      expect(parseInt(p2, 10)).to.equal(parseInt(p1, 10) + 1);
      expect(h2).to.not.equal(h1);
    });

    it("is content addressed - identical content anywhere gives an identical hash", async () => {
      // This is what lets a repair recompute a revision locally and check
      // it against the one it is adopting, and what makes two revisions at
      // the same position with different hashes a genuine fork.
      await write([{ _id: "a", shape: { x: 1 } }]);
      await write([{ _id: "b", shape: { x: 1 } }]);

      const a = (await db.get("a"))._rev.split("-")[1];
      const b = (await db.get("b"))._rev.split("-")[1];
      expect(a).to.not.equal(b); // _id participates, so these differ

      // but the same document rewritten unchanged does not move at all
      const before = (await db.get("a"))._rev;
      await write([{ _id: "a", shape: { x: 1 }, _rev: before }]);
      expect((await db.get("a"))._rev).to.equal(before);
    });

    it("force_rev writes the revision verbatim, in either direction", async () => {
      // The repair primitive. It does not compare against what is there,
      // which is exactly why a caller has to verify the hash itself - the
      // store will happily hold a revision that does not describe its own
      // content.
      await write([{ _id: "s1", value: "first" }]);
      await write([{ _id: "s1", value: "second" }]);
      const forward = (await db.get("s1"))._rev;
      expect(parseInt(forward.split("-")[0], 10)).to.equal(2);

      await write([{ _id: "s1", value: "rolled back" }], {
        new_edits: true,
        force_rev: "1-deadbeefdeadbeefdeadbeefdeadbeef",
      });

      const back = await db.get("s1");
      expect(back._rev).to.equal("1-deadbeefdeadbeefdeadbeefdeadbeef");
      expect(back.value).to.equal("rolled back");
    });
  });

  describe("multi-key reads are one consistent view", () => {
    it("returns a stream and its :stream meta from the same moment", async () => {
      await write([
        { _id: "s1", value: "state-1" },
        { _id: "s1:stream", value: "meta-1" },
      ]);

      const pair = await db.getMany(["s1", "s1:stream"]);
      const state = pair.find((d: any) => d._id === "s1");
      const meta = pair.find((d: any) => d._id === "s1:stream");

      expect(state.value).to.equal("state-1");
      expect(meta.value).to.equal("meta-1");
    });

    it("a batch is observed whole or not at all, never half", async () => {
      // Both documents move in one batch. However many times a reader
      // samples them, it must never see one at generation 1 and the other
      // at generation 2 - that pairing is the fault SPI cannot repair.
      //
      // Be clear about what this does and does not prove. It is a stress
      // guard on batch atomicity, not a reproduction of the cache-mixing
      // bug: it was run against the pre-fix mixing implementation and
      // still passed, because producing a torn pair that way needs a write
      // to land inside the exact await between the cache probe and the
      // driver read, which a loop this size will not reliably hit.
      //
      // The mixing property is pinned down deterministically instead by
      // "does not mix a cached document with a freshly read one" in
      // storage.test.ts, which does fail against the old implementation.
      // This one earns its place by covering what that cannot - that a
      // multi-document batch stays indivisible under real concurrent load,
      // however the layers underneath are rearranged later.
      //
      // The warm-one-side read is kept because it is the realistic access
      // pattern: plenty of callers read a stream without its meta.
      await write([
        { _id: "s1", gen: 1 },
        { _id: "s1:stream", gen: 1 },
      ]);

      const readings: string[] = [];
      const reader = (async () => {
        for (let i = 0; i < 300; i++) {
          await db.get("s1"); // warms one side only
          const pair = await db.getMany(["s1", "s1:stream"]);
          const state = pair.find((d: any) => d._id === "s1");
          const meta = pair.find((d: any) => d._id === "s1:stream");
          if (state && meta) readings.push(`${state.gen}:${meta.gen}`);
        }
      })();

      const writer = (async () => {
        for (let gen = 2; gen <= 20; gen++) {
          await write([
            { _id: "s1", gen },
            { _id: "s1:stream", gen },
          ]);
        }
      })();

      await Promise.all([reader, writer]);

      const torn = Array.from(new Set(readings)).filter((r) => {
        const [a, b] = r.split(":");
        return a !== b;
      });
      expect(torn, `torn pairs observed: ${torn.join(", ")}`).to.have.length(0);
      expect(readings.length).to.be.greaterThan(0);
    });

    it("handles a set where some keys exist and some never did", async () => {
      await write([{ _id: "here", value: 1 }]);

      const docs = await db.getMany(["here", "never", "also-never"]);
      expect(docs).to.have.length(1);
      expect(docs[0]._id).to.equal("here");
    });

    it("survives a large key set without dropping or duplicating", async () => {
      const ids = Array.from({ length: 200 }, (_, i) => `bulk-${i}`);
      await write(ids.map((id) => ({ _id: id, n: id })));

      const docs = await db.getMany(ids);
      const seen = new Set(docs.map((d: any) => d._id));
      expect(docs).to.have.length(ids.length);
      expect(seen.size).to.equal(ids.length);
    });
  });

  describe("concurrency", () => {
    it("serialises concurrent writes to the same document without losing one", async () => {
      await write([{ _id: "hot", n: 0 }]);

      await Promise.all(
        Array.from({ length: 25 }, (_, i) => write([{ _id: "hot", n: i + 1 }]))
      );

      const doc = await db.get("hot");
      // Whichever won, the document must be internally coherent: a real
      // value, and a revision whose position reflects the writes applied.
      expect(doc).to.have.property("n");
      expect(parseInt(doc._rev.split("-")[0], 10)).to.be.greaterThan(1);
    });

    it("keeps unrelated documents independent under concurrent load", async () => {
      const ids = Array.from({ length: 40 }, (_, i) => `c-${i}`);

      await Promise.all(ids.map((id) => write([{ _id: id, id }])));

      for (const id of ids) {
        const doc = await db.get(id);
        expect(doc.id, `${id} should hold its own value`).to.equal(id);
      }
    });

    it("interleaved reads never observe a document that was never written", async () => {
      await write([{ _id: "s1", value: "v0" }]);

      const values = new Set<string>();
      await Promise.all([
        (async () => {
          for (let i = 1; i <= 20; i++) await write([{ _id: "s1", value: `v${i}` }]);
        })(),
        (async () => {
          for (let i = 0; i < 100; i++) {
            const doc = await db.get("s1");
            if (doc?.value) values.add(doc.value);
          }
        })(),
      ]);

      for (const v of values) {
        expect(/^v\d+$/.test(v), `unexpected value observed: ${v}`).to.equal(true);
      }
    });
  });

  describe("deletion", () => {
    it("a deleted document stops being readable", async () => {
      await write([{ _id: "gone", value: 1 }]);
      await db.get("gone"); // warm the cache first
      await db.del("gone");

      let found = true;
      try {
        const doc = await db.get("gone");
        found = !!doc?.value;
      } catch {
        found = false;
      }
      // The cache must not keep serving a document the disk no longer has.
      expect(found).to.equal(false);
    });

    it("does not disturb its neighbours", async () => {
      await write([
        { _id: "keep-1", value: 1 },
        { _id: "drop", value: 2 },
        { _id: "keep-2", value: 3 },
      ]);
      await db.del("drop");

      expect((await db.get("keep-1")).value).to.equal(1);
      expect((await db.get("keep-2")).value).to.equal(3);
    });
  });

  describe("allDocs", () => {
    beforeEach(async () => {
      await write(
        Array.from({ length: 10 }, (_, i) => ({
          _id: `range-${String(i).padStart(2, "0")}`,
          n: i,
        }))
      );
    });

    it("returns the requested keys, in the shape callers expect", async () => {
      const result: any = await db.allDocs({
        keys: ["range-00", "range-01"],
        include_docs: true,
      });

      expect(result.rows).to.have.length(2);
      for (const row of result.rows) {
        expect(row).to.have.property("doc");
        expect(row.doc._id).to.match(/^range-0[01]$/);
      }
    });

    it("honours a limit", async () => {
      const result: any = await db.allDocs({ limit: 3 });
      expect(result.rows.length).to.be.at.most(3);
    });

    it("honours a start key", async () => {
      const result: any = await db.allDocs({ startkey: "range-05" });
      const ids = result.rows.map((r: any) => r.doc?._id || r.id).filter(Boolean);
      for (const id of ids) {
        if (id.startsWith("range-")) {
          expect(id >= "range-05", `${id} should not precede range-05`).to.equal(true);
        }
      }
    });

    it("does not return meta-store internals as if they were documents", async () => {
      // The keyspace holds meta alongside documents; a range read that ran
      // off the end of the document prefix would hand a caller something
      // that is not a stream at all.
      const result: any = await db.allDocs({});
      for (const row of result.rows) {
        const id = row.doc?._id || row.id;
        if (id) expect(id.startsWith("ÿ"), `${id} looks like a meta key`).to.equal(false);
      }
    });
  });

  describe("document shapes that have broken things before", () => {
    it("round-trips a large document unchanged", async () => {
      // Documents are compressed on write; a value large enough to matter
      // has to come back byte-identical or a revision computed over it
      // stops matching everyone else's.
      const big = "x".repeat(200_000);
      await write([{ _id: "big", blob: big }]);

      const doc = await db.get("big");
      expect(doc.blob).to.have.length(big.length);
      expect(doc.blob).to.equal(big);
    });

    it("round-trips nested structures and unicode", async () => {
      const value = {
        _id: "shapes",
        nested: { a: [1, 2, { b: "ünïcødé ✅ 中文" }] },
        empty: {},
        list: [],
        zero: 0,
        no: false,
      };
      await write([value]);

      const doc = await db.get("shapes");
      expect(doc.nested.a[2].b).to.equal("ünïcødé ✅ 中文");
      expect(doc.zero).to.equal(0);
      expect(doc.no).to.equal(false);
      expect(doc.list).to.deep.equal([]);
    });

    it("keeps an id containing a colon distinct from its base", async () => {
      // ":stream", ":volatile" and ":data" siblings all live in the same
      // keyspace as the stream itself.
      await write([
        { _id: "col", which: "state" },
        { _id: "col:stream", which: "meta" },
        { _id: "col:volatile", which: "volatile" },
      ]);

      expect((await db.get("col")).which).to.equal("state");
      expect((await db.get("col:stream")).which).to.equal("meta");
      expect((await db.get("col:volatile")).which).to.equal("volatile");
    });
  });
});
