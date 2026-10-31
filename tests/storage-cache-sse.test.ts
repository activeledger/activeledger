import { expect } from "chai";
import "mocha";
import { Cache, CacheManager } from "../packages/storage/src/cache";
import { HeartBeat } from "../packages/storage/src/heartbeat";
import { SSE } from "../packages/storage/src/sse";

// Timers are replaced with a manual clock so TTLs and heartbeats can be
// stepped through without waiting: nothing here uses a real timer.
describe("Storage Cache, HeartBeat and SSE (Activestorage)", () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  type Timer = { id: number; fn: () => void; ms: number; every: boolean };
  let timers: Timer[];
  let nextId: number;

  const advance = (ms: number) => {
    // Fire anything due within ms (single-shot timers are removed)
    const due = timers.filter((t) => t.ms <= ms);
    due.forEach((t) => {
      if (timers.includes(t)) {
        t.fn();
        if (!t.every) timers = timers.filter((x) => x !== t);
      }
    });
  };

  beforeEach(() => {
    timers = [];
    nextId = 1;
    (global as any).setTimeout = (fn: () => void, ms: number) => {
      const t = { id: nextId++, fn, ms, every: false };
      timers.push(t);
      return t;
    };
    (global as any).setInterval = (fn: () => void, ms: number) => {
      const t = { id: nextId++, fn, ms, every: true };
      timers.push(t);
      return t;
    };
    (global as any).clearTimeout = (t: Timer) => {
      timers = timers.filter((x) => x !== t);
    };
    (global as any).clearInterval = (global as any).clearTimeout;
  });

  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
    (global as any).clearTimeout = realClearTimeout;
    (global as any).setInterval = realSetInterval;
    (global as any).clearInterval = realClearInterval;
  });

  describe("Cache", () => {
    it("stores and returns values", () => {
      const c = new Cache<number>();
      c.set("a", 1);
      expect(c.get("a")).to.equal(1);
      expect(c.has("a")).to.equal(true);
      expect(c.size()).to.equal(1);
      expect(c.get("missing")).to.equal(undefined);
      expect(c.has("missing")).to.equal(false);
    });

    it("expires entries after the default ttl of twenty minutes", () => {
      const c = new Cache<string>();
      c.set("a", "x");
      expect(timers).to.have.length(1);
      expect(timers[0].ms).to.equal(20 * 60 * 1000);
      timers[0].fn();
      expect(c.has("a")).to.equal(false);
      expect(c.size()).to.equal(0);
    });

    it("uses the constructor ttl, and a per entry ttl over it", () => {
      const c = new Cache<string>(5000);
      c.set("a", "x");
      c.set("b", "y", 100);
      expect(timers.map((t) => t.ms)).to.deep.equal([5000, 100]);
    });

    it("restarts the timer when a key is set again", () => {
      const c = new Cache<string>(1000);
      c.set("a", "x");
      const first = timers[0];
      c.set("a", "z");
      // The old timer is cancelled, so only the new one is left
      expect(timers).to.have.length(1);
      expect(timers[0]).to.not.equal(first);
      expect(c.get("a")).to.equal("z");
    });

    it("refreshes the ttl on get when asked to extend", () => {
      const c = new Cache<string>(1000);
      c.set("a", "x");
      c.get("a");
      expect(timers.map((t) => t.ms)).to.deep.equal([1000]);
      c.get("a", 9000);
      expect(timers.map((t) => t.ms)).to.deep.equal([9000]);
      expect(c.get("nothing", 9000)).to.equal(undefined);
      expect(timers).to.have.length(1);
    });

    it("deletes an entry and its timer", () => {
      const c = new Cache<string>();
      c.set("a", "x");
      c.set("b", "y");
      c.delete("a");
      expect(c.has("a")).to.equal(false);
      expect(c.has("b")).to.equal(true);
      expect(timers).to.have.length(1);
      // Deleting something absent is harmless
      c.delete("a");
      expect(c.size()).to.equal(1);
    });

    it("clears every entry and timer", () => {
      const c = new Cache<string>();
      c.set("a", "x");
      c.set("b", "y");
      c.clear();
      expect(c.size()).to.equal(0);
      expect(timers).to.have.length(0);
    });
  });

  describe("CacheManager", () => {
    it("hands out the same cache for the same name", () => {
      const a = CacheManager.fetch("cm-same");
      a.set("k", 1);
      expect(CacheManager.fetch("cm-same")).to.equal(a);
      expect(CacheManager.fetch("cm-same").get("k")).to.equal(1);
    });

    it("keeps separate caches apart", () => {
      const a = CacheManager.fetch("cm-a");
      const b = CacheManager.fetch("cm-b");
      expect(a).to.not.equal(b);
      a.set("k", 1);
      expect(b.has("k")).to.equal(false);
    });

    it("applies the ttl only when the cache is first created", () => {
      const first = CacheManager.fetch("cm-ttl", 111);
      first.set("k", 1);
      const again = CacheManager.fetch("cm-ttl", 222);
      again.set("j", 2);
      expect(again).to.equal(first);
      expect(timers.map((t) => t.ms)).to.deep.equal([111, 111]);
    });

    it("lists every cache it has made", () => {
      const made = CacheManager.fetch("cm-listed");
      expect(CacheManager.all()).to.include(made);
    });
  });

  // The pieces of a uWebSockets response the SSE classes use
  const fakeResponse = () => {
    const res: any = {
      writable: true,
      headers: {} as any,
      status: "",
      written: [] as string[],
      corked: 0,
      aborted: undefined as undefined | (() => void),
    };
    res.cork = (fn: () => void) => {
      res.corked++;
      fn();
    };
    res.writeHeader = (k: string, v: string) => (res.headers[k] = v);
    res.writeStatus = (s: string) => (res.status = s);
    res.write = (d: string) => res.written.push(d);
    res.onAborted = (fn: () => void) => (res.aborted = fn);
    return res;
  };

  describe("HeartBeat", () => {
    it("writes a comment frame every ten minutes while the response is writable", () => {
      const res = fakeResponse();
      const beat = HeartBeat.Start(res);
      expect(timers).to.have.length(1);
      expect(timers[0].every).to.equal(true);
      expect(timers[0].ms).to.equal(10 * 60 * 1000);
      expect(res.written).to.deep.equal([]);
      advance(10 * 60 * 1000);
      advance(10 * 60 * 1000);
      expect(res.written).to.deep.equal([":\n\n", ":\n\n"]);
      expect(beat).to.equal(timers[0]);
    });

    it("writes nothing once the response is no longer writable", () => {
      const res = fakeResponse();
      HeartBeat.Start(res);
      res.writable = false;
      advance(10 * 60 * 1000);
      expect(res.written).to.deep.equal([]);
    });

    it("stops beating", () => {
      const res = fakeResponse();
      const beat = HeartBeat.Start(res);
      HeartBeat.Stop(beat);
      expect(timers).to.have.length(0);
      advance(10 * 60 * 1000);
      expect(res.written).to.deep.equal([]);
    });
  });

  describe("SSE", () => {
    it("opens an event stream response and marks the connection open", () => {
      const res = fakeResponse();
      new SSE(res);
      expect(res.headers).to.deep.equal({
        "Content-type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      expect(res.status).to.equal("200 OK");
      expect(res.written).to.deep.equal([":\n\n"]);
      // And the heartbeat is running
      expect(timers).to.have.length(1);
    });

    it("writes events with an id, event name and json data", () => {
      const res = fakeResponse();
      const sse = new SSE(res);
      expect(sse.write(7, { a: [1, "two"] })).to.equal(true);
      expect(sse.write("umid:9", "text")).to.equal(true);
      expect(res.written.slice(1)).to.deep.equal([
        'id:7\nevent: message\ndata:{"a":[1,"two"]}\n\n',
        'id:umid:9\nevent: message\ndata:"text"\n\n',
      ]);
    });

    it("stops the heartbeat and reports false when written to after disconnect", () => {
      const res = fakeResponse();
      const sse = new SSE(res);
      res.writable = false;
      const before = res.written.length;
      expect(sse.write(1, {})).to.equal(false);
      expect(res.written).to.have.length(before);
      expect(timers).to.have.length(0);
    });

    it("cleans up as soon as the client aborts", () => {
      const res = fakeResponse();
      new SSE(res);
      res.aborted!();
      expect(res.writable).to.equal(false);
      expect(timers).to.have.length(0);
    });

    it("runs the caller's disconnect callback on abort, after its own cleanup", () => {
      const res = fakeResponse();
      const sse = new SSE(res);
      const seen: any[] = [];
      sse.onDisconnect(() => seen.push([res.writable, timers.length]));
      expect(seen).to.deep.equal([]);
      res.aborted!();
      expect(seen).to.deep.equal([[false, 0]]);
    });

    it("works without a disconnect callback", () => {
      const res = fakeResponse();
      new SSE(res);
      expect(() => res.aborted!()).to.not.throw();
    });
  });
});
