import { expect } from "chai";
import "mocha";
import { buildProcess, ProcessFixture } from "./helpers/process-fixture";

/**
 * Leader mode: a transaction asks for it with $tx.$leader, the entry node
 * holds the broadcast until its own vote is yes, and a no is the answer.
 */
describe("Process - leader mode (Activeprotocol)", () => {
  let fixture: ProcessFixture;
  const make = (entry: any = {}, tx: any = {}, options?: any) => {
    fixture = buildProcess({
      entry: { $broadcast: true, $tx: { $namespace: "ns", $contract: "abc", $i: { a: {} }, $o: {}, ...tx }, ...entry },
      processOptions: options,
    });
    fixture.proc.nodeResponse = fixture.entry.$nodes.self;
    fixture.proc.commit = () => undefined;
    return fixture;
  };

  describe("asksForLeader", () => {
    const asks = (f: ProcessFixture) => f.proc.asksForLeader() as boolean;

    it("is true for $leader: true inside the signed $tx", () => {
      expect(asks(make({}, { $leader: true }))).to.equal(true);
    });
    it("is false without it, with anything but true, or outside $tx (unsigned)", () => {
      expect(asks(make())).to.equal(false);
      expect(asks(make({}, { $leader: "true" }))).to.equal(false);
      expect(asks(make({ $leader: true }))).to.equal(false);
    });
    it("is false for a unanimous transaction, which needs every vote", () => {
      expect(asks(make({ $unanimous: true }, { $leader: true }))).to.equal(false);
    });
    it("is false for a hybrid (local only) run", () => {
      expect(asks(make({}, { $leader: true }, { mode: "hybrid" }))).to.equal(false);
    });
  });

  describe("while the broadcast is held", () => {
    it("fails at once, not after waiting on votes from a network that was never told", () => {
      const f = make({}, { $leader: true });
      f.proc.broadcastHeld = true;
      f.proc.emitFailed({ status: 1000, error: "nope" });
      expect(f.events.map((e) => e.event)).to.deep.equal(["failed"]);
      expect(f.proc.willEmit).to.equal(undefined);
    });

    it("a vote error ends it in the response, nothing is broadcast, and the error is kept for repair", () => {
      const f = make({}, { $leader: true });
      f.proc.broadcastHeld = true;
      f.proc.postVote({}, { code: 1200, reason: "Output Stream Position Incorrect" });
      expect(f.raised).to.deep.equal([{ code: 1200, message: "Output Stream Position Incorrect", stop: false, priority: 0, noWait: true }]);
      expect(f.events.map((e) => e.event)).to.not.include("broadcast");
      expect(f.entry.$nodes.self.error).to.equal("Output Stream Position Incorrect");
    });

    it("a yes the contract did not take as a leader vote carries on as a normal transaction", () => {
      const f = make({}, { $leader: true });
      f.proc.broadcastHeld = true;
      f.proc.postVote({});
      expect(f.proc.broadcastHeld).to.equal(false);
      expect(f.raised).to.deep.equal([]);
      expect(f.events.map((e) => e.event)).to.include("broadcast");
    });
  });

  it("without the hold a transaction fails as before (it waits for the votes it is owed)", () => {
    const f = make({}, {});
    f.proc.emitFailed({ status: 1000, error: "nope" });
    expect(f.events.map((e) => e.event)).to.not.include("failed");
    clearTimeout(f.proc.willEmit);
  });
});
