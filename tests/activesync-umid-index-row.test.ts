import { expect } from "chai";
import "mocha";
import { backfillUmid, SyncContext } from "../packages/activesync/src/umid";

/**
 * The umid index row a node adds when it adopts a umid it missed.
 *
 * The events database holds a `umid:<ms>,<umid>` row for every transaction a
 * node committed, and the `umids` / `transactions` routes list those rows so
 * a consumer can catch up from a cursor. A node that SPI repaired adopted the
 * `<umid>:umid` document but never wrote the row, so the umid was readable
 * and absent from the listing for good (restore skips umids already held).
 *
 * The row is keyed by WRITE time, like the one restore writes for a umid it
 * fetches. The events database is node-local and outside consensus, and the
 * umid document carries the transaction's own `$datetime`, so nothing is lost
 * by the key being relative to this node's writes. What a write-time key buys
 * is that a consumer cursor at the last ms always sees the late row; a
 * `$datetime` key would land behind it and be skipped.
 */

const UMID = "7b7e58dde9e3afaa7c1e0b1729c614751b7488962e7e3eb1176686589b274e89";
// A day old, so a write-time key and a $datetime key cannot be mistaken
const OLD_DATETIME = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const networkDoc = () => ({
  _id: `${UMID}:umid`,
  umid: { $umid: UMID, $datetime: OLD_DATETIME },
  events: [{ _id: `event:1,${UMID}`, name: "Moved", data: {} }],
});

function context(opts: { held?: boolean; writeFails?: boolean; rowFails?: boolean } = {}) {
  const log: string[] = [];
  const posted: any[] = [];
  const local = new Set<string>(opts.held ? [`${UMID}:umid`] : []);
  const ctx: SyncContext = {
    store: {
      get: async (id: string) => {
        if (!local.has(id)) throw new Error("not found");
        return networkDoc();
      },
      bulkDocs: async (docs: any[]) => {
        if (opts.writeFails) return {};
        for (const d of docs) local.add(d._id);
        log.push("umid doc written");
        return { ok: true };
      },
    },
    events: {
      post: async (doc: any) => {
        if (opts.rowFails && String(doc._id).startsWith("umid:")) throw new Error("events db down");
        log.push(`posted ${doc._id}`);
        posted.push(doc);
        return { ok: true };
      },
    },
    peers: { umid: async () => [networkDoc(), networkDoc()] },
  };
  return { ctx, log, posted };
}

const rows = (posted: any[]) => posted.filter((d) => String(d._id).startsWith("umid:"));

describe("backfillUmid - the umid index row for an adopted umid", () => {
  it("writes umid:<write time ms>,<umid> when it adopts a missing umid", async () => {
    const { ctx, posted } = context();
    const before = Date.now();
    expect(await backfillUmid(ctx, UMID)).to.equal(true);
    const after = Date.now();

    const found = rows(posted);
    expect(found, "exactly one index row").to.have.length(1);
    const match = /^umid:(\d+),(.+)$/.exec(found[0]._id);
    expect(match, `id shape ${found[0]._id}`).to.not.equal(null);
    expect(match![2]).to.equal(UMID);
    const ms = Number(match![1]);
    expect(ms, "keyed by write time").to.be.within(before, after);
    expect(ms, "not the transaction's old $datetime").to.not.equal(new Date(OLD_DATETIME).getTime());
    expect(Object.keys(found[0]), "the row carries only its id, as a committed one does").to.deep.equal(["_id"]);
  });

  it("writes the row only after the umid document landed", async () => {
    const { ctx, log } = context();
    await backfillUmid(ctx, UMID);
    const doc = log.indexOf("umid doc written");
    const row = log.findIndex((l) => l.startsWith("posted umid:"));
    expect(doc).to.be.greaterThan(-1);
    expect(row, "row after the document").to.be.greaterThan(doc);
  });

  it("writes no row when the umid document could not be written", async () => {
    const { ctx, posted } = context({ writeFails: true });
    expect(await backfillUmid(ctx, UMID)).to.equal(false);
    expect(rows(posted)).to.have.length(0);
  });

  it("writes no row for a umid it already holds, so a repeat pass adds no duplicate", async () => {
    const { ctx, posted } = context({ held: true });
    expect(await backfillUmid(ctx, UMID)).to.equal(true);
    expect(rows(posted)).to.have.length(0);
    // its events are still replayed, as before
    expect(posted.map((d) => d._id)).to.contain(`event:1,${UMID}`);
  });

  it("a failing row post does not undo the adoption", async () => {
    const { ctx, posted } = context({ rowFails: true });
    expect(await backfillUmid(ctx, UMID)).to.equal(true);
    expect(posted.map((d) => d._id), "events still replayed").to.contain(`event:1,${UMID}`);
  });
});
