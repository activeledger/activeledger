import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
// Endpoints first: the network modules import each other in a ring, and
// loading Neighbour on its own first hits it before it is initialised
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Neighbour } from "../packages/network/src/network/neighbour";
import { Home } from "../packages/network/src/network/home";
import { Maintain } from "../packages/network/src/network/maintain";

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
    const reply = await Endpoints.status(host, "NA", undefined, "127.0.0.1");
    const shown = reply.content.neighbourhood.neighbours;
    expect(shown[a.reference]).to.include({ isHome: false, state: "unreachable", reason: "no answer yet" });
    expect(shown[b.reference]).to.include({ isHome: true, state: "home" });
    expect(shown[b.reference]).to.not.have.property("reason");
    expect(reply.content.neighbourhood.knocks.received).to.equal(before + 1);
  });

  it("keeps the reason, the change time and the knock counts from a caller off this machine", async () => {
    const a = new Neighbour("10.0.0.2", 5260);
    a.setState("unreachable", "no answer yet");
    const hood: any = { [a.reference]: a };
    const host: any = {
      reference: "me",
      getStatus: () => 4,
      neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
    };
    Home.left = { reference: "L" } as any;
    Home.right = { reference: "R" } as any;
    for (const address of ["203.0.113.9", "10.1.2.3", "::ffff:10.0.0.1", undefined]) {
      const reply = await Endpoints.status(host, "NA", undefined, address as any);
      const shown = reply.content.neighbourhood.neighbours[a.reference];
      expect(shown, String(address)).to.deep.equal({ isHome: false, state: "unreachable" });
      expect(reply.content.neighbourhood, String(address)).to.not.have.property("knocks");
    }
  });

  it("gives the detail to loopback callers in every spelling", async () => {
    const a = new Neighbour("10.0.0.2", 5260);
    a.setState("mismatch", "chain 2");
    const hood: any = { [a.reference]: a };
    const host: any = {
      reference: "me",
      getStatus: () => 4,
      neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
    };
    Home.left = { reference: "L" } as any;
    Home.right = { reference: "R" } as any;
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.1"]) {
      const reply = await Endpoints.status(host, "NA", undefined, address);
      expect(reply.content.neighbourhood.neighbours[a.reference], address).to.include({ state: "mismatch", reason: "chain 2" });
      expect(reply.content.neighbourhood, address).to.have.property("knocks");
    }
  });

  describe("the detail given to a local caller", () => {
    const hostWith = (neighbours: Neighbour[], pending = 0): any => {
      const hood: any = {};
      neighbours.forEach((n) => (hood[n.reference] = n));
      return {
        reference: "me",
        getStatus: () => 4,
        pendingCount: () => pending,
        neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
      };
    };
    const up = (host: string, home: boolean) => {
      const n = new Neighbour(host, 5260);
      if (home) n.setState("home");
      return n;
    };
    let savedConsensus: any, savedBuild: any, savedChain: any;
    beforeEach(() => {
      savedConsensus = ActiveOptions.get("consensus", undefined);
      savedBuild = ActiveOptions.get("build", undefined);
      savedChain = ActiveOptions.get("chain", undefined);
      Home.left = { reference: "L" } as any;
      Home.right = { reference: "R" } as any;
    });
    afterEach(() => {
      ActiveOptions.set("consensus", savedConsensus);
      ActiveOptions.set("build", savedBuild);
      ActiveOptions.set("chain", savedChain);
    });

    it("works out the votes consensus needs over the configured nodes, as the commit phase does", () => {
      expect(Endpoints.votesNeeded(4, 60)).to.equal(3);
      expect(Endpoints.votesNeeded(3, 60)).to.equal(2);
      expect(Endpoints.votesNeeded(1, 60)).to.equal(1);
      expect(Endpoints.votesNeeded(5, 100)).to.equal(5);
      expect(Endpoints.votesNeeded(10, 51)).to.equal(6);
      expect(Endpoints.votesNeeded(10, 50)).to.equal(5);
      expect(Endpoints.votesNeeded(4, 0)).to.equal(0);
    });

    it("reports the node, the quorum, the pending count and each P2P connection", async () => {
      ActiveOptions.set("consensus", { reached: 60 });
      ActiveOptions.set("build", 50600);
      ActiveOptions.set("chain", { id: 9 });
      const self = up("10.0.0.1", true);
      const a = up("10.0.0.2", true);
      const b = up("10.0.0.3", false);
      const c = up("10.0.0.4", false);
      const reply = await Endpoints.status(hostWith([self, a, b, c], 3), "NA", undefined, "127.0.0.1");
      const { node, quorum, pending, neighbourhood } = reply.content;
      expect(node.chain).to.equal(9);
      expect(node.build).to.equal(50600);
      expect(node.uptimeSeconds).to.be.a("number");
      expect(node.version).to.match(/^\d+\.\d+\.\d+/);
      // four configured, two home (this node counts itself): 60% of four needs three
      expect(quorum).to.deep.equal({ configured: 4, home: 2, needed: 3, reached: false });
      expect(pending).to.equal(3);
      // no P2P client in this test (p2pStream is off)
      expect(neighbourhood.neighbours[a.reference].p2p).to.equal("off");
    });

    it("says quorum is reached once enough are home, and counts only neighbours not leaving", async () => {
      ActiveOptions.set("consensus", { reached: 60 });
      const nodes = [up("10.0.0.1", true), up("10.0.0.2", true), up("10.0.0.3", true), up("10.0.0.4", false)];
      let reply = await Endpoints.status(hostWith(nodes), "NA", undefined, "127.0.0.1");
      expect(reply.content.quorum).to.deep.equal({ configured: 4, home: 3, needed: 3, reached: true });
      nodes[3].graceStop = true;
      reply = await Endpoints.status(hostWith(nodes), "NA", undefined, "127.0.0.1");
      expect(reply.content.quorum).to.deep.equal({ configured: 3, home: 3, needed: 2, reached: true });
    });

    it("says whether a P2P connection is up", async () => {
      const a = up("10.0.0.2", true);
      const b = up("10.0.0.3", true);
      (a as any).p2pClient = { ready: true };
      (b as any).p2pClient = { ready: false };
      const reply = await Endpoints.status(hostWith([a, b]), "NA", undefined, "127.0.0.1");
      expect(reply.content.neighbourhood.neighbours[a.reference].p2p).to.equal("connected");
      expect(reply.content.neighbourhood.neighbours[b.reference].p2p).to.equal("disconnected");
    });

    it("gives none of it to a caller off this machine", async () => {
      const reply = await Endpoints.status(hostWith([up("10.0.0.2", true)], 5), "NA", undefined, "203.0.113.9");
      for (const key of ["node", "quorum", "pending"]) expect(reply.content, key).to.not.have.property(key);
      for (const n of Object.values(reply.content.neighbourhood.neighbours) as any[]) expect(n).to.not.have.property("p2p");
    });
  });

  describe("looking at a neighbour at once when there is a sign it is up", () => {
    let looked: any[];
    let real: any;
    beforeEach(() => {
      looked = [];
      real = Maintain.checkNeighbour;
      Maintain.checkNeighbour = ((n: any) => looked.push(n.reference)) as any;
    });
    afterEach(() => {
      Maintain.checkNeighbour = real;
    });
    const hostOf = (neighbours: Neighbour[]): any => {
      const hood: any = {};
      neighbours.forEach((n) => (hood[n.reference] = n));
      return {
        reference: "me",
        getStatus: () => 4,
        neighbourhood: { get: (ref?: string) => (ref ? hood[ref] ?? null : hood), keys: () => Object.keys(hood) },
      };
    };

    it("when a configured neighbour that is not home knocks the status route", async () => {
      const n = new Neighbour("10.0.0.2", 5260);
      await Endpoints.status(hostOf([n]), n.reference, undefined, "10.0.0.2");
      expect(looked).to.deep.equal([n.reference]);
    });

    it("but not for a neighbour already home, one leaving, a stranger, or an anonymous caller", async () => {
      const home = new Neighbour("10.0.0.3", 5260);
      home.setState("home");
      const leaving = new Neighbour("10.0.0.4", 5260);
      leaving.graceStop = true;
      const host = hostOf([home, leaving]);
      await Endpoints.status(host, home.reference, undefined, "10.0.0.3");
      await Endpoints.status(host, leaving.reference, undefined, "10.0.0.4");
      await Endpoints.status(host, "not-configured", undefined, "203.0.113.9");
      await Endpoints.status(host, "NA", undefined, "127.0.0.1");
      expect(looked).to.deep.equal([]);
    });

    it("and not for a neighbour on another chain, which the status route refuses first", async () => {
      const n = new Neighbour("10.0.0.5", 5260);
      const savedChain = ActiveOptions.get("chain", undefined);
      ActiveOptions.set("chain", { id: 1 });
      try {
        await Endpoints.status(hostOf([n]), n.reference, "7", "10.0.0.5");
      } finally {
        ActiveOptions.set("chain", savedChain);
      }
      expect(looked).to.deep.equal([]);
    });
  });
});

describe("A neighbour's P2P socket connecting", () => {
  let server: import("net").Server;
  let port: number;
  let savedP2p: any;
  let real: any;
  let looked: string[];

  beforeEach(async () => {
    looked = [];
    savedP2p = ActiveOptions.get("p2pStream", undefined);
    real = Maintain.checkNeighbour;
    Maintain.checkNeighbour = ((n: any) => looked.push(n.reference)) as any;
    server = (await import("net")).createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });
  afterEach(async () => {
    Maintain.checkNeighbour = real;
    ActiveOptions.set("p2pStream", savedP2p);
    await new Promise<void>((r) => server.close(() => r()));
  });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("makes the node look at that neighbour at once", async () => {
    ActiveOptions.set("p2pStream", true);
    // The P2P port is the neighbour's port plus one
    const n = new Neighbour("127.0.0.1", port - 1);
    try {
      await until(() => looked.length > 0);
      expect(looked).to.deep.equal([n.reference]);
    } finally {
      n.p2pClient.stop();
    }
  });

  it("does not, for a neighbour already home", async () => {
    ActiveOptions.set("p2pStream", true);
    const n = new Neighbour("127.0.0.1", port - 1);
    n.setState("home");
    try {
      await until(() => n.p2pClient.ready);
      await new Promise((r) => setTimeout(r, 50));
      expect(looked).to.deep.equal([]);
    } finally {
      n.p2pClient.stop();
    }
  });
});
