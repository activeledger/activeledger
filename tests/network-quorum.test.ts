import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";

describe("Endpoints.quorum (is this node ready to take transactions)", () => {
  let saved: any;
  before(() => {
    ActiveOptions.init();
    saved = ActiveOptions.get<any>("consensus", undefined);
  });
  after(() => ActiveOptions.set("consensus", saved));
  beforeEach(() => ActiveOptions.set("consensus", { reached: 66 }));

  const hood = (states: { [ref: string]: { isHome: boolean; graceStop?: boolean } }) => ({
    neighbours: states as any,
    keys: Object.keys(states),
  });
  const q = (states: any) => {
    const h = hood(states);
    return Endpoints.quorum(h.neighbours, h.keys);
  };

  it("is not reached with only part of a four node network home", () => {
    expect(q({ a: { isHome: true }, b: { isHome: true }, c: { isHome: false }, d: { isHome: false } })).to.deep.equal({
      configured: 4,
      home: 2,
      needed: 3,
      reached: false,
    });
  });

  it("is reached at the votes consensus needs, not at all of them", () => {
    const r = q({ a: { isHome: true }, b: { isHome: true }, c: { isHome: true }, d: { isHome: false } });
    expect(r.reached).to.equal(true);
    expect(r.home).to.equal(3);
  });

  it("leaves out a node that is leaving, from both sides", () => {
    const r = q({ a: { isHome: true }, b: { isHome: true }, c: { isHome: false, graceStop: true } });
    expect(r).to.deep.equal({ configured: 2, home: 2, needed: 2, reached: true });
  });

  it("a single node network is ready on its own", () => {
    expect(q({ a: { isHome: true } }).reached).to.equal(true);
  });

  it("follows the configured percentage", () => {
    ActiveOptions.set("consensus", { reached: 100 });
    expect(q({ a: { isHome: true }, b: { isHome: true }, c: { isHome: true }, d: { isHome: false } }).reached).to.equal(false);
    ActiveOptions.set("consensus", { reached: 50 });
    expect(q({ a: { isHome: true }, b: { isHome: true }, c: { isHome: false }, d: { isHome: false } }).reached).to.equal(true);
  });
});
