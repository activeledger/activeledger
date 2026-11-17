import { LevelMe } from "../packages/storage/src/levelme";
import { ActiveCacheManager } from "../packages/options/src/cache";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Removing rows older than a time from a node's own stores (events, errors).
 * What must hold: only what is recognised and old enough goes, nothing else
 * does, a page never runs past its limit, and a dry run changes nothing.
 */
for (const cacheOn of [false, true]) describe(`LevelMe.prune (Activestorage), read cache ${cacheOn ? "on" : "off"}`, () => {
  const DOC = "ÿdocument-storeÿ";
  const T0 = 1_700_000_000_000;
  const CUT = T0 + 500_000;
  const hash = (n: number) => n.toString(16).padStart(64, "0");

  let tmpDir: string;
  let name: string;
  let counter = 0;
  let db: LevelMe;

  const ids = async () => (await db.allDocs({})).rows.map((r: any) => r.id).sort();
  const put = (id: string, extra: object = {}) => db.post({ _id: id, ...extra } as any);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-prune-"));
    name = `levelmeprune${++counter}`;
    db = new LevelMe(tmpDir + path.sep, name, "level", cacheOn);
    await db.info();
  });
  afterEach(async () => {
    await db.close();
    ActiveCacheManager.fetch(`streams:${name}`).clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("the umid index and the events (decided by the id)", () => {
    it("removes the old rows of the kind asked for and nothing else", async () => {
      await put(`umid:${T0 + 1},u1`);
      await put(`umid:${T0 + 2},u2`);
      await put(`umid:${CUT + 5},new`);
      await put(`fail:${T0 + 1},f1`);
      await put(`event:${T0 + 1}-1,e1`);
      await put(hash(1) + ":umid");
      const page = await db.prune({ kind: "umid", before: CUT });
      expect(page).to.deep.include({ removed: 2, done: true });
      expect(await ids()).to.deep.equal(
        [`umid:${CUT + 5},new`, `fail:${T0 + 1},f1`, `event:${T0 + 1}-1,e1`, hash(1) + ":umid"].sort()
      );
    });

    it("handles failure rows and contract events by their own kind", async () => {
      await put(`fail:${T0 + 1},f1`);
      await put(`fail:${CUT + 1},f2`);
      await put(`event:${T0 + 1}-1,e1`);
      await put(`event:${T0 + 1}-12,e1`);
      await put(`event:${CUT + 1}-1,e2`);
      expect((await db.prune({ kind: "fail", before: CUT })).removed).to.equal(1);
      expect((await db.prune({ kind: "event", before: CUT })).removed).to.equal(2);
      expect(await ids()).to.deep.equal([`fail:${CUT + 1},f2`, `event:${CUT + 1}-1,e2`].sort());
    });

    it("keeps a row made at exactly the cutoff and removes one made a millisecond before", async () => {
      await put(`umid:${CUT - 1},before`);
      await put(`umid:${CUT},at`);
      await put(`umid:${CUT + 1},after`);
      await db.prune({ kind: "umid", before: CUT });
      expect(await ids()).to.deep.equal([`umid:${CUT},at`, `umid:${CUT + 1},after`].sort());
    });

    it("leaves an id it does not recognise alone, whatever its time", async () => {
      await put("umid:abc,x");
      await put(`umid:${1_000_000},short-time`);
      await put("umid:,none");
      await put(`umid:${T0 + 1}no-comma`);
      await put(`umid:${T0 + 1},ok`);
      const page = await db.prune({ kind: "umid", before: CUT });
      expect(page.removed).to.equal(1);
      expect((await ids()).length).to.equal(4);
    });

    it("stops looking at the first row that is new enough, because the rest are newer", async () => {
      await put(`umid:${T0 + 1},a`);
      await put(`umid:${T0 + 2},b`);
      await put(`umid:${CUT + 1},c`);
      await put(`umid:${CUT + 2},d`);
      await put(`umid:${CUT + 3},e`);
      const page = await db.prune({ kind: "umid", before: CUT });
      expect(page.scanned).to.equal(3);
      expect(page.kept).to.equal(1);
    });

    it("does not read the rows: a damaged value is removed all the same", async () => {
      await (db as any).driver.put(DOC + `umid:${T0 + 1},damaged`, Buffer.from([1, 2, 3]));
      const page = await db.prune({ kind: "umid", before: CUT });
      expect(page.removed).to.equal(1);
    });

    it("does nothing to an empty store", async () => {
      expect(await db.prune({ kind: "event", before: CUT })).to.deep.equal({ removed: 0, scanned: 0, kept: 0, next: undefined, done: true });
    });
  });

  describe("paging", () => {
    it("removes at most `limit` in a page, and says where to go on from", async () => {
      for (let i = 0; i < 10; i++) await put(`umid:${T0 + 10 + i},p${i}`);
      await put(`umid:${CUT + 1},new`);
      const first = await db.prune({ kind: "umid", before: CUT, limit: 4 });
      expect(first).to.deep.include({ removed: 4, done: false });
      expect(first.next).to.equal(`umid:${T0 + 13},p3`);
      const second = await db.prune({ kind: "umid", before: CUT, limit: 4, after: first.next });
      expect(second).to.deep.include({ removed: 4, done: false });
      const third = await db.prune({ kind: "umid", before: CUT, limit: 4, after: second.next });
      expect(third).to.deep.include({ removed: 2, done: true });
      expect(await ids()).to.deep.equal([`umid:${CUT + 1},new`]);
    });

    it("never repeats or skips a row across pages", async () => {
      for (let i = 0; i < 25; i++) await put(`umid:${T0 + 100 + i},q${i}`);
      let after: string | undefined;
      let total = 0;
      for (let guard = 0; guard < 20; guard++) {
        const page = await db.prune({ kind: "umid", before: CUT, limit: 7, after });
        total += page.removed;
        if (page.done) break;
        after = page.next;
      }
      expect(total).to.equal(25);
      expect(await ids()).to.deep.equal([]);
    });
  });

  describe("a dry run", () => {
    it("counts what would go and changes nothing", async () => {
      await put(`umid:${T0 + 1},a`);
      await put(`umid:${T0 + 2},b`);
      await put(`umid:${CUT + 1},c`);
      const page = await db.prune({ kind: "umid", before: CUT, dryRun: true });
      expect(page).to.deep.include({ removed: 2, done: true });
      expect((await ids()).length).to.equal(3);
    });
  });

  describe("errors (decided by the document)", () => {
    const err = (n: number, ms: number) => `${hash(n)}:${ms}`;

    it("removes old documents already processed, and keeps unprocessed and new ones", async () => {
      await put(err(1, T0 + 1), { processed: true });
      await put(err(2, T0 + 2), { processed: false });
      await put(err(3, T0 + 3), {});
      await put(err(4, CUT + 1), { processed: true });
      const page = await db.prune({ kind: "error", before: CUT });
      expect(page.removed).to.equal(1);
      expect(await ids()).to.deep.equal([err(2, T0 + 2), err(3, T0 + 3), err(4, CUT + 1)].sort());
    });

    it("removes old documents whether or not they are processed when asked (the archive)", async () => {
      await put(err(1, T0 + 1), { processed: true });
      await put(err(2, T0 + 2), { processed: false });
      await put(err(3, CUT + 1), { processed: true });
      const page = await db.prune({ kind: "error", before: CUT, requireProcessed: false });
      expect(page.removed).to.equal(2);
      expect(await ids()).to.deep.equal([err(3, CUT + 1)]);
    });

    it("leaves ids that are not an error id, and keeps looking past rows it keeps", async () => {
      await put("not-an-error-id", { processed: true });
      await put(hash(9) + ":umid", { processed: true });
      for (let i = 0; i < 6; i++) await put(err(100 + i, T0 + 10 + i), { processed: i % 2 === 0 });
      const page = await db.prune({ kind: "error", before: CUT });
      expect(page.removed).to.equal(3);
      expect(page.done).to.equal(true);
      expect((await ids()).length).to.equal(5);
    });

    it("pages through errors, counting a page's limit in removals not in rows looked at", async () => {
      for (let i = 0; i < 12; i++) await put(err(200 + i, T0 + 20 + i), { processed: i % 2 === 0 });
      const first = await db.prune({ kind: "error", before: CUT, limit: 3 });
      expect(first.removed).to.equal(3);
      expect(first.done).to.equal(false);
      let after = first.next;
      let total = first.removed;
      for (let guard = 0; guard < 10; guard++) {
        const page = await db.prune({ kind: "error", before: CUT, limit: 3, after });
        total += page.removed;
        if (page.done) break;
        after = page.next;
      }
      expect(total).to.equal(6);
    });

    it("counts a document it cannot read as one to keep", async () => {
      await (db as any).driver.put(DOC + err(300, T0 + 30), Buffer.from([1, 2, 3]));
      const page = await db.prune({ kind: "error", before: CUT });
      expect(page.removed).to.equal(0);
      expect(page.kept).to.equal(1);
    });
  });

  it("forgets a removed row it had cached", async () => {
    await put(`umid:${T0 + 1},cached`, { v: 1 });
    await db.get(`umid:${T0 + 1},cached`);
    await db.prune({ kind: "umid", before: CUT });
    let failed = false;
    try {
      await db.get(`umid:${T0 + 1},cached`);
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
  });
});
