import { Process } from "../packages/protocol/src/protocol/process";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import { buildProcess, ProcessFixture, voteNodes } from "./helpers/process-fixture";

/**
 * Process.commit - deciding, after this node has voted, whether the
 * transaction commits, fails, waits for more votes or is reconciled.
 */
describe("Process.commit - the outcome of a vote (Activeprotocol)", () => {
  let savedLength: number;
  let savedConsensus: unknown;
  let savedDebug: unknown;
  let savedUpdate: typeof StreamUpdater.prototype.updateStreams;
  let updates: Array<Function | undefined>;
  let fixture: ProcessFixture;

  const vmStub = (over: any = {}): any => ({
    commit: () => Promise.resolve(),
    getInternodeCommsFromVM: () => "inter-node",
    getReturnContractData: () => "returned",
    getActivityStreamsFromVM: () => [],
    reconcile: () => Promise.resolve(false),
    ...over,
  });

  /**
   * @param spec votes per node, see voteNodes. n0 is this node.
   * @param total size of the neighbourhood
   */
  const make = (spec: string, response: any, entry: any = {}, total = spec.length, db: any = {}) => {
    fixture = buildProcess({ entry: { $nodes: voteNodes(spec), ...entry }, dbe: db });
    fixture.proc.reference = "n0";
    Object.assign(fixture.entry.$nodes.n0, response);
    fixture.proc.nodeResponse = fixture.entry.$nodes.n0;
    (Process as any).networkNodeLength = total;
    return fixture;
  };

  beforeEach(() => {
    savedLength = (Process as any).networkNodeLength;
    savedConsensus = ActiveOptions.get("consensus", null);
    savedDebug = ActiveOptions.get("debug", null);
    ActiveOptions.set("consensus", { reached: 66 });

    updates = [];
    savedUpdate = StreamUpdater.prototype.updateStreams;
    StreamUpdater.prototype.updateStreams = function (early?: Function) {
      updates.push(early);
      return Promise.resolve();
    };
  });

  afterEach(() => {
    StreamUpdater.prototype.updateStreams = savedUpdate;
    if (fixture) clearTimeout(fixture.proc.broadcastTimeout);
    (Process as any).networkNodeLength = savedLength;
    ActiveOptions.set("consensus", savedConsensus ?? undefined);
    ActiveOptions.set("debug", savedDebug ?? undefined);
  });

  const raisedSummary = (f: ProcessFixture) => f.raised.map((r) => [r.code, r.message]);

  describe("when it can commit", () => {
    it("lets the early commit callback carry on when the contract's commit throws, and says why in debug mode", async () => {
      const f = make("yyy", { vote: true });
      ActiveOptions.set("debug", true);
      let carriedOn = 0;

      await f.proc.commit(
        vmStub({ commit: () => Promise.reject(new Error("boom")) }),
        () => carriedOn++
      );

      expect(carriedOn).to.equal(1);
      expect(raisedSummary(f)).to.deep.equal([[1302, 'Commit Failure - "boom"']]);
    });
  });

  describe("when it has already committed or is committing", () => {
    for (const [label, committed, committing] of [
      ["has committed", true, false],
      ["is committing", false, true],
    ] as const) {
      it(`does not commit again but still releases the early callback when it ${label}`, async () => {
        const f = make("yyy", { vote: true, commit: committed });
        f.proc.commiting = committing;
        let released = 0;
        let commits = 0;

        await f.proc.commit(vmStub({ commit: () => (commits++, Promise.resolve()) }), () => released++);

        expect(commits).to.equal(0);
        expect(released).to.equal(1);
        expect(f.raised).to.deep.equal([]);
      });
    }
  });

  describe("direct (non broadcast) transactions", () => {
    it("fails with this node's own reason when it voted no and the network has not committed", async () => {
      const f = make("nny", { vote: false, error: "contract said no" }, { $broadcast: false });

      await f.proc.commit(vmStub());

      expect(f.raised).to.deep.equal([
        { code: 1505, message: "contract said no", stop: false, priority: undefined },
      ]);
    });

    it("fails the network round when this node voted yes and consensus was still not reached", async () => {
      const f = make("yny", { vote: true }, { $broadcast: false }, 5);

      await f.proc.commit(vmStub());

      expect(raisedSummary(f)).to.deep.equal([[1510, "Failed Network Voting Round - Non Broadcast"]]);
    });

    describe("when this node voted no but the network committed without it", () => {
      const lost = () =>
        make("nyyy", { vote: false, error: "contract said no" }, { $broadcast: false });

      it("lets the contract reconcile itself and updates its streams", async () => {
        const f = lost();
        const reconciled: any[][] = [];

        await f.proc.commit(
          vmStub({ reconcile: (...a: any[]) => (reconciled.push(a), Promise.resolve(true)) })
        );

        expect(reconciled).to.deep.equal([[f.entry.$nodes, "umid-under-test"]]);
        expect(updates).to.have.length(1);
        expect(f.events.some((e) => e.event === "commited")).to.equal(false);
      });

      it("finishes without a restore marker when reconcile throws", async () => {
        const f = lost();

        await f.proc.commit(vmStub({ reconcile: () => Promise.reject(new Error("timed out")) }));

        expect(f.events.map((e) => e.event)).to.deep.equal(["commited"]);
        expect(updates).to.have.length(0);
      });

      it("does not reconcile when the network did not reach consensus either", async () => {
        const f = make("nnyn", { vote: false, error: "contract said no" }, { $broadcast: false });
        let reconciles = 0;

        await f.proc.commit(vmStub({ reconcile: () => (reconciles++, Promise.resolve(true)) }));

        expect(reconciles).to.equal(0);
      });

      // After a failed reconcile the node holds a 1505 that restore skips. The
      // upgrade stores a 1001 with the same reason so restore will repair it.
      it("stores a restorable error when it could not reconcile", async () => {
        const posted: any[] = [];
        const f = make("nyyy", { vote: false, error: "contract said no" }, { $broadcast: false }, 4, {
          post: (doc: any) => (posted.push(doc), Promise.resolve({ id: `stored-${posted.length}` })),
        });
        // The real Shared this time, so the error really is stored
        delete f.proc.shared.raiseLedgerError;

        await f.proc.commit(vmStub());
        await new Promise((resolve) => setImmediate(resolve));

        expect(posted.map((d) => [d.code, d.reason])).to.deep.equal([
          [1505, "contract said no"],
          [1001, "contract said no"],
        ]);
        expect(f.events.filter((e) => e.event === "commited")).to.have.length(1);
      });
    });
  });

  describe("broadcast transactions waiting for votes", () => {
    describe("while consensus is still possible", () => {
      const captureTimers = async (f: ProcessFixture) => {
        const captured: Array<{ fn: Function; ms: number }> = [];
        const original = global.setTimeout;
        (global as any).setTimeout = (fn: Function, ms: number) => {
          captured.push({ fn, ms });
          // Never fires: the test calls the callback itself
          return original(() => undefined, 100000);
        };
        try {
          await f.proc.commit(vmStub());
        } finally {
          global.setTimeout = original;
        }
        return captured;
      };

      it("raises nothing yet and gives the missing nodes a minute to answer", async () => {
        const f = make("yn", { vote: true }, { $broadcast: true }, 4);

        const timers = await captureTimers(f);

        expect(f.raised).to.deep.equal([]);
        expect(timers.map((t) => t.ms)).to.deep.equal([60000]);
      });

      it("fails the round when the nodes never answer", async () => {
        const f = make("yn", { vote: true }, { $broadcast: true }, 4);
        const [timer] = await captureTimers(f);

        timer.fn();

        expect(raisedSummary(f)).to.deep.equal([
          [1510, "Failed Network Voting Timeout - Voters Timed Out"],
        ]);
      });

      it("does not fail the round if this node started committing in the meantime", async () => {
        const f = make("yn", { vote: true }, { $broadcast: true }, 4);
        const [timer] = await captureTimers(f);
        f.proc.commiting = true;

        timer.fn();

        expect(f.raised).to.deep.equal([]);
      });
    });
  });
});
