import { LevelMe } from "../packages/storage/src/levelme";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * ACTIVE_STORAGE_MERGE=1 (db.selfhost.merge): a stream's state and its
 * `:stream` meta are one stored record. Every read still returns two
 * documents with the revisions they would have had stored apart.
 */
describe("LevelMe state and meta stored as one record", () => {
  let dir: string;
  let db: LevelMe;
  let previous: string | undefined;

  beforeEach(async () => {
    previous = process.env.ACTIVE_STORAGE_MERGE;
    process.env.ACTIVE_STORAGE_MERGE = "1";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "levelme-merge-"));
    db = new LevelMe(dir + path.sep, "activeledgermerge", "level");
    await db.info();
  });

  afterEach(async () => {
    await db.close();
    if (previous === undefined) delete process.env.ACTIVE_STORAGE_MERGE;
    else process.env.ACTIVE_STORAGE_MERGE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const create = () =>
    db.bulkDocsRevs(
      [{ _id: "a", v: 1 }, { _id: "a:stream", name: "x", umid: "u1" }, { _id: "a:volatile", z: 1 }, { _id: "n", k: 1 }] as any,
      { new_edits: true }
    );

  it("reads a pair back as two documents, in the order asked, skipping what is absent", async () => {
    await create();
    const got: any = await db.allDocs({ keys: ["a", "a:stream", "a:volatile", "n", "missing"] } as any);
    expect(got.rows.map((r: any) => r.doc._id)).to.deep.equal(["a", "a:stream", "a:volatile", "n"]);
    expect(JSON.stringify(got.rows[0].doc)).not.to.contain("ÿm");
  });

  it("lists a pair as two rows in a range scan", async () => {
    await create();
    const all: any = await db.allDocs({ include_docs: true } as any);
    expect(all.rows.map((r: any) => r._id).sort()).to.deep.equal(["a", "a:stream", "a:volatile", "n"]);
  });

  it("gives the revisions it would give stored apart", async () => {
    const merged = await create();
    process.env.ACTIVE_STORAGE_MERGE = "0";
    const other = new LevelMe(dir + path.sep, "activeledgerplain", "level");
    await other.info();
    const plain = await other.bulkDocsRevs(
      [{ _id: "a", v: 1 }, { _id: "a:stream", name: "x", umid: "u1" }, { _id: "a:volatile", z: 1 }, { _id: "n", k: 1 }] as any,
      { new_edits: true }
    );
    await other.close();
    expect(merged.revs).to.deep.equal(plain.revs);
  });

  it("updates both, and keeps the other when only one is written", async () => {
    await create();
    let a: any = await db.get("a");
    let m: any = await db.get("a:stream");
    await db.bulkDocsRevs([{ _id: "a", _rev: a._rev, v: 2 }, { _id: "a:stream", _rev: m._rev, name: "x", umid: "u2" }] as any, { new_edits: false });
    expect(((await db.get("a")) as any).v).to.equal(2);
    expect(((await db.get("a:stream")) as any).umid).to.equal("u2");

    a = await db.get("a");
    await db.bulkDocsRevs([{ _id: "a", _rev: a._rev, v: 3 }] as any, { new_edits: false });
    expect(((await db.get("a:stream")) as any).umid).to.equal("u2");

    m = await db.get("a:stream");
    await db.bulkDocsRevs([{ _id: "a:stream", _rev: m._rev, name: "x", umid: "u3" }] as any, { new_edits: false });
    expect(((await db.get("a")) as any).v).to.equal(3);
    expect(((await db.get("a:stream")) as any).umid).to.equal("u3");
  });

  it("refuses a stale revision", async () => {
    await create();
    let threw = false;
    try {
      await db.bulkDocsRevs([{ _id: "a", _rev: "1-bad", v: 9 }, { _id: "a:stream", _rev: "1-bad", umid: "x" }] as any, { new_edits: false });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("deleting the meta keeps the state", async () => {
    await create();
    await db.del("a:stream");
    let gone = false;
    try {
      await db.get("a:stream");
    } catch {
      gone = true;
    }
    expect(gone).to.equal(true);
    expect(((await db.get("a")) as any).v).to.equal(1);
  });

  it("stores a meta with no state under its own key", async () => {
    await db.post({ _id: "solo:stream", q: 1 } as any);
    expect(((await db.get("solo:stream")) as any).q).to.equal(1);
  });
});
