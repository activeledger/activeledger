import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
// Endpoints first: the network modules import each other in a ring, and
// loading Neighbour on its own first hits it before it is initialised
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Neighbour } from "../packages/network/src/network/neighbour";
import { Home } from "../packages/network/src/network/home";

describe("Neighbour state and reason", () => {
  let savedP2p: any;
  before(() => {
    savedP2p = ActiveOptions.get("p2pStream", undefined);
    ActiveOptions.set("p2pStream", false);
  });
  after(() => ActiveOptions.set("p2pStream", savedP2p));

  it("starts unknown and not home", () => {
    const n = new Neighbour("10.0.0.1", 5260);
    expect(n.state).to.equal("unknown");
    expect(n.isHome).to.equal(false);
    expect(n.reason).to.equal(undefined);
  });

  it("keeps isHome in step with the state", () => {
    const n = new Neighbour("10.0.0.1", 5260);
    n.setState("home");
    expect(n.isHome).to.equal(true);
    n.setState("unreachable", "stopped answering");
    expect(n.isHome).to.equal(false);
    n.setState("mismatch", "chain 2");
    expect(n.isHome).to.equal(false);
  });

  it("says whether anything changed, so a change is logged once", () => {
    const n = new Neighbour("10.0.0.1", 5260);
    expect(n.setState("unreachable", "no answer yet")).to.equal(true);
    expect(n.setState("unreachable", "no answer yet")).to.equal(false);
    expect(n.setState("unreachable", "stopped answering")).to.equal(true);
    expect(n.setState("home")).to.equal(true);
    expect(n.setState("home")).to.equal(false);
  });

  it("moves the change time only when the state changes", async () => {
    const n = new Neighbour("10.0.0.1", 5260);
    n.setState("home");
    const first = n.since;
    await new Promise((r) => setTimeout(r, 5));
    n.setState("home");
    expect(n.since).to.equal(first);
    n.setState("unreachable");
    expect(n.since).to.be.greaterThan(first - 1);
  });

  it("is shown to an anonymous status caller, with the reason and the knock counts", async () => {
    const a = new Neighbour("10.0.0.2", 5260);
    a.setState("unreachable", "no answer yet");
    const b = new Neighbour("10.0.0.3", 5260);
    b.setState("home");
    const hood: any = { [a.reference]: a, [b.reference]: b };
    const host: any = {
      reference: "me",
      getStatus: () => 4,
      neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
    };
    Home.left = { reference: "L" } as any;
    Home.right = { reference: "R" } as any;
    const before = Endpoints.statusKnocksReceived;
    const reply = await Endpoints.status(host, "NA");
    const shown = reply.content.neighbourhood.neighbours;
    expect(shown[a.reference]).to.include({ isHome: false, state: "unreachable", reason: "no answer yet" });
    expect(shown[b.reference]).to.include({ isHome: true, state: "home" });
    expect(shown[b.reference]).to.not.have.property("reason");
    expect(reply.content.neighbourhood.knocks.received).to.equal(before + 1);
  });
});
