import { expect } from "chai";
import "mocha";
import { Maintain } from "../packages/network/src/network/maintain";
import { Home } from "../packages/network/src/network/home";
import { NeighbourStatus } from "../packages/network/src/network/neighbourhood";

// Maintain is all statics and talks to Home/Neighbour objects, so these
// tests drive it with plain fakes and capture setTimeout instead of waiting.
// Everything the class holds is reset around each test.
describe("Maintain (neighbourhood pairing and health timer)", () => {
  const M = Maintain as any;
  const realSetTimeout = global.setTimeout;
  const savedRef = Home.reference;
  let timers: { fn: () => void; ms: number }[];
  let setCalls: [string | null, string | null][];
  let status: NeighbourStatus;
  let throwOnSet: boolean;

  const fake = (
    reference: string,
    isHome = true,
    graceStop = false,
    knock: () => Promise<any> = async () => ({})
  ): any => ({
    reference,
    host: "h-" + reference,
    port: 5260,
    isHome,
    state: isHome ? "home" : "unknown",
    graceStop,
    knock,
    setState(this: any, state: string, reason?: string) {
      this.isHome = state === "home";
      this.state = state;
      this.reason = reason;
      return true;
    },
  });

  const makeHome = (self: string, neighbours: any[]): any => {
    const map: any = {};
    neighbours.forEach((n) => (map[n.reference] = n));
    return {
      reference: self,
      neighbourhood: { get: () => map, keys: () => Object.keys(map) },
      getStatus: () => status,
      setNeighbours: (l: string | null, r: string | null) => {
        if (throwOnSet) throw new Error("ipc down");
        setCalls.push([l, r]);
      },
    };
  };

  beforeEach(() => {
    timers = [];
    setCalls = [];
    status = NeighbourStatus.Stable;
    throwOnSet = false;
    (global as any).setTimeout = (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0 as any;
    };
    M.neighbourOrder = undefined;
    M.checking = false;
    M.rebasing = false;
    M.timerActive = false;
    M.lastPairedLeft = null;
    M.lastPairedRight = null;
    M.home = undefined;
  });

  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
    Home.reference = savedRef;
  });

  // Let any in-flight async check finish before state is reset
  const settle = () => new Promise<void>((r) => setImmediate(r));

  const setup = (self: string, ns: any[]) => {
    const home = makeHome(self, ns);
    M.home = home;
    M.createNetworkOrder();
    return home;
  };

  describe("network order", () => {
    it("sorts neighbours by reference and leaves out those gracefully stopping", () => {
      setup("b", [fake("c"), fake("a"), fake("d", true, true), fake("b")]);
      expect(M.neighbourOrder.map((n: any) => n.reference)).to.deep.equal([
        "a",
        "b",
        "c",
      ]);
    });
  });

  describe("pairing", () => {
    it("pairs a node with the neighbours either side of it in order", () => {
      setup("b", [fake("a"), fake("b"), fake("c")]);
      Maintain.pairNow();
      expect(setCalls).to.deep.equal([["a", "c"]]);
    });

    it("wraps around the ends of the order", () => {
      setup("a", [fake("a"), fake("b"), fake("c")]);
      Maintain.pairNow();
      expect(setCalls).to.deep.equal([["c", "b"]]);
    });

    it("skips neighbours that are not home or are leaving", () => {
      setup("c", [
        fake("a"),
        fake("b", false),
        fake("c"),
        fake("d", true, true),
        fake("e"),
      ]);
      // order is a,b,c,e (d leaves): left skips b -> a, right is e
      Maintain.pairNow();
      expect(setCalls).to.deep.equal([["a", "e"]]);
    });

    it("pairs both sides with the only other live node", () => {
      setup("a", [fake("a"), fake("b")]);
      Maintain.pairNow();
      expect(setCalls).to.deep.equal([["b", "b"]]);
    });

    it("does not report \"nothing found yet\" as a change", () => {
      setup("a", [fake("a"), fake("b", false)]);
      Maintain.pairNow();
      Maintain.pairNow();
      // lastPaired starts as null/null, so nothing found is "no change"
      expect(setCalls).to.have.length(0);
    });

    it("only updates home when the left/right pair actually changes", () => {
      const ns = [fake("a"), fake("b"), fake("c")];
      setup("b", ns);
      Maintain.pairNow();
      Maintain.pairNow();
      expect(setCalls).to.have.length(1);
      ns[2].isHome = false;
      Maintain.pairNow();
      expect(setCalls).to.deep.equal([
        ["a", "c"],
        ["a", "a"],
      ]);
    });

    it("tells home when a previously found neighbour disappears", () => {
      const ns = [fake("a"), fake("b")];
      setup("a", ns);
      Maintain.pairNow();
      ns[1].isHome = false;
      Maintain.pairNow();
      expect(setCalls).to.deep.equal([
        ["b", "b"],
        [null, null],
      ]);
    });

    it("aborts and clears flags when this node is not in the order", () => {
      setup("zzz", [fake("a"), fake("b")]);
      M.checking = true;
      M.rebasing = true;
      Maintain.pairNow();
      expect(setCalls).to.have.length(0);
      expect(M.checking).to.equal(false);
      expect(M.rebasing).to.equal(false);
    });

    it("clears the checking and rebasing flags after pairing", () => {
      setup("a", [fake("a"), fake("b")]);
      M.checking = true;
      M.rebasing = true;
      Maintain.pairNow();
      expect(M.checking).to.equal(false);
      expect(M.rebasing).to.equal(false);
    });

    it("survives setNeighbours throwing and does not retry the same pair", () => {
      setup("a", [fake("a"), fake("b")]);
      throwOnSet = true;
      expect(() => Maintain.pairNow()).to.not.throw();
      expect(M.lastPairedLeft).to.equal("b");
      throwOnSet = false;
      Maintain.pairNow();
      expect(setCalls).to.have.length(0);
    });
  });

  describe("healthTimer", () => {
    it("stops without scheduling once every neighbour is home or leaving", () => {
      setup("a", [fake("a"), fake("b")]);
      M.timerActive = true;
      Maintain.healthTimer();
      expect(timers).to.have.length(0);
      expect(M.timerActive).to.equal(false);
    });

    it("keeps polling fast while a neighbour is undiscovered", () => {
      setup("a", [fake("a"), fake("b", false)]);
      Maintain.healthTimer(true);
      expect(timers).to.have.length(1);
      expect(timers[0].ms).to.equal(300);
      expect(M.timerActive).to.equal(true);
    });

    it("does not start a second chain when booted twice", () => {
      setup("a", [fake("a"), fake("b", false)]);
      Maintain.healthTimer(true);
      Maintain.healthTimer(true);
      expect(timers).to.have.length(1);
    });

    it("a boot start allows a restart after the chain has stopped", () => {
      const ns = [fake("a"), fake("b", false)];
      setup("a", ns);
      Maintain.healthTimer(true);
      ns[1].isHome = true;
      Maintain.healthTimer();
      expect(M.timerActive).to.equal(false);
      ns[1].isHome = false;
      Maintain.healthTimer(true);
      expect(timers).to.have.length(2);
    });

    it("treats a leaving neighbour as discovered", () => {
      setup("a", [fake("a"), fake("b", false, true)]);
      Maintain.healthTimer(true);
      // graceStop is excluded from the order, so only "a" remains
      expect(timers).to.have.length(0);
    });

    it("uses the slow interval once discovery is complete", () => {
      setup("a", [fake("a"), fake("b")]);
      expect(M.getInterval()).to.equal(M.interval);
      expect(M.getInterval()).to.not.equal(300);
    });

    it("a tick reschedules itself and checks the neighbourhood", async () => {
      let knocked = 0;
      const ns = [
        fake("a"),
        fake("b", false, false, async () => {
          knocked++;
        }),
      ];
      setup("a", ns);
      Home.reference = "net-1";
      Maintain.healthTimer();
      expect(timers).to.have.length(1);
      expect(knocked).to.equal(1);
      await settle();
    });
  });

  describe("init", () => {
    it("builds the order and starts the timer", () => {
      const home = makeHome("a", [fake("b", false), fake("a")]);
      Maintain.init(home);
      expect(M.neighbourOrder.map((n: any) => n.reference)).to.deep.equal([
        "a",
        "b",
      ]);
      expect(timers).to.have.length(1);
    });
  });

  describe("checkNeighbourhood", () => {
    it("marks neighbours home when they answer a status knock and pairs", async () => {
      const knocks: string[] = [];
      const ns = [
        fake("a"),
        fake("b", false, false, async (m: string) => {
          knocks.push(m);
        }),
      ];
      setup("a", ns);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(knocks).to.deep.equal(["status"]);
      expect(ns[1].isHome).to.equal(true);
      expect(setCalls).to.deep.equal([["b", "b"]]);
      expect(M.checking).to.equal(false);
    });

    it("leaves a neighbour that fails to answer as not home", async () => {
      const ns = [
        fake("a"),
        fake("b", false, false, async () => {
          throw new Error("refused");
        }),
      ];
      setup("a", ns);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(ns[1].isHome).to.equal(false);
      expect(setCalls).to.have.length(0);
    });

    it("asks only the neighbours not yet home, and never itself", async () => {
      const asked: string[] = [];
      const track = (ref: string) => async () => {
        asked.push(ref);
      };
      const ns = [
        fake("a", false, false, track("a")),
        fake("b", true, false, track("b")),
        fake("c", false, false, track("c")),
        fake("d", false, false, track("d")),
      ];
      setup("a", ns);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(asked.sort()).to.deep.equal(["c", "d"]);
    });

    it("counts itself as home without a request", async () => {
      let asked = 0;
      const self = fake("a", false, false, async () => {
        asked++;
      });
      setup("a", [self, fake("b")]);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(self.isHome).to.equal(true);
      expect(self.state).to.equal("home");
      expect(asked).to.equal(0);
    });

    it("leaves a neighbour already home alone, whatever it would answer", async () => {
      const b = fake("b", true, false, async () => {
        throw new Error("would fail if asked");
      });
      setup("a", [fake("a"), b]);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(b.isHome).to.equal(true);
    });

    it("says a neighbour that has not answered is unreachable, and keeps a reason it already has", async () => {
      const silent = fake("b", false, false, async () => {
        throw new Error("refused");
      });
      const other = fake("c", false, false, async () => {
        throw new Error("refused");
      });
      other.state = "mismatch";
      other.reason = "chain 2";
      setup("a", [fake("a"), silent, other]);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(silent.state).to.equal("unreachable");
      expect(silent.reason).to.equal("no answer yet");
      expect(other.state).to.equal("mismatch");
      expect(other.reason).to.equal("chain 2");
    });

    it("moves a neighbour that answers to home", async () => {
      const b = fake("b", false, false, async () => ({}));
      b.state = "unreachable";
      b.reason = "no answer yet";
      setup("a", [fake("a"), b]);
      Home.reference = "net-1";
      await M.checkNeighbourhood();
      expect(b.state).to.equal("home");
      expect(b.isHome).to.equal(true);
    });

    it("does not mark home or pair if the network was reset meanwhile", async () => {
      const ns = [
        fake("a"),
        fake("b", false, false, async () => {
          Home.reference = "net-2";
        }),
      ];
      setup("a", ns);
      Home.reference = "net-1";
      M.rebasing = true;
      await M.checkNeighbourhood();
      expect(ns[1].isHome).to.equal(false);
      expect(setCalls).to.have.length(0);
      expect(M.checking).to.equal(false);
      expect(M.rebasing).to.equal(false);
    });

    it("returns immediately while already checking unless forced", async () => {
      let knocked = 0;
      const ns = [
        fake("a"),
        fake("b", false, false, async () => {
          knocked++;
        }),
      ];
      setup("a", ns);
      Home.reference = "net-1";
      M.checking = true;
      await M.checkNeighbourhood();
      expect(knocked).to.equal(0);
      await M.checkNeighbourhood(true);
      expect(knocked).to.equal(1);
    });
  });

  describe("rebaseNeighbourhood", () => {
    const knockCounter = () => {
      const c = { n: 0 };
      const ns = [
        fake("a"),
        fake("b", false, false, async () => {
          c.n++;
        }),
      ];
      return { c, ns };
    };

    it("starts a check when Recognised and clears the rebasing flag", async () => {
      const { c, ns } = knockCounter();
      setup("a", ns);
      Home.reference = "net-1";
      status = NeighbourStatus.Recognised;
      Maintain.rebaseNeighbourhood();
      expect(c.n).to.equal(1);
      expect(M.rebasing).to.equal(false);
      await settle();
    });

    it("starts a check when Unrecognised", async () => {
      const { c, ns } = knockCounter();
      setup("a", ns);
      Home.reference = "net-1";
      status = NeighbourStatus.Unrecognised;
      Maintain.rebaseNeighbourhood();
      expect(c.n).to.equal(1);
      await settle();
    });

    it("ignores the request in other states", () => {
      const { c, ns } = knockCounter();
      setup("a", ns);
      status = NeighbourStatus.Stable;
      Maintain.rebaseNeighbourhood();
      expect(c.n).to.equal(0);
      expect(timers).to.have.length(0);
    });

    it("retries in 2 seconds when a check is already running", () => {
      const { c, ns } = knockCounter();
      setup("a", ns);
      status = NeighbourStatus.Recognised;
      M.checking = true;
      Maintain.rebaseNeighbourhood();
      expect(c.n).to.equal(0);
      expect(M.rebasing).to.equal(true);
      expect(timers).to.have.length(1);
      expect(timers[0].ms).to.equal(2000);
    });
  });

  describe("the discovery poll backs off", () => {
    beforeEach(() => {
      M.discoveryTicks = 0;
      M.lastAsked = {};
      setup("a", [fake("a"), fake("b", false)]);
    });

    it("is fast for the first thirty ticks, then backs off to every ten seconds", () => {
      const seen: number[] = [];
      for (let i = 0; i < 38; i++) seen.push(M.getInterval());
      expect(seen.slice(0, 30)).to.deep.equal(new Array(30).fill(300));
      expect(seen.slice(30)).to.deep.equal([1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000]);
    });

    it("goes back to the routine interval once everyone is found", () => {
      M.discoveryTicks = 500;
      M.neighbourOrder.forEach((n: any) => (n.isHome = true));
      expect(M.getInterval()).to.equal(M.interval);
    });

    it("starts again from fast when discovery is restarted", () => {
      M.discoveryTicks = 500;
      M.restart();
      // Counting again from the first tick it just scheduled
      expect(M.discoveryTicks).to.equal(1);
      expect(timers[0].ms).to.equal(300);
    });
  });

  describe("checkNeighbour (a sign the neighbour is up)", () => {
    const answers = (n: any, outcome: "ok" | "fail") => {
      n.asked = 0;
      n.knock = async () => {
        n.asked++;
        if (outcome === "fail") throw new Error("down");
        return {};
      };
    };
    const settle = () => new Promise((r) => setImmediate(r));
    beforeEach(() => {
      M.lastAsked = {};
      M.retrying = {};
      M.asking = new Set();
      Home.reference = "net-1";
    });

    it("asks a neighbour that is not home, and marks it home and pairs when it answers", async () => {
      const b = fake("b", false);
      answers(b, "ok");
      setup("a", [fake("a"), b]);
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.asked).to.equal(1);
      expect(b.state).to.equal("home");
      expect(setCalls).to.deep.equal([["b", "b"]]);
    });

    it("marks a neighbour that does not answer unreachable, and does not throw", async () => {
      const b = fake("b", false);
      answers(b, "fail");
      setup("a", [fake("a"), b]);
      expect(() => Maintain.checkNeighbour(b)).to.not.throw();
      await settle();
      expect(b.state).to.equal("unreachable");
      expect(setCalls).to.deep.equal([]);
    });

    it("leaves alone a neighbour already home, one leaving, this node itself, and nothing at all", async () => {
      const home = fake("b", true);
      const leaving = fake("c", false, true);
      const self = fake("a", false);
      for (const n of [home, leaving, self]) answers(n, "ok");
      setup("a", [self, home, leaving]);
      for (const n of [home, leaving, self, undefined, null]) Maintain.checkNeighbour(n as any);
      await settle();
      expect([home.asked, leaving.asked, self.asked]).to.deep.equal([0, 0, 0]);
    });

    it("makes a burst of signs one request, and never has two out at once", async () => {
      const b = fake("b", false);
      let release: () => void = () => undefined;
      b.asked = 0;
      b.knock = () => {
        b.asked++;
        return new Promise((resolve) => (release = () => resolve({})));
      };
      setup("a", [fake("a"), b]);
      Maintain.checkNeighbour(b);
      Maintain.checkNeighbour(b);
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.asked).to.equal(1);
      release();
      await settle();
      expect(b.state).to.equal("home");
    });

    it("asks again after a short gap, when the first sign was a moment too early", async () => {
      const b = fake("b", false);
      answers(b, "fail");
      M.retrying = {};
      M.asking = new Set();
      setup("a", [fake("a"), b]);
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.asked).to.equal(1);
      // Inside 250 ms it is the same burst; after that a new sign is a new request
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.asked).to.equal(1);
      M.lastAsked.b = Date.now() - 400;
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.asked).to.equal(2);
    });

    it("retries a request that got no answer, sooner at first and then every 300 ms, eight times, and stops once it is home", async () => {
      const b = fake("b", false);
      answers(b, "fail");
      M.retrying = {};
      M.asking = new Set();
      setup("a", [fake("a"), b]);
      timers.length = 0;
      Maintain.checkNeighbour(b);
      await settle();
      // Run the retries as they are scheduled, noting each wait
      const waits: number[] = [];
      for (let i = 0; i < 8; i++) {
        expect(timers).to.have.length(1);
        const next = timers.shift()!;
        waits.push(next.ms);
        next.fn();
        await settle();
      }
      expect(waits).to.deep.equal([25, 50, 100, 200, 300, 300, 300, 300]);
      expect(b.asked).to.equal(9);
      // The ninth failed too, and there is no tenth
      expect(timers).to.deep.equal([]);
    });

    it("stops retrying when the neighbour becomes home another way", async () => {
      const b = fake("b", false);
      answers(b, "fail");
      M.retrying = {};
      M.asking = new Set();
      setup("a", [fake("a"), b]);
      timers.length = 0;
      Maintain.checkNeighbour(b);
      await settle();
      b.isHome = true;
      timers.shift()!.fn();
      await settle();
      expect(b.asked).to.equal(1);
      expect(timers).to.deep.equal([]);
    });

    it("lets a fresh sign replace a retry that is waiting", async () => {
      const b = fake("b", false);
      answers(b, "fail");
      M.retrying = {};
      M.asking = new Set();
      setup("a", [fake("a"), b]);
      timers.length = 0;
      Maintain.checkNeighbour(b);
      await settle();
      expect(Object.keys(M.retrying)).to.deep.equal(["b"]);
      M.lastAsked.b = Date.now() - 400;
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.asked).to.equal(2);
      // still one waiting retry, not two
      expect(Object.keys(M.retrying)).to.deep.equal(["b"]);
    });

    it("does nothing before the network is set up", () => {
      M.home = undefined;
      const b = fake("b", false);
      answers(b, "ok");
      expect(() => Maintain.checkNeighbour(b)).to.not.throw();
      expect(b.asked).to.equal(0);
    });

    it("does not pair if the network was reset while it asked", async () => {
      const b = fake("b", false);
      b.knock = async () => {
        Home.reference = "net-2";
        return {};
      };
      setup("a", [fake("a"), b]);
      Maintain.checkNeighbour(b);
      await settle();
      expect(b.isHome).to.equal(false);
      expect(setCalls).to.deep.equal([]);
    });
  });
});
