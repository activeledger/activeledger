import { Process } from "../packages/protocol/src/protocol/process";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import { buildProcess, ProcessFixture, voteNodes } from "./helpers/process-fixture";

/**
 * The vote count that decides a commit, at its edges: a mutation pass found
 * nothing checking the exact threshold, so `>=` could have been `>` unnoticed.
 */
describe("Process - the vote threshold and the commit it starts (Activeprotocol)", () => {
  let savedLength: number;
  let savedConsensus: unknown;
  let savedUpdate: typeof StreamUpdater.prototype.updateStreams;
  let fixture: ProcessFixture;

  const make = (spec: string, response: any = {}, entry: any = {}, total = spec.length) => {
    fixture = buildProcess({ entry: { $nodes: voteNodes(spec), ...entry } });
    fixture.proc.reference = "n0";
    Object.assign(fixture.entry.$nodes.n0, response);
    fixture.proc.nodeResponse = fixture.entry.$nodes.n0;
    (Process as any).networkNodeLength = total;
    return fixture;
  };
  const canCommit = (f: ProcessFixture) => (f.proc as any).canCommit() as boolean;

  beforeEach(() => {
    savedLength = (Process as any).networkNodeLength;
    savedConsensus = ActiveOptions.get("consensus", null);
    savedUpdate = StreamUpdater.prototype.updateStreams;
    StreamUpdater.prototype.updateStreams = () => Promise.resolve();
  });
  afterEach(() => {
    StreamUpdater.prototype.updateStreams = savedUpdate;
    if (fixture) clearTimeout(fixture.proc.broadcastTimeout);
    (Process as any).networkNodeLength = savedLength;
    ActiveOptions.set("consensus", savedConsensus ?? undefined);
  });

  describe("canCommit", () => {
    it("commits at exactly the percentage asked for", () => {
      ActiveOptions.set("consensus", { reached: 60 });
      expect(canCommit(make("yyynn"))).to.equal(true); // 3 of 5 is 60%
    });

    it("does not commit one vote short of it", () => {
      ActiveOptions.set("consensus", { reached: 60 });
      expect(canCommit(make("yynnn"))).to.equal(false); // 2 of 5 is 40%
    });

    it("counts yes votes against the whole network, not against the nodes that answered", () => {
      ActiveOptions.set("consensus", { reached: 60 });
      expect(canCommit(make("yyn", {}, {}, 10))).to.equal(false);
    });

    it("does not count an early vote", () => {
      ActiveOptions.set("consensus", { reached: 60 });
      expect(canCommit(make("eeenn"))).to.equal(false);
      expect(canCommit(make("eeyyy"))).to.equal(true);
    });

    it("needs every node when the transaction is unanimous", () => {
      ActiveOptions.set("consensus", { reached: 60 });
      expect(canCommit(make("yyyyn", {}, { $unanimous: true }))).to.equal(false);
      expect(canCommit(make("yyyyy", {}, { $unanimous: true }))).to.equal(true);
    });
  });

  describe("canCommit with a leader vote", () => {
    // n0 is this node; n1 is the origin
    const withLeader = (spec: string, leader: Record<string, any>, response: any = {}, entry: any = {}) => {
      const f = make(spec, response, { $origin: "n1", ...entry });
      Object.assign(f.entry.$nodes.n1, leader);
      return f;
    };
    beforeEach(() => ActiveOptions.set("consensus", { reached: 60 }));

    it("takes the origin's leader vote as consensus once this node has voted yes", () => {
      // 2 of 5 yes is well short of 60%
      expect(canCommit(withLeader("yynnn", { leader: true }))).to.equal(true);
    });

    it("does not commit on it when this node voted no", () => {
      expect(canCommit(withLeader("nynnn", { leader: true }))).to.equal(false);
    });

    it("does not commit on a leader vote from a node that is not the origin", () => {
      expect(canCommit(withLeader("ynynn", { leader: true }, {}, { $origin: "n3" }))).to.equal(false);
    });

    it("does not commit on a leader vote that is a no", () => {
      expect(canCommit(withLeader("ynnnn", { leader: true }))).to.equal(false);
    });

    it("does not skip the count for a unanimous transaction", () => {
      expect(canCommit(withLeader("yynnn", { leader: true }, {}, { $unanimous: true }))).to.equal(false);
    });

    it("counts as usual when the origin's vote is not a leader vote", () => {
      expect(canCommit(withLeader("yynnn", {}))).to.equal(false);
      expect(canCommit(withLeader("yyynn", {}))).to.equal(true);
    });

    it("does not let this node's own leader flag stand in for the origin's", () => {
      expect(canCommit(withLeader("yynnn", {}, { leader: true }, { $origin: "n0" }))).to.equal(false);
    });
  });

  describe("commit, once consensus is there", () => {
    const vm = (seen: any[], proc: () => Process) =>
      ({
        commit: (nodes: any, territorial: boolean, umid: string) => {
          seen.push({ nodes, territorial, umid, committingNow: proc().isCommiting() });
          return Promise.resolve();
        },
        getInternodeCommsFromVM: () => "inter-node",
        getReturnContractData: () => "returned",
        getActivityStreamsFromVM: () => [],
        reconcile: () => Promise.resolve(false),
      }) as any;

    it("marks itself committing while the contract's commit runs and committed afterwards", async () => {
      ActiveOptions.set("consensus", { reached: 66 });
      const f = make("yyy", { vote: true });
      const seen: any[] = [];
      await f.proc.commit(vm(seen, () => f.proc));
      expect(seen).to.have.length(1);
      expect(seen[0].committingNow).to.equal(true);
      expect(f.proc.nodeResponse.commit).to.equal(true);
    });

    it("tells the contract whether this node is the territorial node", async () => {
      ActiveOptions.set("consensus", { reached: 66 });
      for (const [territoriality, expected] of [
        ["n0", true],
        ["n7", false],
      ] as const) {
        const f = make("yyy", { vote: true }, { $territoriality: territoriality, $umid: "u1" });
        const seen: any[] = [];
        await f.proc.commit(vm(seen, () => f.proc));
        expect(seen[0].territorial, `territoriality ${territoriality}`).to.equal(expected);
        expect(seen[0].umid).to.equal("u1");
      }
    });
  });
});
