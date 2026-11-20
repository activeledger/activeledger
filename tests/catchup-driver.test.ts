import { expect } from "chai";
import "mocha";
import {
  CatchupDriver,
  CatchupDriverDeps,
  CatchupMarker,
  CatchupResult,
  CATCHUP_DRIVER_DEFAULTS,
} from "../packages/network/src/network/catchup";

/**
 * When the catch-up runs and where it starts, with a fake clock and a fake
 * events database. It writes nothing while in sync; a marker exists only while
 * a catch-up is needed.
 */
describe("CatchupDriver (when, and from where)", () => {
  let now: number;
  let reached: boolean;
  let peers: number;
  let marker: CatchupMarker | undefined;
  let writes: string[];
  let runs: number[];
  let outcome: Partial<CatchupResult>;
  let rowsBefore: number;
  let newest: number;
  let beforeAsked: number[];
  let identity: { chain: unknown; network: string };

  const result = (over: Partial<CatchupResult> = {}): CatchupResult => ({
    scanned: 0, missing: 0, streams: 0, rewritten: 0, current: 0, undecided: 0, forks: 0,
    capped: false, unavailable: false, settled: true, ...over,
  });

  const deps = (): CatchupDriverDeps => ({
    run: async (since) => {
      runs.push(since);
      return result(outcome);
    },
    readMarker: async () => marker,
    writeMarker: async (m) => {
      writes.push("write");
      marker = m;
    },
    clearMarker: async () => {
      writes.push("clear");
      marker = undefined;
    },
    newestRowBefore: async (t) => {
      beforeAsked.push(t);
      return rowsBefore;
    },
    newestRow: async () => newest,
    peers: () => peers,
    quorumReached: () => reached,
    now: () => now,
    identity: () => identity,
  });

  beforeEach(() => {
    now = 1_000_000;
    reached = true;
    peers = 3;
    marker = undefined;
    writes = [];
    runs = [];
    outcome = {};
    rowsBefore = 900_000;
    newest = 990_000;
    beforeAsked = [];
    identity = { chain: { id: 1 }, network: "net" };
  });

  it("waits for the quorum before doing anything", async () => {
    reached = false;
    const d = new CatchupDriver(deps());
    await d.tick();
    expect(runs).to.have.length(0);
    expect(d.wanted).to.equal(true);
  });

  it("runs once at start from the newest row before the process started, and clears its marker", async () => {
    const d = new CatchupDriver(deps());
    await d.tick();
    expect(beforeAsked).to.deep.equal([1_000_000]);
    expect(runs).to.deep.equal([900_000]);
    expect(writes).to.deep.equal(["write", "clear"]);
    expect(marker).to.equal(undefined);
    expect(d.wanted).to.equal(false);
    await d.tick();
    expect(runs).to.have.length(1);
  });

  it("writes the marker before the run, so a crash during it resumes from the same point", async () => {
    let seenDuring: CatchupMarker | undefined;
    const base = deps();
    const d = new CatchupDriver({ ...base, run: async (s) => { seenDuring = marker; throw new Error("crash"); } });
    await d.tick().catch(() => undefined);
    expect(seenDuring?.since).to.equal(900_000);
    expect(marker?.since).to.equal(900_000);
    // The next process finds the marker and starts from it, not from rows its own repair wrote
    rowsBefore = 999_999;
    const second = new CatchupDriver(deps());
    await second.tick();
    expect(runs).to.deep.equal([900_000]);
    expect(beforeAsked).to.have.length(1); // not asked again
  });

  it("does nothing on a node with no neighbours", async () => {
    peers = 0;
    const d = new CatchupDriver(deps());
    await d.tick();
    expect(runs).to.have.length(0);
    expect(writes).to.have.length(0);
    expect(d.wanted).to.equal(false);
  });

  it("tries again with growing waits while a run does not settle, keeping the marker", async () => {
    outcome = { settled: false, undecided: 1 };
    const d = new CatchupDriver(deps());
    await d.tick();
    expect(runs).to.have.length(1);
    expect(marker?.since).to.equal(900_000);
    now += CATCHUP_DRIVER_DEFAULTS.retryFirst - 1;
    await d.tick();
    expect(runs).to.have.length(1);
    now += 1;
    await d.tick();
    expect(runs).to.have.length(2);
    expect(runs[1]).to.equal(900_000); // same point, from the marker
    // the wait doubles
    now += CATCHUP_DRIVER_DEFAULTS.retryFirst * 2 - 1;
    await d.tick();
    expect(runs).to.have.length(2);
    now += 1;
    await d.tick();
    expect(runs).to.have.length(3);
    outcome = {};
    now += CATCHUP_DRIVER_DEFAULTS.retryMax;
    await d.tick();
    expect(marker).to.equal(undefined);
    expect(d.wanted).to.equal(false);
  });

  it("drops the marker and stops when the gap is over the cap (a restore's job)", async () => {
    outcome = { capped: true, settled: false };
    const d = new CatchupDriver(deps());
    await d.tick();
    expect(marker).to.equal(undefined);
    expect(d.wanted).to.equal(false);
  });

  it("runs again when the quorum is regained, from the newest row before it was lost", async () => {
    const d = new CatchupDriver(deps());
    await d.tick();
    now += 60_000;
    reached = false;
    await d.tick();
    expect(d.wanted).to.equal(true);
    const lostAt = now;
    now += 120_000;
    reached = true;
    rowsBefore = 1_050_000;
    await d.tick();
    expect(beforeAsked[1]).to.equal(lostAt);
    expect(runs[1]).to.equal(1_050_000);
  });

  it("ignores a marker that is too old, or written for another chain or network", async () => {
    marker = { since: 1, chain: { id: 1 }, network: "net", written: now - CATCHUP_DRIVER_DEFAULTS.markerMaxAge - 1 };
    await new CatchupDriver(deps()).tick();
    expect(runs[0]).to.equal(900_000);

    marker = { since: 5, chain: { id: 2 }, network: "net", written: now };
    runs = [];
    await new CatchupDriver(deps()).tick();
    expect(runs[0]).to.equal(900_000);

    marker = { since: 5, chain: { id: 1 }, network: "other", written: now };
    runs = [];
    await new CatchupDriver(deps()).tick();
    expect(runs[0]).to.equal(900_000);
  });

  it("does a quiet check now and then while in sync, writing nothing", async () => {
    const d = new CatchupDriver(deps());
    await d.tick();
    writes = [];
    runs = [];
    now += CATCHUP_DRIVER_DEFAULTS.backstop - 1;
    await d.tick();
    expect(runs).to.have.length(0);
    now += 1;
    await d.tick();
    expect(runs).to.deep.equal([990_000]);
    expect(writes).to.have.length(0);
    expect(d.wanted).to.equal(false);
  });

  it("treats a quiet check that finds an unfinished gap as out of sync", async () => {
    const d = new CatchupDriver(deps());
    await d.tick();
    outcome = { settled: false, undecided: 2 };
    now += CATCHUP_DRIVER_DEFAULTS.backstop;
    await d.tick();
    expect(d.wanted).to.equal(true);
  });

  it("does not start a second tick beside one still running", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const base = deps();
    const d = new CatchupDriver({ ...base, run: async (s) => { runs.push(s); await slow; return result(); } });
    const first = d.tick();
    await new Promise((r) => setImmediate(r)); // the first is now inside run()
    await d.tick();
    expect(runs).to.have.length(1);
    release();
    await first;
  });
});
