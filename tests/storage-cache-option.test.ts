import { LevelMe } from "../packages/storage/src/levelme";
import { openEmbeddedStorage } from "../packages/storage/src/embedded";
// The same module instance LevelMe resolves, so its registry is the real one
import { ActiveCacheManager } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The storage read cache is a configuration choice (db.selfhost.cache), off
 * by default. A 70 s run on a busy node measured a ~0.5% hit rate on the
 * ledger database and a second cache, on the events database, that was
 * filled by every write and never looked up - hundreds of MB of documents
 * and timers for nothing.
 *
 * These tests pin the three things that must stay true: off unless asked
 * for, never on for the events/errors databases, and no difference in what
 * a caller gets back either way.
 *
 * Database names are unique per test because the cache registry is shared
 * by the whole mocha process.
 */
describe("Storage read cache option (Activestorage)", () => {
  let tmpDir: string;
  let counter = 0;

  const registry = () => (ActiveCacheManager as any).caches as object;
  const hasRegisteredCache = (dbName: string) =>
    `streams:${dbName}` in registry();
  const unique = (what: string) => `activeledgercacheopt${what}${++counter}`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-cacheopt-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("LevelMe", () => {
    it("has no cache unless one is asked for", async () => {
      const name = unique("off");
      const db = new LevelMe(tmpDir + path.sep, name, "level");
      await db.post({ _id: "a", n: 1 });
      await db.get("a");
      await db.getMany(["a"]);
      expect((db as any).cache).to.equal(undefined);
      expect(hasRegisteredCache(name)).to.equal(false);
      await db.close();
    });

    it("keeps and fills a cache when switched on", async () => {
      const name = unique("on");
      const db = new LevelMe(tmpDir + path.sep, name, "level", true);
      await db.post({ _id: "a", n: 1 });
      await db.get("a");
      expect(hasRegisteredCache(name)).to.equal(true);
      expect((db as any).cache.has("a")).to.equal(true);
      await db.close();
      ActiveCacheManager.fetch(`streams:${name}`).clear();
    });

    it("answers identically with the cache on and off, through every write path", async () => {
      const run = async (cache: boolean) => {
        const name = unique(cache ? "eqon" : "eqoff");
        const dir = fs.mkdtempSync(path.join(tmpDir, "d-"));
        const db = new LevelMe(dir + path.sep, name, "level", cache);
        const seen: any[] = [];
        const view = async (key: string) => {
          for (const raw of [false, true]) {
            try {
              seen.push(await db.get(key, raw));
            } catch (e: any) {
              seen.push({ missing: key, notFound: e.notFound });
            }
          }
        };

        await db.post({ _id: "p", n: 1 });
        await view("p");
        await db.post({ _id: "p", _rev: (await db.get("p"))._rev, n: 2 });
        await view("p");
        await db.bulkDocs(
          [
            { _id: "b1", n: 1 },
            { _id: "b2", n: 2 },
          ],
          { new_edits: true }
        );
        seen.push(await db.getMany(["b1", "b2"]));
        seen.push(await db.getMany(["b1", "absent"]));
        await db.writeRaw("p", { _id: "p", _rev: "9-forced", n: 3 });
        await view("p");
        await db.del("b1");
        await view("b1");
        seen.push((await db.allDocs({ include_docs: true } as any)).rows.length);
        await db.close();
        ActiveCacheManager.fetch(`streams:${name}`).clear();
        return JSON.parse(JSON.stringify(seen));
      };

      expect(await run(true)).to.deep.equal(await run(false));
    });

    it("a failed write with no cache still rejects with its own error", async () => {
      const db = new LevelMe(tmpDir + path.sep, unique("fail"), "level");
      await db.open();
      (db as any).prepareForWrite = async () => ({
        chain: {
          write: async () => {
            throw new Error("disk");
          },
        },
        changes: { id: "x", doc: {} },
        rev: "1-x",
      });
      let err: any;
      try {
        await db.post({ _id: "x" });
      } catch (e) {
        err = e;
      }
      expect(err && err.message).to.equal("disk");
      await db.close();
    });
  });

  describe("embedded storage", () => {
    const opts = (cache?: boolean) => ({
      database: unique("data"),
      event: unique("events"),
      error: unique("errors"),
      cache,
    });

    it("creates no cache for any database by default", async () => {
      const o = opts();
      const storage = await openEmbeddedStorage(tmpDir, o);
      await storage.data.level.post({ _id: "a", n: 1 });
      await storage.data.level.get("a");
      for (const n of [o.database, o.event, o.error]) {
        expect(hasRegisteredCache(n), n).to.equal(false);
      }
      await storage.close();
    });

    it("caches only the ledger database when switched on - never events or errors", async () => {
      const o = opts(true);
      const storage = await openEmbeddedStorage(tmpDir, o);
      try {
        expect((storage.data.level as any).cache, "data").to.not.equal(
          undefined
        );
        expect((storage.events.level as any).cache, "events").to.equal(
          undefined
        );
        expect((storage.errors.level as any).cache, "errors").to.equal(
          undefined
        );

        await storage.data.level.post({ _id: "a", n: 1 });
        await storage.events.level.post({ _id: "event:1", type: "x" });
        await storage.events.level.get("event:1");
        expect(hasRegisteredCache(o.event)).to.equal(false);
        expect(hasRegisteredCache(o.error)).to.equal(false);
        expect(hasRegisteredCache(o.database)).to.equal(true);
      } finally {
        await storage.close();
        ActiveCacheManager.fetch(`streams:${o.database}`).clear();
      }
    });
  });
});
