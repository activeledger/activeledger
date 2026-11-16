import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveClone } from "@activeledger/activeutilities";
import { LevelMe } from "../packages/storage/src/levelme";

/**
 * Edges a mutation pass over storage/levelme.ts found nothing checking: a
 * user document that merely has a field named like the old rev-tree model,
 * reading a key that is not there, what the store keeps compressed, how a
 * batch with the same id twice settles, a restore taking new revisions, and
 * a change feed that must not create a database nobody asked for.
 */
describe("LevelMe - edges the tests did not pin (Activestorage)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "levelme-gaps-")) + path.sep;
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const open = (cache = false): any => new LevelMe(dir, `g${++n}`, "level", cache);
  const edit = { new_edits: true };
  const prefix = (LevelMe as any).DOC_PREFIX;

  describe("a user document that happens to have fields of the old revision-tree model", () => {
    const names = ["seq", "winningRev", "rev_map", "rev_tree"];
    // Every way of having some of the four but not all of them
    const subsets = names
      .map((_, i) => names.filter((_, j) => j !== i))
      .concat(names.map((k) => [k]));
    for (const keys of subsets) {
      it(`is read back as it was written with only ${keys.join(" + ")}`, async () => {
        const db = open();
        const doc: any = { _id: "u" };
        for (const k of keys) doc[k] = k === "seq" ? 5 : { a: 1 };
        await db.bulkDocs([doc], edit);
        const got = await db.get("u");
        for (const k of keys) expect(got[k], k).to.deep.equal(k === "seq" ? 5 : { a: 1 });
        expect(got._id).to.equal("u");
      });
    }
  });

  it("reads a batch of keys with one of them not held, returning the ones that are", async () => {
    const db = open();
    await db.bulkDocs([{ _id: "a", v: 1 }], edit);
    const got = await db.getMany(["missing", "a", "also-missing"]);
    expect(got.map((d: any) => d._id)).to.deep.equal(["a"]);
  });

  it("skips a key a driver answers with nothing, undefined or null, rather than failing the read", async () => {
    const db = open();
    await db.open();
    const doc = { _id: "a", _rev: "1-x", v: 1 };
    const held = await ActiveClone.serialize(doc, { enableCompression: true, compressionThreshold: 1000 });
    // The default driver leaves absent keys out; others leave a hole
    db.driver.getMany = async () => [undefined, held, null];
    expect(await db.getMany(["m1", "a", "m2"])).to.deep.equal([doc]);
  });

  describe("large values are kept compressed", () => {
    const big = (c: string) => c.repeat(70000);
    const stored = async (db: any, id: string) => (await db.driver.get(prefix + id)).length;

    it("when a new document is written, and when it is updated", async () => {
      const db = open();
      await db.bulkDocs([{ _id: "big", t: big("z") }], edit);
      expect(await stored(db, "big")).to.be.lessThan(5000);
      const rev = (await db.get("big"))._rev;
      await db.bulkDocs([{ _id: "big", _rev: rev, t: big("q") }], edit);
      expect(await stored(db, "big")).to.be.lessThan(5000);
      expect((await db.get("big")).t).to.equal(big("q"));
    });

    it("when written raw", async () => {
      const db = open();
      await db.writeRaw("raw", { t: big("y") });
      expect(await stored(db, "raw")).to.be.lessThan(5000);
    });
  });

  it("settles a batch naming one id twice on the first of them, every time", async () => {
    for (let i = 0; i < 5; i++) {
      const db = open();
      expect(await db.bulkDocs([{ _id: "d", v: 1 }, { _id: "d", v: 2 }], edit)).to.equal(true);
      expect((await db.get("d")).v).to.equal(1);
    }
  });

  it("gives a restored document a new revision, whatever the backup said", async () => {
    const file = path.join(dir, "backup.json");
    fs.writeFileSync(file, JSON.stringify({ _id: "r1", _rev: "7-abc", v: 1 }) + "\n");
    const db = open();
    await db.restore(file);
    const rev = (await db.get("r1"))._rev;
    expect(rev).to.match(/^1-[0-9a-f]{32}$/);
  });

  describe("the change feed", () => {
    it("does not open a database nobody has used when asked from now on", async () => {
      const db = open();
      expect(await db.changesFromSeq({ since: "now" })).to.deep.equal({ results: [], last_seq: 0 });
      expect(db.driver.isOpen()).to.equal(false);
    });

    it("opens it for any other starting point", async () => {
      const db = open();
      await db.changesFromSeq({ since: "0" });
      expect(db.driver.isOpen()).to.equal(true);
    });
  });

  it("lets two reads of a database that is still opening both succeed", async () => {
    const first = open();
    await first.bulkDocs([{ _id: "a", v: 1 }], edit);
    await first.close();
    const again: any = new LevelMe(dir, (first as any).name, "level", false);
    const [x, y] = await Promise.all([again.get("a"), again.get("a")]);
    expect([x.v, y.v]).to.deep.equal([1, 1]);
  });
});
