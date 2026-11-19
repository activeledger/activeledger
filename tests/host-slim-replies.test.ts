import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveClone } from "@activeledger/activeutilities";
import { Home } from "../packages/network/src/network/home";
import { Host } from "../packages/network/src/network/host";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";

/**
 * A reply to the one node that just sent us a transaction goes out as the vote
 * alone when p2pSlimReplies is on. Anything else is sent whole, as before.
 */
describe("Host p2pSlimReplies (Activenetwork)", () => {
  const SELF = "self-ref";
  const saved: any = {};
  const keys = new ActiveCrypto.KeyPair("rsa").generate();

  before(() => {
    saved.reference = Home.reference;
    saved.identity = Home.identity;
    saved.pairNow = Maintain.pairNow;
    saved.p2pStream = ActiveOptions.get("p2pStream", undefined);
    saved.slim = ActiveOptions.get("p2pSlimReplies", undefined);
    saved.security = ActiveOptions.get("security", undefined);
    Home.reference = SELF;
    Home.identity = new ActiveCrypto.KeyPair("rsa");
    Maintain.pairNow = () => undefined;
    ActiveOptions.set("security", {});
  });
  after(() => {
    Home.reference = saved.reference;
    Home.identity = saved.identity;
    Maintain.pairNow = saved.pairNow;
    ActiveOptions.set("p2pStream", saved.p2pStream);
    ActiveOptions.set("p2pSlimReplies", saved.slim);
    ActiveOptions.set("security", saved.security);
  });
  afterEach(() => ActiveOptions.set("p2pSlimReplies", saved.slim));

  const p2pPeer = (port: number) => {
    const sent: Buffer[] = [];
    ActiveOptions.set("p2pStream", false);
    const peer = new Neighbour("127.0.0.1", port, true, new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem));
    ActiveOptions.set("p2pStream", true);
    (peer as any).p2pClient = { ready: true, send: (data: Buffer) => sent.push(data) };
    return { peer, sent };
  };
  const entryOf = () => ({
    $umid: "u1",
    $broadcast: true,
    $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
    $revs: { $i: { a: "1-x" }, $o: {} },
    $sigs: { a: "signature" },
    $origin: "origin",
    $nodes: { [SELF]: { vote: true, commit: false }, other: { vote: true } },
  });
  const send = async (peers: ReturnType<typeof p2pPeer>[], args: [boolean, boolean, string[]?]) => {
    const hood: any = {};
    peers.forEach((p) => (hood[p.peer.reference] = p.peer));
    const host: any = {
      reference: SELF,
      processPending: { u1: { entry: entryOf() } },
      neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
      broadcastResolver: () => undefined,
    };
    (Host.prototype as any).broadcast.call(host, "u1", ...args);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const decode = (b: Buffer) => ActiveClone.deserialize(b) as Promise<any>;

  it("sends a directed reply as the vote alone", async () => {
    ActiveOptions.set("p2pSlimReplies", true);
    const a = p2pPeer(7101), b = p2pPeer(7102);
    await send([a, b], [false, true, [a.peer.reference]]);
    expect(b.sent).to.have.length(0);
    const frame = await decode(a.sent[0]);
    expect(Object.keys(frame).sort()).to.deep.equal(["$$noreply", "$broadcast", "$nodes", "$umid"]);
    expect(frame.$umid).to.equal("u1");
    expect(frame.$broadcast).to.equal(true);
    expect(frame.$$noreply).to.equal(true);
    expect(frame.$nodes).to.deep.equal({ [SELF]: { vote: true, commit: false } });
  });

  it("is on when nothing is configured", async () => {
    ActiveOptions.set("p2pSlimReplies", undefined);
    const a = p2pPeer(7131);
    await send([a], [false, true, [a.peer.reference]]);
    const frame = await decode(a.sent[0]);
    expect(frame.$tx).to.equal(undefined);
    expect(frame.$$noreply).to.equal(true);
  });

  it("is much smaller than the whole entry", async () => {
    const full = p2pPeer(7111), slim = p2pPeer(7112);
    ActiveOptions.set("p2pSlimReplies", false);
    await send([full], [false, true, [full.peer.reference]]);
    ActiveOptions.set("p2pSlimReplies", true);
    await send([slim], [false, true, [slim.peer.reference]]);
    expect(slim.sent[0].length).to.be.lessThan(full.sent[0].length * 0.6);
  });

  it("sends the whole entry when the switch is off", async () => {
    ActiveOptions.set("p2pSlimReplies", false);
    const a = p2pPeer(7121);
    await send([a], [false, true, [a.peer.reference]]);
    const frame = await decode(a.sent[0]);
    expect(frame.$tx).to.be.an("object");
    expect(frame.$revs).to.be.an("object");
    expect(frame.$sigs).to.be.an("object");
  });

  it("sends the whole entry when it is not a directed reply", async () => {
    ActiveOptions.set("p2pSlimReplies", true);
    for (const args of [[false, false], [false, true], [false, false, ["x"]]] as [boolean, boolean, string[]?][]) {
      const a = p2pPeer(7131);
      args[2] = args[2] ? [a.peer.reference] : undefined;
      await send([a], args);
      const frame = await decode(a.sent[0]);
      expect(frame.$tx, JSON.stringify(args)).to.be.an("object");
    }
  });

  describe("what a node does with one", () => {
    const receiver = (held?: any) => {
      const calls: string[] = [];
      const host: any = {
        reference: "me",
        processPending: held ? { u1: { entry: held, finished: false } } : {},
        neighbourhood: { checkFirewall: () => true },
        broadcast: () => calls.push("broadcast"),
        destroy: () => undefined,
      };
      return { host, calls };
    };
    const slimFrame = () => ({ $umid: "u1", $broadcast: true, $nodes: { peer: { vote: true, commit: false } }, $$noreply: true });

    it("merges the vote into the transaction it already holds and leaves the transaction alone", async () => {
      const held: any = { $umid: "u1", $broadcast: true, $tx: { $contract: "c" }, $revs: { $i: {}, $o: {} }, $nodes: { me: { vote: true } } };
      const { host, calls } = receiver(held);
      const result = await (Host.prototype as any).pending.call(host, slimFrame(), "127.0.0.1", true, false, true, "peer");
      expect(result.status).to.equal(200);
      expect(held.$nodes.peer).to.deep.equal({ vote: true, commit: false });
      expect(held.$nodes.me).to.deep.equal({ vote: true });
      expect(held.$tx).to.deep.equal({ $contract: "c" });
      expect(calls).to.deep.equal([]);
    });

    it("does nothing for a transaction it does not hold, and does not start one", async () => {
      const { host } = receiver();
      const result = await (Host.prototype as any).pending.call(host, slimFrame(), "127.0.0.1", true, false, true, "peer");
      expect(result.data).to.deep.equal({ ok: true });
      expect(host.processPending).to.deep.equal({});
    });
  });
});
