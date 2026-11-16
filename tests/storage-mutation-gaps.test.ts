import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Cache } from "../packages/storage/src/cache";
import { EVENT_PREFIX, eventsSince } from "../packages/storage/src/events";
import { filterPrefix } from "../packages/storage/src/selfhost-helpers";
import { openEmbeddedStorage } from "../packages/storage/src/embedded";

/**
 * Edges a mutation pass over the smaller storage files found nothing
 * checking: a failed bulk write's answer, a cache entry given its own
 * lifetime, which rows an event replay keeps, and where stream ids are cut.
 */
describe("Storage - small files, edges the tests did not pin (Activestorage)", () => {
  describe("embedded store: a bulk write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-gaps-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("answers ok with the revisions, and answers not ok when the write fails", async () => {
      const store = await openEmbeddedStorage(dir);
      try {
        const done = await store.data.bulkDocs([{ _id: "a", v: 1 }], { new_edits: true });
        expect(done.ok).to.equal(true);
        expect(done.revs.a).to.equal((await store.data.get("a"))._rev);

        (store.data as any).level.bulkDocsRevs = async () => ({ ok: false, revs: {} });
        expect(await store.data.bulkDocs([{ _id: "b", v: 1 }], { new_edits: true })).to.deep.equal({ ok: false });
      } finally {
        await store.close();
      }
    });
  });

  describe("cache entries", () => {
    it("honours a lifetime of 0 for one entry instead of the cache's default", async () => {
      const cache = new Cache<string>(60000);
      cache.set("short", "x", 0);
      cache.set("long", "y");
      await new Promise((r) => setTimeout(r, 40));
      expect(cache.has("short")).to.equal(false);
      expect(cache.has("long")).to.equal(true);
      cache.delete("long");
    });
  });

  describe("event replay", () => {
    const rows = (ids: (string | undefined)[]) => ({
      allDocs: async () => ({ rows: ids.map((id) => ({ _id: id, _rev: "1-a", n: id })) }),
    });

    it("keeps only event documents strictly after the last id the client saw", async () => {
      const after = "100-1,u";
      const got = await eventsSince(
        rows([
          undefined,
          "other:1",
          `${EVENT_PREFIX}${after}`,
          `${EVENT_PREFIX}099-9,u`,
          `${EVENT_PREFIX}100-2,u`,
          `${EVENT_PREFIX}101-1,u`,
        ]) as any,
        after
      );
      expect(got.map((g) => g[0])).to.deep.equal(["100-2,u", "101-1,u"]);
      expect(got[0][1]).to.deep.equal({ n: `${EVENT_PREFIX}100-2,u` });
    });
  });

  describe("stream ids on the ledger database", () => {
    const id = (n: number) => "a".repeat(n);
    it("cuts an id longer than 64 characters to its last 64, and leaves one of exactly 64", () => {
      expect(filterPrefix(id(64))).to.equal(id(64));
      expect(filterPrefix("b" + id(64))).to.equal(id(64));
      expect(filterPrefix("b" + id(64) + ":stream")).to.equal(id(64) + ":stream");
    });
    it("leaves a 0x address and any other database alone", () => {
      const long = "0x" + id(70);
      expect(filterPrefix(long)).to.equal(long);
      expect(filterPrefix("b" + id(64), "activeledgerevents")).to.equal("b" + id(64));
    });
  });
});
