import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveChanges } from "../packages/options/src/changes";

const tick = () => new Promise((r) => setImmediate(r));

class FakeFeed extends EventEmitter {
  cancelled = 0;
  restarted = 0;
  cancel() { this.cancelled++; }
  restart() { this.restarted++; }
}

function makeDb(infoImpl: () => Promise<any> = async () => ({ update_seq: 100 })) {
  const feeds: FakeFeed[] = [];
  const opts: any[] = [];
  const db: any = {
    changes(o: any) {
      opts.push(o);
      const f = new FakeFeed();
      feeds.push(f);
      return f;
    },
    info: () => infoImpl(),
  };
  return { db, feeds, opts };
}

describe("ActiveChanges", () => {
  const realST = global.setTimeout;
  const origCwd = process.cwd();
  let tmp: string;
  let timers: Array<{ fn: () => void; ms: number }>;
  let sigtermBefore: Function[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cov-changes-"));
    process.chdir(tmp);
    timers = [];
    sigtermBefore = process.listeners("SIGTERM");
  });
  afterEach(() => {
    global.setTimeout = realST;
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const l of process.listeners("SIGTERM")) {
      if (!sigtermBefore.includes(l)) process.removeListener("SIGTERM", l as any);
    }
  });

  const fakeTimers = () => {
    (global as any).setTimeout = (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0;
    };
  };

  it("start creates a live feed with default options and re-emits changes caching seq", async () => {
    const { db, feeds, opts } = makeDb();
    const ac = new ActiveChanges("n", db);
    const seen: any[] = [];
    ac.on("change", (c) => seen.push(c));
    ac.start();
    await tick();
    expect(opts[0]).to.deep.equal({
      since: "now", live: true, include_docs: true, timeout: false, limit: 25,
    });
    feeds[0].emit("change", { seq: 9, id: "a" });
    expect(seen).to.deep.equal([{ seq: 9, id: "a" }]);
    expect((ac as any).lastSequence).to.equal(9);
  });

  it("honours custom limit and since", () => {
    const { db, opts } = makeDb();
    new ActiveChanges("n", db, 7).start(42);
    expect(opts[0].limit).to.equal(7);
    expect(opts[0].since).to.equal(42);
  });

  it("start resumes from the cached lastSequence over the given since", () => {
    const { db, opts } = makeDb();
    const ac = new ActiveChanges("n", db);
    (ac as any).lastSequence = 55;
    ac.start(3);
    expect(opts[0].since).to.equal(55);
  });

  it("a second start restarts the existing feed instead of creating another", () => {
    const { db, feeds } = makeDb();
    const ac = new ActiveChanges("n", db);
    ac.start();
    ac.start();
    expect(feeds).to.have.length(1);
    expect(feeds[0].restarted).to.equal(1);
  });

  it("pause cancels the feed; safe when no feed exists", () => {
    const { db, feeds } = makeDb();
    const ac = new ActiveChanges("n", db);
    expect(() => ac.pause()).to.not.throw();
    ac.start();
    ac.pause();
    expect(feeds[0].cancelled).to.equal(1);
  });

  it("stop clears sequence, cancels, and allows a fresh feed afterwards", () => {
    const { db, feeds, opts } = makeDb();
    const ac = new ActiveChanges("n", db);
    ac.start();
    feeds[0].emit("change", { seq: 4 });
    ac.stop();
    expect(feeds[0].cancelled).to.equal(1);
    expect((ac as any).lastSequence).to.equal(undefined);
    ac.start();
    expect(feeds).to.have.length(2);
    expect(opts[1].since).to.equal("now");
  });

  it("an error pauses the feed and schedules one restart after 1500ms; repeated errors ignored", async () => {
    const { db, feeds } = makeDb();
    const ac = new ActiveChanges("n", db);
    ac.start();
    fakeTimers();
    feeds[0].emit("error", new Error("x"));
    feeds[0].emit("error", new Error("y"));
    expect(feeds[0].cancelled).to.equal(1);
    expect(timers).to.have.length(1);
    expect(timers[0].ms).to.equal(1500);
    expect((ac as any).restarting).to.equal(true);
    // run the timer: info resolves, restarting reset, start() -> feed.restart()
    timers[0].fn();
    await tick();
    expect((ac as any).restarting).to.equal(false);
    expect(feeds[0].restarted).to.equal(1);
  });

  it("resume rewinds a lastSequence that is ahead of the datastore", async () => {
    const { db } = makeDb(async () => ({ update_seq: 10 }));
    const ac = new ActiveChanges("n", db);
    (ac as any).lastSequence = 50;
    fakeTimers();
    ac.resume();
    expect(timers[0].ms).to.equal(1500);
    timers[0].fn();
    await tick();
    expect((ac as any).lastSequence).to.equal(10);
  });

  it("resume keeps a lastSequence that is behind or equal", async () => {
    const { db } = makeDb(async () => ({ update_seq: 10 }));
    const ac = new ActiveChanges("n", db);
    (ac as any).lastSequence = 10;
    fakeTimers();
    ac.resume();
    timers[0].fn();
    await tick();
    expect((ac as any).lastSequence).to.equal(10);
  });

  it("resume does nothing while restarting unless forced", () => {
    const { db } = makeDb();
    const ac = new ActiveChanges("n", db);
    (ac as any).restarting = true;
    fakeTimers();
    ac.resume();
    expect(timers).to.have.length(0);
    ac.resume(true);
    expect(timers).to.have.length(1);
  });

  it("resume retries after 1500ms when info fails", async () => {
    let calls = 0;
    const { db, opts } = makeDb(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return { update_seq: 1 };
    });
    const ac = new ActiveChanges("n", db);
    fakeTimers();
    ac.resume();
    timers[0].fn();
    await tick();
    expect(timers).to.have.length(2);
    expect(timers[1].ms).to.equal(1500);
    expect(opts).to.have.length(0);
    timers[1].fn(); // resume(true) -> schedules another 1500
    expect(timers).to.have.length(3);
    timers[2].fn();
    await tick();
    expect(opts).to.have.length(1);
  });

  it("start records the pid into .PID preserving other fields and registers SIGTERM", async () => {
    fs.writeFileSync(".PID", JSON.stringify({ other: 1 }));
    const { db } = makeDb();
    const ac = new ActiveChanges("n", db);
    ac.start();
    await new Promise((r) => realST(r, 50));
    expect(JSON.parse(fs.readFileSync(".PID").toString())).to.deep.equal({
      other: 1, activechanges: process.pid,
    });
    expect(process.listeners("SIGTERM").length).to.equal(sigtermBefore.length + 1);
  });

  it("a missing .PID is tolerated and SIGTERM is still registered", async () => {
    const { db } = makeDb();
    const ac = new ActiveChanges("n", db);
    ac.start();
    await new Promise((r) => realST(r, 50));
    expect(fs.existsSync(".PID")).to.equal(false);
    expect(process.listeners("SIGTERM").length).to.equal(sigtermBefore.length + 1);
  });

  it("the SIGTERM handler stops the feed then exits", async () => {
    const { db, feeds } = makeDb();
    const ac = new ActiveChanges("n", db);
    ac.start();
    await new Promise((r) => realST(r, 50));
    const handler = process.listeners("SIGTERM").find((l) => !sigtermBefore.includes(l))!;
    const realExit = process.exit;
    let exited = 0;
    (process as any).exit = () => { exited++; };
    try {
      handler();
    } finally {
      process.exit = realExit;
    }
    expect(exited).to.equal(1);
    expect(feeds[0].cancelled).to.equal(1);
    expect((ac as any).dbChanges).to.equal(null);
  });
});
