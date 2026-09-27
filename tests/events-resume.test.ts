import { LevelMe } from "../packages/storage/src/levelme";
import { eventsSince } from "../packages/storage/src/events";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Replaying events to a client that reconnects with Last-Event-ID
// (storage/src/selfhost.ts's /events handler).
describe("Event stream resume (eventsSince)", () => {
  let tmpDir: string;
  let db: LevelMe;

  const event = (id: string, name: string) => ({
    _id: `event:${id}`,
    name,
    data: { name },
    phase: "commit",
    contract: "c",
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-events-test-"));
    db = new LevelMe(tmpDir + path.sep, "activeledgerevents", "level");
    await db.open();
    await db.bulkDocs(
      [
        event("1700000000001-1,umidA", "first"),
        event("1700000000002-1,umidB", "second"),
        event("1700000000003-1,umidC", "third"),
        // Not events - must never be replayed.
        { _id: "umid:1700000000004,umidD", umid: "umidD" },
      ],
      { new_edits: true }
    );
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replays everything after an exact last event id", async () => {
    const replay = await eventsSince(db, "1700000000001-1,umidA");
    expect(replay.map(([id]) => id)).to.deep.equal([
      "1700000000002-1,umidB",
      "1700000000003-1,umidC",
    ]);
  });

  it("does not drop the first missed event when the id is not stored", async () => {
    // The old replay skipped the first row unconditionally, so resuming from
    // an id that is not itself a stored event lost "second".
    const replay = await eventsSince(db, "1700000000001-9,unknown");
    expect(replay.map(([id]) => id)).to.deep.equal([
      "1700000000002-1,umidB",
      "1700000000003-1,umidC",
    ]);
  });

  it("returns the live feed's shape: no _id or _rev, fields intact", async () => {
    const [[id, doc]] = await eventsSince(db, "1700000000002-1,umidB");
    expect(id).to.equal("1700000000003-1,umidC");
    expect(doc).to.not.have.property("_id");
    expect(doc).to.not.have.property("_rev");
    expect(doc).to.include({ name: "third", phase: "commit", contract: "c" });
  });

  it("returns nothing when the client is up to date", async () => {
    expect(await eventsSince(db, "1700000000003-1,umidC")).to.deep.equal([]);
  });

  it("never replays documents outside the event range", async () => {
    const replay = await eventsSince(db, "0");
    expect(replay.map(([id]) => id)).to.have.length(3);
  });
});
