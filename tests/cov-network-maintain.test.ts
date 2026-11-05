import { expect } from "chai";
import "mocha";
import { Maintain } from "../packages/network/src/network/maintain";
import { Home } from "../packages/network/src/network/home";
import { NeighbourStatus } from "../packages/network/src/network/neighbourhood";

describe("Maintain.rebaseNeighbourhood retry (cov)", () => {
  const M = Maintain as any;
  const realSetTimeout = global.setTimeout;
  const savedRef = Home.reference;
  let timers: { fn: () => void; ms: number }[];
  let knocks: number;

  beforeEach(() => {
    timers = [];
    knocks = 0;
    (global as any).setTimeout = (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0 as any;
    };
    const fake = (reference: string, knock: () => Promise<any>): any => ({
      reference, host: "h-" + reference, port: 5260, isHome: true, graceStop: false, knock,
    });
    const map: any = {
      a: fake("a", async () => ({})),
      b: fake("b", async () => { knocks++; }),
    };
    M.home = {
      reference: "a",
      neighbourhood: { get: () => map, keys: () => Object.keys(map) },
      getStatus: () => NeighbourStatus.Unrecognised,
      setNeighbours: () => undefined,
    };
    M.createNetworkOrder();
    M.checking = false;
    M.rebasing = false;
    M.timerActive = false;
    Home.reference = "net-1";
  });
  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
    Home.reference = savedRef;
    M.checking = false;
    M.rebasing = false;
    M.home = undefined;
  });

  it("tries again after two seconds, and rebases once the running check has finished", async () => {
    M.checking = true;
    Maintain.rebaseNeighbourhood();
    expect(knocks).to.equal(0);
    expect(timers.map((t) => t.ms)).to.deep.equal([2000]);
    expect(M.rebasing).to.equal(true);

    // the check finishes, then the timer fires
    M.checking = false;
    timers[0].fn();
    expect(knocks).to.equal(1);
    expect(M.rebasing).to.equal(false);
    await new Promise<void>((r) => setImmediate(r));
  });

  it("keeps waiting while the check is still running when the timer fires", () => {
    M.checking = true;
    Maintain.rebaseNeighbourhood();
    timers[0].fn();
    expect(knocks).to.equal(0);
    expect(timers.map((t) => t.ms)).to.deep.equal([2000, 2000]);
  });
});
