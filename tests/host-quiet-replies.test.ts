import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Home } from "../packages/network/src/network/home";
import { Host } from "../packages/network/src/network/host";
import { nodeSignature } from "../packages/network/src/network/nodedelta";

/**
 * p2pQuietReplies: a node does not answer a neighbour with its vote when that
 * vote was already handed to it, and a neighbour that stays silent gets our
 * vote again. Inter node comms is always answered as before.
 */
describe("Host p2pQuietReplies (Activenetwork)", () => {
  it("is on when nothing is configured, and off only when set to false", () => {
    const saved = ActiveOptions.get("p2pQuietReplies", undefined);
    try {
      ActiveOptions.set("p2pQuietReplies", undefined);
      expect((Host as any).quietReplies()).to.equal(true);
      ActiveOptions.set("p2pQuietReplies", false);
      expect((Host as any).quietReplies()).to.equal(false);
    } finally {
      ActiveOptions.set("p2pQuietReplies", saved);
    }
  });

  const SELF = "me";
  const saved: any = {};
  before(() => {
    saved.quiet = ActiveOptions.get("p2pQuietReplies", undefined);
    saved.resend = ActiveOptions.get("p2pResendMs", undefined);
    saved.reference = Home.reference;
    Home.reference = SELF;
  });
  after(() => {
    ActiveOptions.set("p2pQuietReplies", saved.quiet);
    ActiveOptions.set("p2pResendMs", saved.resend);
    Home.reference = saved.reference;
  });
  beforeEach(() => {
    ActiveOptions.set("p2pQuietReplies", true);
    ActiveOptions.set("p2pResendMs", 100000);
  });

  const vote = { vote: true, commit: false };
  const make = (held: any = {}, peers: { [ref: string]: any } = { a: { isHome: true }, b: { isHome: true } }) => {
    const broadcasts: any[][] = [];
    const host: any = Object.create(Host.prototype);
    host.reference = SELF;
    host.processPending = { u1: { entry: { $umid: "u1", $broadcast: true, $nodes: { [SELF]: vote } }, finished: false, ...held } };
    host.neighbourhood = { get: (ref?: string) => (ref ? peers[ref] : peers), keys: () => Object.keys(peers), checkFirewall: () => true };
    host.broadcast = (...args: any[]) => broadcasts.push(args);
    host.broadcastResolver = () => undefined;
    return { host, broadcasts };
  };
  const quiet = (host: any, recipients: string[] | undefined, incoming: any = { $nodes: { a: vote } }) =>
    (Host.prototype as any).quietReply.call(host, "u1", recipients, incoming);

  describe("when a reply is left out", () => {
    it("leaves it out once our vote was handed to that neighbour", () => {
      const { host } = make({ sentVote: { a: nodeSignature(vote) } });
      expect(quiet(host, ["a"])).to.equal(true);
    });
    it("answers when the switch is off", () => {
      ActiveOptions.set("p2pQuietReplies", false);
      const { host } = make({ sentVote: { a: nodeSignature(vote) } });
      expect(quiet(host, ["a"])).to.equal(false);
    });
    it("answers a neighbour our vote was never handed to, or was handed a different one", () => {
      expect(quiet(make().host, ["a"])).to.equal(false);
      expect(quiet(make({ sentVote: { a: nodeSignature({ vote: true, commit: true }) } }).host, ["a"])).to.equal(false);
      expect(quiet(make({ sentVote: { b: nodeSignature(vote) } }).host, ["a"])).to.equal(false);
    });
    it("answers when it cannot tell who asked, or before it has voted", () => {
      const sent = { sentVote: { a: nodeSignature(vote) } };
      expect(quiet(make(sent).host, undefined)).to.equal(false);
      expect(quiet(make(sent).host, ["a", "b"])).to.equal(false);
      const none = make({ ...sent, entry: { $umid: "u1", $nodes: {} } });
      expect(quiet(none.host, ["a"])).to.equal(false);
      const early = make({ ...sent, entry: { $umid: "u1", $nodes: { [SELF]: { early: true } } } });
      expect(quiet(early.host, ["a"])).to.equal(false);
    });
  });

  describe("inter node comms", () => {
    const comms = { vote: true, commit: false, incomms: { secret: 1 } };
    it("is answered as before when our own response carries comms", () => {
      const { host } = make({ entry: { $umid: "u1", $broadcast: true, $nodes: { [SELF]: comms } }, sentVote: { a: nodeSignature(comms) } });
      expect(quiet(host, ["a"])).to.equal(false);
    });
    it("is answered as before when the neighbour's response carries comms", () => {
      const { host } = make({ sentVote: { a: nodeSignature(vote) } });
      expect(quiet(host, ["a"], { $nodes: { a: comms } })).to.equal(false);
    });
    it("goes quiet again once the comms are cleared", () => {
      const { host } = make({ sentVote: { a: nodeSignature(vote) } });
      expect(quiet(host, ["a"], { $nodes: { a: { ...comms, incomms: null } } })).to.equal(true);
    });
  });

  describe("pending()", () => {
    const ask = (host: any) =>
      (Host.prototype as any).pending.call(host, { $umid: "u1", $broadcast: true, $nodes: { a: vote } }, "127.0.0.1", true, false, true, "a");
    it("sends no reply to a neighbour that already has our vote", async () => {
      const { host, broadcasts } = make({ sentVote: { a: nodeSignature(vote) } });
      const result = await ask(host);
      expect(result.status).to.equal(200);
      expect(broadcasts).to.deep.equal([]);
    });
    it("still replies to one that does not", async () => {
      const { host, broadcasts } = make();
      await ask(host);
      expect(broadcasts).to.deep.equal([["u1", false, true, ["a"]]]);
    });
    it("replies as before with the switch off", async () => {
      ActiveOptions.set("p2pQuietReplies", false);
      const { host, broadcasts } = make({ sentVote: { a: nodeSignature(vote) } });
      await ask(host);
      expect(broadcasts).to.have.length(1);
    });
  });

  describe("remembering what a neighbour was handed", () => {
    const sendTo = async (answer: () => Promise<any>) => {
      const peers: any = { a: { isHome: true, reference: "a", knock: answer } };
      const { host } = make({}, peers);
      delete host.broadcast; // the real one
      host.processPending.u1.entry.$nodes = { [SELF]: vote };
      (Host.prototype as any).broadcast.call(host, "u1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return host.processPending.u1;
    };
    it("records our vote for a neighbour that took the frame", async () => {
      expect((await sendTo(async () => ({ ok: 1 }))).sentVote).to.deep.equal({ a: nodeSignature(vote) });
    });
    it("records nothing for one that did not", async () => {
      expect((await sendTo(async () => { throw new Error("not writable"); })).sentVote).to.equal(undefined);
    });
    it("forgets what a neighbour was handed when its socket drops a frame", () => {
      const { host } = make({ sentVote: { a: "x", b: "y" } });
      (Host.prototype as any).peerDropped.call(host, "a");
      expect(host.processPending.u1.sentVote).to.deep.equal({ b: "y" });
    });
  });

  describe("the neighbour that never answers", () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    it("is sent our vote again, and the ones that answered are not", async () => {
      ActiveOptions.set("p2pResendMs", 15);
      const { host, broadcasts } = make({ sentNodes: { a: "sig" }, sentVote: { a: "s", b: "s" } });
      (Host.prototype as any).armResend.call(host, "u1", 0);
      await wait(45);
      expect(broadcasts[0]).to.deep.equal(["u1", false, false, ["b"]]);
      expect(host.processPending.u1.sentVote).to.deep.equal({ a: "s" });
    });
    it("waits twice as long each time, and stops after five tries", async () => {
      ActiveOptions.set("p2pResendMs", 10);
      const { host, broadcasts } = make({}, { b: { isHome: true } });
      (Host.prototype as any).armResend.call(host, "u1", 0);
      await wait(55);
      expect(broadcasts.length).to.be.within(2, 3); // 10, then 20 later, then 40 later
      await wait(450);
      expect(broadcasts).to.have.length(5);
    });
    it("does nothing when everyone has answered, the transaction is done, or a neighbour is down", async () => {
      ActiveOptions.set("p2pResendMs", 10);
      const done = make({ finished: true });
      (Host.prototype as any).armResend.call(done.host, "u1", 0);
      const heard = make({ sentNodes: { a: "s", b: "s" } });
      (Host.prototype as any).armResend.call(heard.host, "u1", 0);
      const down = make({}, { a: { isHome: false }, b: { isHome: false } });
      (Host.prototype as any).armResend.call(down.host, "u1", 0);
      await wait(40);
      expect(done.broadcasts).to.deep.equal([]);
      expect(heard.broadcasts).to.deep.equal([]);
      expect(down.broadcasts).to.deep.equal([]);
    });
    it("is not armed with the switch off", async () => {
      ActiveOptions.set("p2pQuietReplies", false);
      ActiveOptions.set("p2pResendMs", 10);
      const { host, broadcasts } = make();
      (Host.prototype as any).armResend.call(host, "u1", 0);
      await wait(40);
      expect(broadcasts).to.deep.equal([]);
    });
  });
});
