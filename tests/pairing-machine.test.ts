import { expect } from "chai";
import "mocha";
import { Pairing } from "../packages/network/src/network/pairing";
import { NeighbourStatus } from "../packages/network/src/network/neighbourstatus";

// Pairing is the neighbourhood state machine. These tests run it with fake
// neighbours and a fake clock, so no sockets, no real timers and no globals:
// time moves only when a test calls tick().
describe("Pairing (state machine with an injected clock)", () => {
  let nowMs: number;
  let timers: { id: number; at: number; fn: () => void }[];
  let nextId: number;
  let networkRef: string;
  let setCalls: [string | null, string | null][];

  const clock = () => ({
    networkRef: () => networkRef,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { id: nextId++, at: nowMs + ms, fn };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    },
    now: () => nowMs,
  });

  /** Move time forward, running what falls due (and what that schedules) in order */
  const tick = async (ms: number) => {
    const end = nowMs + ms;
    for (;;) {
      // let pending knock answers settle before looking for what is due
      await new Promise((r) => setImmediate(r));
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      nowMs = due.at;
      due.fn();
      // let knock promises settle
      await new Promise((r) => setImmediate(r));
    }
    nowMs = end;
    await new Promise((r) => setImmediate(r));
  };

  /** A neighbour whose knock answers or fails as the test says */
  const peer = (reference: string, up = false): any => {
    const n: any = {
      reference,
      host: "h-" + reference,
      port: 5260,
      isHome: false,
      state: "unknown",
      graceStop: false,
      up,
      knocks: 0,
      knock() {
        n.knocks++;
        return n.up ? Promise.resolve({}) : Promise.reject(new Error("down"));
      },
      setState(state: string, reason?: string) {
        n.isHome = state === "home";
        n.state = state;
        n.reason = reason;
        return true;
      },
    };
    return n;
  };

  const homeOf = (self: string, all: any[]): any => {
    const map: any = {};
    all.forEach((n) => (map[n.reference] = n));
    return {
      reference: self,
      neighbourhood: { get: () => map, keys: () => Object.keys(map) },
      getStatus: () => NeighbourStatus.Stable,
      setNeighbours: (l: string | null, r: string | null) => setCalls.push([l, r]),
    };
  };

  const make = (self: string, peers: any[]) => {
    const me = peer(self);
    me.isHome = true;
    me.state = "home";
    const p = new Pairing(clock());
    p.init(homeOf(self, [me, ...peers]));
    return p;
  };

  beforeEach(() => {
    nowMs = 1000;
    timers = [];
    nextId = 1;
    networkRef = "net-1";
    setCalls = [];
  });

  describe("discovery poll", () => {
    it("polls every 300 ms at first, then backs off to once every 10 s", async () => {
      const p = make("a", [peer("b")]);
      const gaps: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t = timers[timers.length - 1];
        gaps.push(t.at - nowMs);
        await tick(t.at - nowMs);
      }
      expect(gaps.slice(0, 30).every((g) => g === 300)).to.equal(true);
      expect(gaps.slice(30, 36)).to.deep.equal([1000, 2000, 4000, 8000, 10000, 10000]);
      expect(p.timerActive).to.equal(true);
    });

    it("never runs two chains at once", () => {
      const p = make("a", [peer("b")]);
      const before = timers.length;
      p.healthTimer(true);
      p.healthTimer(true);
      expect(timers.length).to.equal(before);
    });

    it("stops once every configured neighbour is home, and can start again", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      b.up = true;
      await tick(300);
      expect(b.isHome).to.equal(true);
      await tick(1000);
      expect(timers.length).to.equal(0);
      expect(p.timerActive).to.equal(false);
      p.healthTimer(true);
      expect(p.timerActive).to.equal(false); // nothing left to find, stops again
    });

    it("marks a neighbour that never answered as unreachable, once", async () => {
      const b = peer("b");
      make("a", [b]);
      await tick(900);
      expect(b.state).to.equal("unreachable");
      expect(b.reason).to.equal("no answer yet");
      expect(b.knocks).to.be.greaterThan(1);
    });

    it("does not ask a neighbour that is already home", async () => {
      const b = peer("b", true);
      b.setState("home");
      const c = peer("c");
      make("a", [b, c]);
      await tick(900);
      expect(b.knocks).to.equal(0);
      expect(c.knocks).to.be.greaterThan(0);
    });
  });

  describe("pairing", () => {
    it("takes the next home neighbour on each side, wrapping round", async () => {
      const [b, c, d] = ["b", "c", "d"].map((r) => peer(r, true));
      const p = make("a", [b, c, d]);
      await tick(300);
      // order a b c d: a's right is b, left wraps to d
      expect(setCalls[setCalls.length - 1]).to.deep.equal(["d", "b"]);
      expect(p.lastPairedLeft).to.equal("d");
    });

    it("skips a neighbour that is not home or is leaving", async () => {
      const b = peer("b");
      const c = peer("c", true);
      const d = peer("d", true);
      d.graceStop = true;
      make("a", [b, c, d]);
      await tick(300);
      expect(setCalls[setCalls.length - 1]).to.deep.equal(["c", "c"]);
    });

    it("tells Home only when the pair changes", async () => {
      const b = peer("b", true);
      const p = make("a", [b]);
      await tick(300);
      const n = setCalls.length;
      p.pairNow();
      p.pairNow();
      expect(setCalls.length).to.equal(n);
      b.setState("unreachable");
      p.pairNow();
      expect(setCalls[setCalls.length - 1]).to.deep.equal([null, null]);
    });
  });

  describe("checkNeighbour (a sign a neighbour is up)", () => {
    it("asks at once, and pairs as soon as it answers", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      timers = []; // ignore the poll, this is the reactive path
      b.up = true;
      p.checkNeighbour(b);
      await tick(0);
      expect(b.isHome).to.equal(true);
      expect(setCalls[setCalls.length - 1]).to.deep.equal(["b", "b"]);
    });

    it("turns a burst of signs into one request", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      timers = [];
      b.knocks = 0;
      p.checkNeighbour(b);
      p.checkNeighbour(b);
      p.checkNeighbour(b);
      await tick(0);
      expect(b.knocks).to.equal(1);
    });

    it("retries sooner at first, then every 300 ms, eight times in all, then leaves it to the poll", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      timers = [];
      b.knocks = 0;
      const askedAt: number[] = [];
      const knock = b.knock;
      b.knock = () => {
        askedAt.push(nowMs);
        return knock();
      };
      const start = nowMs;
      p.checkNeighbour(b);
      await tick(300 * 20);
      expect(b.knocks).to.equal(9); // the first ask plus eight retries
      expect(askedAt.map((t) => t - start)).to.deep.equal([0, 25, 75, 175, 375, 675, 975, 1275, 1575]);
      expect(timers.length).to.equal(0);
    });

    it("stops retrying the moment the neighbour answers", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      timers = [];
      b.knocks = 0;
      p.checkNeighbour(b);
      await tick(600);
      b.up = true;
      await tick(300);
      const asked = b.knocks;
      await tick(5000);
      expect(b.isHome).to.equal(true);
      expect(b.knocks).to.equal(asked);
    });

    it("a fresh sign replaces a retry that is still waiting", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      timers = [];
      p.checkNeighbour(b);
      await tick(0);
      expect(Object.keys(p.retrying).length).to.equal(1);
      nowMs += 1000;
      p.checkNeighbour(b);
      await tick(0);
      expect(Object.keys(p.retrying).length).to.equal(1);
      expect(timers.length).to.equal(1);
    });

    it("ignores itself, a home neighbour, a leaving one and nothing at all", async () => {
      const b = peer("b", true);
      b.setState("home");
      const c = peer("c");
      c.graceStop = true;
      const p = make("a", [b, c]);
      timers = [];
      const self = (p.home.neighbourhood.get() as any).a;
      [self, b, c, undefined as any, null as any].forEach((n) => p.checkNeighbour(n));
      await tick(0);
      expect(b.knocks + c.knocks + self.knocks).to.equal(0);
    });

    it("drops an answer that arrives after the neighbourhood was replaced", async () => {
      const b = peer("b");
      const p = make("a", [b]);
      timers = [];
      b.up = true;
      setCalls.length = 0;
      p.checkNeighbour(b);
      networkRef = "net-2"; // replaced while the request was out
      await tick(0);
      expect(b.isHome).to.equal(false);
      expect(setCalls.length).to.equal(0);
    });
  });

  describe("restart", () => {
    it("forgets the old pairing and starts the fast poll again", async () => {
      const b = peer("b", true);
      const p = make("a", [b]);
      await tick(300);
      expect(p.lastPairedLeft).to.equal("b");
      b.setState("unknown");
      p.restart();
      expect(p.lastPairedLeft).to.equal(null);
      expect(p.discoveryTicks).to.be.lessThan(2);
      expect(timers.length).to.be.greaterThan(0);
    });
  });
});
