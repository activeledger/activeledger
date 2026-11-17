import { expect } from "chai";
import "mocha";
import { Storage, killAll, startStorage } from "./cov-storage-harness";

/**
 * POST /<db>/_prune on the storage process itself: what it refuses, that it
 * never makes a database, and that a page removes what the request says.
 */
describe("Storage process: POST /<db>/_prune (selfhost)", function () {
  this.timeout(60000);
  let s: Storage;
  const T = Date.now() - 40 * 86400e3; // 40 days ago
  const cutoff = Date.now() - 30 * 86400e3;
  let counter = 0;

  before(async () => {
    s = await startStorage(["level"]);
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
    killAll();
  });

  const makeDb = async (rows: string[]) => {
    // A database is made by the first write to it
    const db = `activeledgerprune${++counter}`;
    const w = await s.req("POST", `/${db}/_bulk_docs`, { docs: [{ _id: "seed", v: 1 }, ...rows.map((_id) => ({ _id, v: 1 }))], options: { new_edits: true } });
    expect(w.json.ok).to.equal(true);
    return db;
  };
  const ids = async (db: string) =>
    (await s.req("GET", `/${db}/_all_docs`)).json.rows.map((r: any) => r.id).filter((id: string) => id !== "seed").sort();

  it("removes the rows the request names, and reports a page", async () => {
    const db = await makeDb([`umid:${T},a`, `umid:${T + 1},b`, `umid:${Date.now()},new`, `fail:${T},keep`]);
    const r = await s.req("POST", `/${db}/_prune`, { kind: "umid", before: cutoff });
    expect(r.status).to.equal(200);
    expect(r.json).to.deep.include({ removed: 2, done: true });
    expect((await ids(db)).filter((id: string) => id.startsWith("umid:")).length).to.equal(1);
    expect(await ids(db)).to.include(`fail:${T},keep`);
  });

  it("pages when told a limit", async () => {
    const db = await makeDb(Array.from({ length: 6 }, (_, i) => `event:${T + i}-1,e${i}`));
    const first = await s.req("POST", `/${db}/_prune`, { kind: "event", before: cutoff, limit: 4 });
    expect(first.json).to.deep.include({ removed: 4, done: false });
    const second = await s.req("POST", `/${db}/_prune`, { kind: "event", before: cutoff, limit: 4, after: first.json.next });
    expect(second.json).to.deep.include({ removed: 2, done: true });
    expect(await ids(db)).to.deep.equal([]);
  });

  it("counts and changes nothing in a dry run", async () => {
    const db = await makeDb([`umid:${T},a`, `umid:${T + 1},b`]);
    const r = await s.req("POST", `/${db}/_prune`, { kind: "umid", before: cutoff, dryRun: true });
    expect(r.json).to.deep.include({ removed: 2, done: true });
    expect((await ids(db)).length).to.equal(2);
  });

  it("refuses a request that is not usable, with a reason", async () => {
    const db = await makeDb([]);
    for (const body of [{}, { kind: "ledger", before: cutoff }, { kind: "umid", before: "x" }, { kind: "umid", before: cutoff, limit: 0 }]) {
      const r = await s.req("POST", `/${db}/_prune`, body);
      expect(r.status, JSON.stringify(body)).to.equal(400);
      expect(r.json.error).to.be.a("string");
    }
  });

  it("refuses a cutoff newer than an hour ago", async () => {
    const db = await makeDb([`umid:${Date.now() - 1000},recent`]);
    const r = await s.req("POST", `/${db}/_prune`, { kind: "umid", before: Date.now() });
    expect(r.status).to.equal(400);
    expect(r.json.error).to.contain("an hour ago");
    expect((await ids(db)).length).to.equal(1);
  });

  it("does not make a database that is not there", async () => {
    const r = await s.req("POST", `/nosuchdb/_prune`, { kind: "umid", before: cutoff });
    expect(r.status).to.equal(404);
    expect((await s.req("GET", "/_all_dbs")).json).to.not.include("nosuchdb");
  });

  it("refuses a database name that is not a plain name", async () => {
    const r = await s.req("POST", `/..%2Fother/_prune`, { kind: "umid", before: cutoff });
    expect([400, 404]).to.include(r.status);
  });
});
