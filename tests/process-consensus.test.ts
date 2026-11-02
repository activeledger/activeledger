import { Process } from "../packages/protocol/src/protocol/process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import { buildProcess, ProcessFixture, voteNodes } from "./helpers/process-fixture";

/**
 * The bookkeeping a node does between voting and committing: counting votes,
 * merging what other nodes broadcast, delaying a failure so late answers can
 * still arrive, and passing the transaction on to the right neighbour.
 */
describe("Process - consensus bookkeeping (Activeprotocol)", () => {
  let savedLength: number;
  let savedConsensus: unknown;
  let savedDebug: unknown;
  let fixture: ProcessFixture;

  const nodes = voteNodes;

  const build = (spec: string, entry: any = {}, total = spec.length) => {
    fixture = buildProcess({ entry: { $nodes: nodes(spec), ...entry } });
    fixture.proc.nodeResponse = fixture.entry.$nodes.n0;
    (Process as any).networkNodeLength = total;
    return fixture;
  };

  beforeEach(() => {
    savedLength = (Process as any).networkNodeLength;
    savedConsensus = ActiveOptions.get("consensus", null);
    savedDebug = ActiveOptions.get("debug", null);
    ActiveOptions.set("consensus", { reached: 66 });
  });

  afterEach(() => {
    if (fixture) {
      clearTimeout(fixture.proc.willEmit);
      clearTimeout(fixture.proc.broadcastTimeout);
    }
    (Process as any).networkNodeLength = savedLength;
    ActiveOptions.set("consensus", savedConsensus ?? undefined);
    ActiveOptions.set("debug", savedDebug ?? undefined);
  });

  describe("updatedFromBroadcast", () => {
    it("never overwrites this node's own response with what another node broadcast", () => {
      const { proc, entry } = build("yn");
      proc.reference = "n0";
      const own = entry.$nodes.n0;

      proc.updatedFromBroadcast({ n0: { vote: false }, n1: { vote: true }, n9: { vote: true } });

      expect(entry.$nodes.n0).to.equal(own);
      expect(entry.$nodes.n0.vote).to.equal(true);
      expect(entry.$nodes.n1.vote).to.equal(true);
      expect(entry.$nodes.n9.vote).to.equal(true);
    });
  });

  describe("emitFailed", () => {
    it("reports the held failure after ten seconds, when no other node settled it", () => {
      const f = build("yn", { $broadcast: true }, 4);
      const failure = { status: 1510, error: "late" };
      const captured: Array<{ fn: Function; ms: number }> = [];
      const original = global.setTimeout;
      (global as any).setTimeout = (fn: Function, ms: number) => {
        captured.push({ fn, ms });
        return original(() => undefined, 100000);
      };
      try {
        f.proc.emitFailed(failure);
      } finally {
        global.setTimeout = original;
      }

      expect(f.events).to.deep.equal([]);
      expect(captured.map((t) => t.ms)).to.deep.equal([10000]);

      captured[0].fn();

      expect(f.events).to.deep.equal([{ event: "failed", payload: failure }]);
    });
  });

  describe("the right knock", () => {
    const withRight = (knock: (...a: any[]) => Promise<any>) => {
      const f = build("yn");
      f.proc.right = { reference: "right", knock };
      f.proc.sleep = () => Promise.resolve();
      return f;
    };

    it("returns the first answer", async () => {
      const calls: any[][] = [];
      const f = withRight((...a) => (calls.push(a), Promise.resolve({ data: "ok" })));

      expect(await f.proc.initRightKnock()).to.deep.equal({ data: "ok" });
      expect(calls).to.deep.equal([["init-legacy", f.entry]]);
    });

    it("retries a failing knock and returns once one gets through", async () => {
      let calls = 0;
      const f = withRight(() => (++calls < 3 ? Promise.reject(new Error("down")) : Promise.resolve("up")));

      expect(await f.proc.initRightKnock()).to.equal("up");
      expect(calls).to.equal(3);
    });

    it("gives up after the first attempt and three retries", async () => {
      let calls = 0;
      const f = withRight(() => (calls++, Promise.reject(new Error("down"))));

      let thrown: Error | undefined;
      try {
        await f.proc.initRightKnock();
      } catch (e) {
        thrown = e as Error;
      }

      expect(thrown?.message).to.equal("3x Right Knock Error");
      expect(calls).to.equal(4);
    });

    it("waits between attempts", async () => {
      let waited: number[] = [];
      const f = withRight(() => Promise.reject(new Error("down")));
      f.proc.sleep = (ms: number) => (waited.push(ms), Promise.resolve());

      await f.proc.initRightKnock().catch(() => undefined);

      expect(waited).to.deep.equal([1000, 1000, 1000]);
    });

    it("really sleeps for the time asked", async () => {
      const started = Date.now();
      await (Process.prototype as any).sleep(20);

      expect(Date.now() - started).to.be.at.least(15);
    });
  });

  describe("postVote", () => {
    const voted = (extra: any = {}, entry: any = {}) => {
      const f = build("y", entry);
      f.proc.nodeResponse = f.entry.$nodes.n0 = { vote: true, ...extra };
      f.proc.reference = "n0";
      const commits: any[][] = [];
      f.proc.commit = (...a: any[]) => commits.push(a);
      return { f, commits, vm: { vm: true } as any };
    };

    it("does nothing once the entry has been released", () => {
      const { f, commits, vm } = voted();
      delete f.proc.entry;

      f.proc.postVote(vm, { code: 1000, reason: "late" });

      expect(f.raised).to.deep.equal([]);
      expect(commits).to.deep.equal([]);
      expect(f.proc.voting).to.equal(false);
    });

    it("answers an instant transaction right away and then continues as a normal one", () => {
      const { f, vm } = voted({}, { $instant: true, $broadcast: true });

      f.proc.postVote(vm);

      expect(f.events[0]).to.deep.equal({ event: "commited", payload: { instant: true } });
      expect(f.entry.$instant).to.equal(false);
    });

    it("does not answer an instant transaction that voted no", () => {
      const { f, vm } = voted({}, { $instant: true, $broadcast: true });

      f.proc.postVote(vm, { code: 1000, reason: "no" });

      expect(f.events.some((e) => e.event === "commited")).to.equal(false);
      expect(f.entry.$instant).to.equal(true);
    });

    describe("passing the transaction to the right neighbour", () => {
      const direct = () => {
        const ctx = voted({}, { $broadcast: false, $origin: "origin-node" });
        ctx.f.proc.right = { reference: "right" };
        return ctx;
      };

      it("commits early with a callback that carries on to the neighbour", () => {
        const { f, commits, vm } = direct();

        f.proc.postVote(vm);

        expect(commits).to.have.length(1);
        expect(commits[0][0]).to.equal(vm);
        expect(commits[0][1]).to.be.a("function");
      });

      it("adopts the nodes the neighbour returns and then commits for real", async () => {
        const { f, commits, vm } = direct();
        const returned = { n0: { vote: true }, right: { vote: true } };
        f.proc.initRightKnock = () =>
          Promise.resolve({ data: { $nodes: returned, $territoriality: "right" } });

        f.proc.postVote(vm);
        await commits[0][1]();

        expect(f.proc.entry.$nodes).to.equal(returned);
        expect(f.proc.entry.$territoriality).to.equal("right");
        expect(f.proc.nodeResponse).to.equal(returned.n0);
        expect(commits).to.have.length(2);
        expect(commits[1]).to.deep.equal([vm]);
      });

      it("keeps its own nodes and territoriality when the neighbour returns none", async () => {
        const { f, commits, vm } = direct();
        f.entry.$territoriality = "n0";
        const own = f.entry.$nodes;
        f.proc.initRightKnock = () => Promise.resolve({ data: {} });

        f.proc.postVote(vm);
        await commits[0][1]();

        expect(f.proc.entry.$nodes).to.equal(own);
        expect(f.proc.entry.$territoriality).to.equal("n0");
      });

      it("does nothing more when the commit already happened early", async () => {
        const { f, commits, vm } = direct();
        f.proc.initRightKnock = () => Promise.resolve({ data: { $nodes: {} } });

        f.proc.postVote(vm);
        f.proc.nodeResponse.commit = true;
        await commits[0][1]();

        expect(commits).to.have.length(1);
      });

      it("records its own no after the neighbour answers, at a priority that wins", async () => {
        const { f, commits, vm } = direct();
        f.proc.initRightKnock = () =>
          Promise.resolve({ data: { $nodes: { n0: { vote: false } } } });

        f.proc.postVote(vm, { code: 1310, reason: "verify said no" });
        await commits[0][1]();

        expect(f.raised).to.deep.equal([
          { code: 1310, message: "verify said no", stop: true, priority: 10 },
        ]);
        expect(commits).to.have.length(2);
      });

      it("hides the cause of an unreachable neighbour outside debug mode", async () => {
        const { f, commits, vm } = direct();
        f.proc.initRightKnock = () => Promise.reject(new Error("3x Right Knock Error"));

        f.proc.postVote(vm);
        await commits[0][1]();

        expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
          [1501, "Bad Knock Transaction"],
        ]);
      });

      it("passes on the neighbour's own status and message in debug mode", async () => {
        const { f, commits, vm } = direct();
        ActiveOptions.set("debug", true);
        f.proc.initRightKnock = () => Promise.reject({ status: 1100, error: "remote said no" });

        f.proc.postVote(vm);
        await commits[0][1]();

        expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1100, "remote said no"]]);
      });

      it("uses 1502 in debug mode when the failure came from no node", async () => {
        const { f, commits, vm } = direct();
        ActiveOptions.set("debug", true);
        f.proc.initRightKnock = () => Promise.reject("socket closed");

        f.proc.postVote(vm);
        await commits[0][1]();

        expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1502, "socket closed"]]);
      });

      describe("when the neighbour is the origin", () => {
        const toOrigin = () => {
          const ctx = voted({}, { $broadcast: false, $origin: "right" });
          ctx.f.proc.right = { reference: "right" };
          return ctx;
        };

        it("fails the transaction back to the caller on a no", () => {
          const { f, commits, vm } = toOrigin();

          f.proc.postVote(vm, { code: 1310, reason: "verify said no" });

          expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1310, "verify said no"]]);
          expect(commits).to.deep.equal([]);
        });

        it("defaults the code of a plain error to 1000", () => {
          const { f, vm } = toOrigin();

          f.proc.postVote(vm, "plain");

          expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1000, "plain"]]);
        });

        it("commits on a yes without a knock", () => {
          const { f, commits, vm } = toOrigin();

          f.proc.postVote(vm);

          expect(commits).to.deep.equal([[vm]]);
        });
      });
    });
  });
});
