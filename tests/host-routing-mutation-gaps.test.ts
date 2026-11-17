import { expect } from "chai";
import "mocha";
import { Host } from "../packages/network/src/network/host";
import { Home } from "../packages/network/src/network/home";
import { Locker } from "../packages/network/src/network/locker";
import { voteOnlyRecord } from "../packages/network/src/network/voteonly";
import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * What a mutation pass over the host's lock queue and pending map found
 * nothing checking: the exact wait budget, retry counting on the internal
 * queue, where a new entry goes relative to the queue, and the bookkeeping
 * done when a transaction is torn down.
 */
describe("Host queue and pending map - mutation gaps (Activeledger)", () => {
  const realRef = Home.reference;
  const realNow = Date.now;
  const claimed: string[] = [];
  const S = (name: string) => name.padEnd(64, "-");

  beforeEach(() => {
    Home.reference = "me";
  });
  afterEach(() => {
    Home.reference = realRef;
    Date.now = realNow;
    ActiveOptions.set("queue_retry", 0);
    while (claimed.length) {
      const umid = claimed.pop()!;
      for (const key of Object.keys(Locker.getLocks())) Locker.release(key, umid);
    }
  });

  const entry = (umid: string, over: any = {}): any => ({
    $umid: umid,
    $tx: { $i: { [S(`in-${umid}`)]: {} }, $o: { [S(`out-${umid}`)]: {} } },
    ...over,
  });

  const makeHost = (over: any = {}): any => {
    const sent: any[] = [];
    const robin = { pid: 4242, sent, send: (m: any) => sent.push(m) } as any;
    const host = Object.create(Host.prototype);
    Object.assign(
      host,
      {
        reference: "me",
        processors: [robin],
        processorIterator: [robin][Symbol.iterator](),
        processPending: {},
        busyLocksQueue: { internal: [], external: [] },
        processingBLQ: false,
        neighbourhood: { get: () => ({}), keys: () => [] },
        robin,
      },
      over
    );
    return host;
  };

  const addPending = (host: any, e: any) => {
    const calls = { resolved: [] as any[], rejected: [] as any[] };
    host.processPending[e.$umid] = {
      entry: e,
      resolve: (r: any) => calls.resolved.push(r),
      reject: (r: any) => calls.rejected.push(r),
      pid: 0,
      finished: false,
      responded: false,
    };
    return calls;
  };

  const blocked = (umid: string, over: any = {}) => {
    Locker.hold([S(`in-${umid}`)], "owner");
    claimed.push("owner");
    return entry(umid, { $tx: { $i: { [S(`in-${umid}`)]: {} }, $o: {} }, ...over });
  };

  describe("the wait budget", () => {
    const budget = Number(process.env.AL_QUEUE_MAX_WAIT_MS || 7_000);

    it("still waits at exactly the budget and gives up one millisecond past it", () => {
      const host = makeHost();
      const e = blocked("edge");
      const calls = addPending(host, e);
      Date.now = () => 1_000_000;

      expect(host.hold(e, 3, 1_000_000 - budget)).to.equal(false);
      expect(calls.rejected).to.have.length(0);

      expect(host.hold(e, 3, 1_000_000 - budget - 1)).to.equal(true);
      expect(calls.rejected).to.have.length(1);
    });
  });

  describe("processQueue", () => {
    it("counts the retries of an internal entry as well", () => {
      const host = makeHost();
      const e = blocked("int-retry", { $revs: {} });
      addPending(host, e);
      const queued = { running: false, entry: e, retry: 1, queuedAt: Date.now() };
      host.busyLocksQueue.internal.push(queued);

      host.processQueue();
      // a second scan is only made once the minimum gap between scans has passed
      host.lastQueueScan = 0;
      host.processQueue();

      expect(queued.retry).to.equal(3);
      expect(host.busyLocksQueue.internal).to.deep.equal([queued]);
    });

    it("puts a new external entry after what was already waiting", () => {
      const host = makeHost();
      const waiting = entry("waits");
      addPending(host, waiting);
      host.busyLocksQueue.external.push({ running: false, entry: waiting, retry: 1, queuedAt: Date.now() });
      const next = entry("arrives");
      addPending(host, next);
      claimed.push("waits", "arrives");

      host.processQueue(next);

      expect(host.robin.sent.map((m: any) => m.entry.$umid)).to.deep.equal(["waits", "arrives"]);
    });

    it("puts a new internal entry before the external queue", () => {
      const host = makeHost();
      const waiting = entry("ext-waits");
      addPending(host, waiting);
      host.busyLocksQueue.external.push({ running: false, entry: waiting, retry: 1, queuedAt: Date.now() });
      const next = entry("int-arrives", { $revs: {} });
      addPending(host, next);
      claimed.push("ext-waits", "int-arrives");

      host.processQueue(next, true);

      expect(host.robin.sent.map((m: any) => m.entry.$umid)).to.deep.equal(["int-arrives", "ext-waits"]);
    });

    it("is marked as running while it works through the queue", () => {
      const host = makeHost();
      const seen: boolean[] = [];
      host.hold = () => (seen.push(host.processingBLQ), true);
      host.busyLocksQueue.external.push({ running: false, entry: entry("busy-flag"), retry: 1, queuedAt: Date.now() });
      host.processQueue();
      expect(seen).to.deep.equal([true]);
      expect(host.processingBLQ).to.equal(false);
    });

    it("run for an internal call with nothing new does not try to hold anything", () => {
      const host = makeHost();
      expect(() => host.processQueue(undefined, true)).to.not.throw();
      expect(host.robin.sent).to.have.length(0);
    });
  });

  describe("keeping only this node's vote", () => {
    it("does nothing for a umid it does not know", () => {
      const host = makeHost();
      expect(() => host.keepVoteOnly("nobody")).to.not.throw();
      expect(host.processPending).to.deep.equal({});
    });

    it("does not rebuild a record that is already vote only", () => {
      const host = makeHost();
      const record = voteOnlyRecord("u1", entry("u1"), "me", 7);
      host.processPending.u1 = record;
      host.keepVoteOnly("u1");
      expect(host.processPending.u1).to.equal(record);
    });

    it("keeps the processor and token of the record it replaces", () => {
      const host = makeHost();
      host.processPending.u2 = { entry: entry("u2"), pid: 9, token: "t", voteOnly: false };
      host.keepVoteOnly("u2");
      expect(host.processPending.u2.voteOnly).to.equal(true);
      expect(host.processPending.u2.pid).to.equal(9);
      expect(host.processPending.u2.token).to.equal("t");
    });
  });

  describe("destroy", () => {
    it("marks the transaction as shut down so its broadcast can stop", () => {
      const host = makeHost();
      host.findProcessor = () => undefined;
      const rec: any = { entry: entry("d1"), pid: 1 };
      host.processPending.d1 = rec;
      host.destroy("d1", true);
      expect(rec.shutdown).to.equal(true);
    });
  });
});
