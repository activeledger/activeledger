import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";

/**
 * The lock queue is scanned (hold() on every queued entry) by every new
 * transaction and every release. Under load that fed itself: the queue grew,
 * each scan cost more, and a node stopped answering. These pin the limits on
 * how often it is scanned.
 */
describe("Host lock queue scans are limited (Activenetwork)", () => {
  const realSetTimeout = global.setTimeout;
  const realSetImmediate = global.setImmediate;
  let timers: { fn: () => void; ms: number }[];
  let immediates: (() => void)[];

  beforeEach(() => {
    timers = [];
    immediates = [];
    (global as any).setTimeout = (fn: () => void, ms: number) => (timers.push({ fn, ms }), 0 as any);
    (global as any).setImmediate = (fn: () => void) => (immediates.push(fn), 0 as any);
  });
  afterEach(() => {
    global.setTimeout = realSetTimeout;
    global.setImmediate = realSetImmediate;
  });

  const queued = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ entry: { $umid: `q${i}`, $revs: {} }, retry: 1, queuedAt: Date.now(), running: false }));

  /** A host whose hold() is recorded and always fails, so the queue stays */
  const makeHost = (internal = 3, external = 2, over: any = {}) => {
    const held: string[] = [];
    const host: any = Object.create(Host.prototype);
    Object.assign(host, {
      processingBLQ: false,
      busyLocksQueue: { internal: queued(internal), external: queued(external) },
      hold: (e: any) => (held.push(e.$umid), false),
    }, over);
    return { host, held };
  };

  it("scans the whole queue when it has not been scanned recently", () => {
    const { host, held } = makeHost();
    host.lastQueueScan = Date.now() - 1000;
    host.processQueue();
    expect(held).to.have.length(5);
  });

  it("does not scan again inside the gap, and arranges one scan for when it is due", () => {
    const { host, held } = makeHost();
    host.lastQueueScan = Date.now();
    host.processQueue();
    expect(held).to.deep.equal([]);
    expect(timers).to.have.length(1);
    expect(timers[0].ms).to.be.greaterThan(0).and.at.most(20);
    // the arranged scan runs it
    host.lastQueueScan = Date.now() - 1000;
    timers[0].fn();
    expect(held).to.have.length(5);
  });

  it("arranges only one waiting scan however many ask inside the gap", () => {
    const { host } = makeHost();
    host.lastQueueScan = Date.now();
    for (let i = 0; i < 50; i++) host.processQueue();
    expect(timers).to.have.length(1);
  });

  it("lets a new transaction try its own streams at once inside the gap, without scanning the queue", () => {
    const { host, held } = makeHost();
    host.lastQueueScan = Date.now();
    host.processQueue({ $umid: "new" } as any);
    expect(held).to.deep.equal(["new"]);
    expect(timers).to.have.length(0);
  });

  it("never holds back a node whose queue is empty", () => {
    const { host, held } = makeHost(0, 0);
    host.lastQueueScan = Date.now();
    host.processQueue({ $umid: "new" } as any);
    expect(held).to.deep.equal(["new"]);
    host.processQueue();
    expect(timers).to.have.length(0);
  });

  it("notes when a scan ran, so the next one is measured from it", () => {
    const { host } = makeHost();
    host.lastQueueScan = 0;
    const before = Date.now();
    host.processQueue();
    expect(host.lastQueueScan).to.be.at.least(before);
  });

  describe("re-checking the queue after releases", () => {
    it("waits for one re-check however many releases come before it runs", () => {
      const { host } = makeHost();
      host.scheduleQueueRecheck(50);
      host.scheduleQueueRecheck(50);
      host.scheduleQueueRecheck(50);
      expect(timers).to.have.length(1);
      expect(timers[0].ms).to.equal(50);
    });

    it("can be arranged again once it has run", () => {
      const { host, held } = makeHost();
      host.scheduleQueueRecheck(50);
      timers[0].fn();
      expect(held.length).to.be.greaterThan(0);
      host.scheduleQueueRecheck(50);
      expect(timers).to.have.length(2);
    });

    it("uses the next tick when the delay is 0", () => {
      const { host } = makeHost();
      host.scheduleQueueRecheck(0);
      expect(immediates).to.have.length(1);
      expect(timers).to.have.length(0);
    });
  });
});
