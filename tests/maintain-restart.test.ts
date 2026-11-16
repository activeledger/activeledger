import { expect } from "chai";
import "mocha";
import { Maintain } from "../packages/network/src/network/maintain";

/**
 * A config reload replaces the neighbourhood with new Neighbour objects. The
 * order Maintain holds, and its pairing memory, must follow, or the node stays
 * on its own until restarted (found by tests/network/hybrid-enable.ts).
 */
describe("Maintain.restart after a neighbourhood reset (Activenetwork)", () => {
  const M = Maintain as any;
  const realSetTimeout = global.setTimeout;
  const neighbour = (reference: string): any => ({ reference, isHome: false, graceStop: false });
  const homeWith = (refs: string[]): any => {
    const map: any = {};
    refs.forEach((r) => (map[r] = neighbour(r)));
    return { neighbourhood: { get: () => map, keys: () => Object.keys(map) } };
  };

  let checks: number;
  const realCheck = M.checkNeighbourhood;
  beforeEach(() => {
    checks = 0;
    (global as any).setTimeout = () => 0 as any;
    M.checkNeighbourhood = () => void checks++;
    M.timerActive = false;
  });
  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
    M.checkNeighbourhood = realCheck;
    M.timerActive = false;
  });

  it("orders the new neighbours, forgets the old pairing and checks them at once", () => {
    M.home = homeWith(["b", "a"]);
    M.createNetworkOrder();
    const old = M.neighbourOrder;
    M.lastPairedLeft = "a";
    M.lastPairedRight = "b";

    M.home = homeWith(["c", "b", "a"]);
    Maintain.restart();

    expect(M.neighbourOrder.map((n: any) => n.reference)).to.deep.equal(["a", "b", "c"]);
    expect(M.neighbourOrder[0]).to.not.equal(old[0]);
    expect(M.lastPairedLeft).to.equal(null);
    expect(M.lastPairedRight).to.equal(null);
    expect(checks).to.equal(1);
  });

  it("starts the discovery timer again", () => {
    M.home = homeWith(["a", "b"]);
    Maintain.restart();
    expect(M.timerActive).to.equal(true);
  });
});
