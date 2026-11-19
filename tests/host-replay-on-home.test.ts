import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
// Endpoints first: the network modules import each other in a ring
import "../packages/network/src/network/endpoints";
import { Host } from "../packages/network/src/network/host";
import { Neighbour } from "../packages/network/src/network/neighbour";

const SELF = "self";

describe("Replaying in-flight transactions to a neighbour that becomes home", () => {
  const make = (pending: any, peers: any = { a: { isHome: true }, b: { isHome: true } }) => {
    const broadcasts: any[][] = [];
    const host: any = Object.create(Host.prototype);
    host.reference = SELF;
    host.processPending = pending;
    host.neighbourhood = { get: (ref?: string) => (ref ? peers[ref] : peers), keys: () => Object.keys(peers) };
    host.broadcast = (...args: any[]) => broadcasts.push(args);
    return { host, broadcasts };
  };
  const home = (host: any, ref: string) => (Host.prototype as any).peerHome.call(host, ref);

  it("sends every unfinished transaction, once, to that neighbour only", () => {
    const { host, broadcasts } = make({ u1: { finished: false }, u2: { finished: false } });
    home(host, "a");
    expect(broadcasts).to.deep.equal([
      ["u1", false, false, ["a"]],
      ["u2", false, false, ["a"]],
    ]);
  });

  it("leaves finished transactions alone", () => {
    const { host, broadcasts } = make({ u1: { finished: true }, u2: { finished: false } });
    home(host, "a");
    expect(broadcasts.map((b) => b[0])).to.deep.equal(["u2"]);
  });

  it("does nothing for this node itself", () => {
    const { host, broadcasts } = make({ u1: { finished: false } }, { [SELF]: { isHome: true } });
    home(host, SELF);
    expect(broadcasts).to.deep.equal([]);
  });

  it("does nothing when nothing is in flight", () => {
    const { host, broadcasts } = make({});
    home(host, "a");
    expect(broadcasts).to.deep.equal([]);
  });

  it("forgets that our vote was handed to it, so it is sent in full", () => {
    const held: any = { finished: false, sentVote: { a: "sig", b: "sig" } };
    const { host } = make({ u1: held });
    home(host, "a");
    expect(held.sentVote).to.deep.equal({ b: "sig" });
  });

  it("does not send to a neighbour that is no longer home", () => {
    const { host, broadcasts } = make({ u1: { finished: false } }, { a: { isHome: false } });
    home(host, "a");
    expect(broadcasts).to.deep.equal([]);
  });

  it("waits for a full broadcast that is still going out, then sends", async () => {
    const held: any = { finished: false, broadcasting: true };
    const { host, broadcasts } = make({ u1: held });
    home(host, "a");
    expect(broadcasts).to.deep.equal([]);
    held.broadcasting = false;
    await new Promise((r) => setTimeout(r, 120));
    expect(broadcasts).to.deep.equal([["u1", false, false, ["a"]]]);
  });

  it("gives up on a transaction that finishes while it waits", async () => {
    const held: any = { finished: false, broadcasting: true };
    const { host, broadcasts } = make({ u1: held });
    home(host, "a");
    held.finished = true;
    held.broadcasting = false;
    await new Promise((r) => setTimeout(r, 120));
    expect(broadcasts).to.deep.equal([]);
  });
});

describe("Neighbour.onHome", () => {
  let seen: string[];
  let saved: any;
  let savedP2p: any;
  before(() => {
    saved = Neighbour.onHome;
    savedP2p = ActiveOptions.get("p2pStream", undefined);
    ActiveOptions.set("p2pStream", false);
  });
  after(() => {
    Neighbour.onHome = saved;
    ActiveOptions.set("p2pStream", savedP2p);
  });
  beforeEach(() => {
    seen = [];
    Neighbour.onHome = (ref) => seen.push(ref);
  });

  it("fires when a neighbour is first found, and when it comes back", () => {
    const n = new Neighbour("10.0.0.1", 5260);
    n.setState("home");
    expect(seen).to.deep.equal([n.reference]);
    n.setState("unreachable", "stopped answering");
    n.setState("home");
    expect(seen).to.deep.equal([n.reference, n.reference]);
  });

  it("does not fire when it was already home, or for any other state", () => {
    const n = new Neighbour("10.0.0.1", 5260);
    n.setState("home");
    seen = [];
    n.setState("home");
    n.setState("unreachable", "x");
    n.setState("unreachable", "y");
    n.setState("mismatch", "chain 2");
    expect(seen).to.deep.equal([]);
  });

  it("is fine with no handler", () => {
    Neighbour.onHome = undefined;
    expect(() => new Neighbour("10.0.0.1", 5260).setState("home")).to.not.throw();
  });
});
