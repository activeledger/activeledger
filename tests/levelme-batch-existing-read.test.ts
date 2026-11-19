import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LevelMe } from "../packages/storage/src/levelme";

// A batch write reads the stored version of every document in it together,
// and has to treat each one exactly as a read of that document alone would.
describe("Bulk writes read what is stored in one call (Activestorage)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-read-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const open = () => new LevelMe(dir + path.sep, `r${++n}`, "level", false);

  it("updates the stored ones, creates the missing ones, in one batch", async () => {
    const db = open();
    const first = await db.bulkDocsRevs([{ _id: "a", v: 1 }, { _id: "b", v: 1 }] as any, { new_edits: true });
    const second = await db.bulkDocsRevs(
      [
        { _id: "a", _rev: first.revs.a, v: 2 },
        { _id: "new", v: 1 },
        { _id: "b", _rev: first.revs.b, v: 2 },
      ] as any,
      { new_edits: true }
    );
    expect(second.ok).to.equal(true);
    expect(second.revs.a).to.match(/^2-/);
    expect(second.revs.b).to.match(/^2-/);
    expect(second.revs.new).to.match(/^1-/);
    expect((await db.get("a")).v).to.equal(2);
    expect((await db.get("new")).v).to.equal(1);
  });

  it("still refuses a stale revision in a batch and writes none of it", async () => {
    const db = open();
    const first = await db.bulkDocsRevs([{ _id: "a", v: 1 }, { _id: "b", v: 1 }] as any, { new_edits: true });
    await db.bulkDocs([{ _id: "a", _rev: first.revs.a, v: 2 }] as any, { new_edits: true });
    const result = await db
      .bulkDocs(
        [
          { _id: "b", _rev: first.revs.b, v: 9 },
          { _id: "a", _rev: first.revs.a, v: 9 },
        ] as any,
        { new_edits: false }
      )
      .catch(() => false);
    expect(result).to.equal(false);
    expect((await db.get("a")).v).to.equal(2);
    expect((await db.get("b")).v).to.equal(1);
  });

  it("treats a repeated id in a batch as it always did", async () => {
    const db = open();
    expect(await db.bulkDocs([{ _id: "x", v: 1 }, { _id: "x", v: 2 }] as any, { new_edits: true })).to.be.a("boolean");
  });
});
