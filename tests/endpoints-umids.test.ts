import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LevelMe } from "../packages/storage/src/levelme";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * The umid index a neighbour reads when catching up, and the reverse read the
 * node uses to find the newest row, against a real events database.
 */
describe("Umid index for catch-up (Endpoints.umids, allDocs descending)", () => {
  let tmp: string;
  let db: LevelMe;
  // The same call the host makes, over the real database
  const dbe: any = {
    allDocs: (options: any) => db.allDocs({ ...options }),
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-umids-test-"));
    db = new LevelMe(tmp + path.sep, "activeledgerevents", "level");
    await db.open();
    const rows: any[] = [];
    for (let i = 1; i <= 7; i++) rows.push({ _id: `umid:${1000 + i},umid${i}` });
    await db.bulkDocs(
      [
        ...rows,
        { _id: "fail:1003,failA" }, // another index in the same database
        { _id: "event:1004-1,umidX", name: "e" }, // an event
        { _id: "catchup:since", since: 5 }, // the marker
      ],
      { new_edits: true }
    );
  });
  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the rows after a time, oldest first, as { umid, timestamp }", async () => {
    const res = await Endpoints.umids(dbe, "1003", 100);
    expect(res.statusCode).to.equal(200);
    expect(res.content.rows).to.deep.equal([
      { umid: "umid3", timestamp: "1003" },
      { umid: "umid4", timestamp: "1004" },
      { umid: "umid5", timestamp: "1005" },
      { umid: "umid6", timestamp: "1006" },
      { umid: "umid7", timestamp: "1007" },
    ]);
    expect(res.content.more).to.equal(false);
  });

  it("only the umid rows: not the failure index, events or the catch-up marker", async () => {
    const res = await Endpoints.umids(dbe, "0", 100);
    expect(res.content.rows.map((r: any) => r.umid)).to.deep.equal(
      ["umid1", "umid2", "umid3", "umid4", "umid5", "umid6", "umid7"]
    );
  });

  it("pages, saying when there is more", async () => {
    const first = await Endpoints.umids(dbe, "0", 3);
    expect(first.content.rows.map((r: any) => r.umid)).to.deep.equal(["umid1", "umid2", "umid3"]);
    expect(first.content.more).to.equal(true);
    const next = await Endpoints.umids(dbe, first.content.rows[2].timestamp, 3);
    expect(next.content.rows[0].umid).to.equal("umid3"); // the same time again, the caller skips it
    expect(next.content.rows.length).to.equal(3);
    const last = await Endpoints.umids(dbe, "1007", 3);
    expect(last.content.rows.map((r: any) => r.umid)).to.deep.equal(["umid7"]);
    expect(last.content.more).to.equal(false);
  });

  it("caps the page, and takes a missing or silly limit as the cap", async () => {
    const many: any[] = [];
    for (let i = 0; i < Endpoints.UMIDS_PAGE_MAX + 5; i++) many.push({ _id: `umid:${5000 + i},m${i}` });
    await db.bulkDocs(many, { new_edits: true });
    const huge = await Endpoints.umids(dbe, "5000", 999999);
    expect(huge.content.rows).to.have.length(Endpoints.UMIDS_PAGE_MAX);
    expect(huge.content.more).to.equal(true);
    const none = await Endpoints.umids(dbe, "5000", undefined);
    expect(none.content.rows).to.have.length(Endpoints.UMIDS_PAGE_MAX);
    const negative = await Endpoints.umids(dbe, "5000", -4);
    expect(negative.content.rows.length).to.be.greaterThan(0);
  });

  it("refuses a time that is not a number", async () => {
    for (const bad of ["abc", "-1", "", "1e999"]) {
      let error: any;
      await Endpoints.umids(dbe, bad, 10).catch((e) => (error = e));
      expect(error?.statusCode, bad).to.equal(400);
    }
  });

  it("an unreadable database is a 500, not a hang", async () => {
    let error: any;
    await Endpoints.umids({ allDocs: () => Promise.reject(new Error("x")) } as any, "0", 10).catch((e) => (error = e));
    expect(error.statusCode).to.equal(500);
  });

  describe("reading the newest row (descending)", () => {
    it("gives the newest umid row, not the marker or other indexes", async () => {
      const res: any = await db.allDocs({ startkey: "umid:", endkey: "umid;", descending: true, limit: 1 });
      expect(res.rows).to.have.length(1);
      expect(res.rows[0].id).to.equal("umid:1007,umid7");
    });

    it("gives the newest row before a time", async () => {
      const res: any = await db.allDocs({ startkey: "umid:", endkey: "umid:1004", descending: true, limit: 1 });
      expect(res.rows[0].id).to.equal("umid:1003,umid3");
    });

    it("gives nothing when there is no row before", async () => {
      const res: any = await db.allDocs({ startkey: "umid:", endkey: "umid:1000", descending: true, limit: 1 });
      expect(res.rows).to.have.length(0);
    });

    it("is unchanged when descending is not asked for", async () => {
      const res: any = await db.allDocs({ startkey: "umid:", endkey: "umid;", limit: 2 });
      expect(res.rows.map((r: any) => r.id)).to.deep.equal(["umid:1001,umid1", "umid:1002,umid2"]);
    });
  });
});
