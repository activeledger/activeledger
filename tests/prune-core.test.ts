import { expect } from "chai";
import "mocha";
import { MAX_PAGE_LIMIT, MIN_AGE_MS, checkPruneRequest, idRange, idTime } from "../packages/storage/src/prune";

const T = 1_700_000_000_000;
const hash = "a".repeat(64);

describe("prune: reading the age of a row from its id (Activestorage)", () => {
  it("reads umid index and failure rows by their own prefix only", () => {
    expect(idTime("umid", `umid:${T},abc`)).to.equal(T);
    expect(idTime("fail", `fail:${T},abc`)).to.equal(T);
    expect(idTime("umid", `fail:${T},abc`)).to.equal(undefined);
    expect(idTime("fail", `umid:${T},abc`)).to.equal(undefined);
  });

  it("reads a contract event's time, with the counter after a dash or a comma", () => {
    expect(idTime("event", `event:${T}-3,abc`)).to.equal(T);
    expect(idTime("event", `event:${T}-123,abc`)).to.equal(T);
    expect(idTime("event", `event:${T},abc`)).to.equal(T);
  });

  it("reads an error document's time from the end of its id", () => {
    expect(idTime("error", `${hash}:${T}`)).to.equal(T);
  });

  it("does not recognise a time that is not exactly 13 digits, or anything with the wrong shape", () => {
    for (const id of [`umid:${T / 10},x`, `umid:${T * 10},x`, "umid:abc,x", "umid:,x", `umid:${T}x`, "", "plain"]) {
      expect(idTime("umid", id), id).to.equal(undefined);
    }
    expect(idTime("error", `${hash.slice(1)}:${T}`)).to.equal(undefined);
    expect(idTime("error", `${hash}:${T}:umid`)).to.equal(undefined);
    expect(idTime("error", `${hash}:umid`)).to.equal(undefined);
    expect(idTime("event", `event:${T}`)).to.equal(undefined);
  });
});

describe("prune: which ids a scan covers (Activestorage)", () => {
  it("is exactly the keys with the prefix for the time keyed kinds, in time order", () => {
    for (const [kind, prefix] of [["umid", "umid:"], ["fail", "fail:"], ["event", "event:"]] as const) {
      const r = idRange(kind);
      expect(r.ordered).to.equal(true);
      expect(r.gte).to.equal(prefix);
      expect(`${prefix}${T},x` >= r.gte && `${prefix}${T},x` < r.lt, kind).to.equal(true);
      expect(`${prefix.slice(0, -1)}x${T}` >= r.gte && `${prefix.slice(0, -1)}x${T}` < r.lt).to.equal(false);
    }
  });

  it("covers hex ids for errors and is not time ordered", () => {
    const r = idRange("error");
    expect(r.ordered).to.equal(false);
    for (const id of [`${"0".repeat(64)}:${T}`, `${"f".repeat(64)}:${T}`, `${"9".repeat(64)}:${T}`]) {
      expect(id >= r.gte && id < r.lt, id).to.equal(true);
    }
  });
});

describe("prune: checking a request before acting on it (Activestorage)", () => {
  const now = T + 10 * 86400e3;
  const good = { kind: "umid", before: T };

  it("accepts a request and fills in the defaults", () => {
    const r: any = checkPruneRequest(good, now);
    expect(r.ok).to.equal(true);
    expect(r.request).to.deep.equal({ kind: "umid", before: T, after: undefined, limit: 5000, dryRun: false, requireProcessed: true });
  });

  it("keeps what it is told: after, limit, dry run, and not requiring processed", () => {
    const r: any = checkPruneRequest({ ...good, after: "umid:1,x", limit: 10, dryRun: true, requireProcessed: false }, now);
    expect(r.request).to.deep.include({ after: "umid:1,x", limit: 10, dryRun: true, requireProcessed: false });
  });

  it("caps a page at the largest allowed", () => {
    const r: any = checkPruneRequest({ ...good, limit: MAX_PAGE_LIMIT * 10 }, now);
    expect(r.request.limit).to.equal(MAX_PAGE_LIMIT);
  });

  it("refuses what is not a usable request", () => {
    const refused = (body: unknown) => (checkPruneRequest(body, now) as any).ok === false;
    expect(refused(undefined)).to.equal(true);
    expect(refused(null)).to.equal(true);
    expect(refused("umid")).to.equal(true);
    expect(refused({ before: T })).to.equal(true);
    expect(refused({ kind: "ledger", before: T })).to.equal(true);
    expect(refused({ kind: "umid" })).to.equal(true);
    expect(refused({ kind: "umid", before: "yesterday" })).to.equal(true);
    expect(refused({ kind: "umid", before: NaN })).to.equal(true);
    expect(refused({ kind: "umid", before: Infinity })).to.equal(true);
    expect(refused({ kind: "umid", before: 0 })).to.equal(true);
    expect(refused({ kind: "umid", before: -5 })).to.equal(true);
    expect(refused({ ...good, after: 5 })).to.equal(true);
    expect(refused({ ...good, limit: 0 })).to.equal(true);
    expect(refused({ ...good, limit: 1.5 })).to.equal(true);
    expect(refused({ ...good, limit: "10" })).to.equal(true);
  });

  it("refuses a cutoff newer than an hour ago, so a mistake cannot take what is still in use", () => {
    expect((checkPruneRequest({ ...good, before: now - MIN_AGE_MS + 1 }, now) as any).ok).to.equal(false);
    expect((checkPruneRequest({ ...good, before: now - MIN_AGE_MS }, now) as any).ok).to.equal(true);
    expect((checkPruneRequest({ ...good, before: now }, now) as any).ok).to.equal(false);
  });

  it("only treats an explicit false as 'not requiring processed' and an explicit true as a dry run", () => {
    expect((checkPruneRequest({ ...good, requireProcessed: 0 }, now) as any).request.requireProcessed).to.equal(true);
    expect((checkPruneRequest({ ...good, dryRun: 1 }, now) as any).request.dryRun).to.equal(false);
  });
});
