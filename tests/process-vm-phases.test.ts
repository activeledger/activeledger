import { Process } from "../packages/protocol/src/protocol/process";
import { expect } from "chai";
import "mocha";
import { buildProcess, ProcessFixture } from "./helpers/process-fixture";

/**
 * Process driving the contract through the VM: initialise, verify, vote (or
 * read), plus the data it has to fetch first (contract data, read only
 * streams) and what it does when any of that fails.
 */
describe("Process - VM phases (Activeprotocol)", () => {
  let fixture: ProcessFixture;
  let calls: string[];
  let postVoted: any[][];
  let commits: any[][];

  const vmStub = (over: any = {}): any => ({
    initialise: () => (calls.push("initialise"), Promise.resolve()),
    verify: () => (calls.push("verify"), Promise.resolve()),
    vote: () => (calls.push("vote"), Promise.resolve(true)),
    read: (...a: any[]) => (calls.push(`read:${a[1]}`), Promise.resolve("read result")),
    getReturnContractData: () => "returned",
    getInternodeCommsFromVM: () => "inter-node",
    clearingInternodeCommsFromVM: () => false,
    ...over,
  });

  const make = (entry: any = {}) => {
    fixture = buildProcess({
      entry: { $tx: { $namespace: "ns", $contract: "abc", $i: { a: {} }, $o: {} }, ...entry },
    });
    calls = [];
    postVoted = [];
    commits = [];
    fixture.proc.nodeResponse = fixture.entry.$nodes.self;
    fixture.proc.postVote = (...a: any[]) => postVoted.push(a);
    fixture.proc.commit = (...a: any[]) => commits.push(a);
    return fixture;
  };

  const payload: any = { umid: "umid-under-test" };

  describe("handleVM", () => {
    it("stops at a contract that fails to initialise", async () => {
      const f = make();

      await f.proc.handleVM(
        vmStub({ initialise: () => Promise.reject(new Error("no worker")) }),
        payload,
        "abc.js"
      );

      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
        [1401, 'VM Init Failure - "no worker"'],
      ]);
      expect(calls).to.deep.equal([]);
      expect(postVoted).to.deep.equal([]);
    });

    it("stops at a contract that fails verification", async () => {
      const f = make();

      await f.proc.handleVM(
        vmStub({ verify: () => (calls.push("verify"), Promise.reject(new Error("bad signature"))) }),
        payload,
        "abc.js"
      );

      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1310, "bad signature"]]);
      // A contract that failed verification must not go on to vote
      expect(calls).to.deep.equal(["initialise", "verify"]);
      expect(postVoted).to.deep.equal([]);
    });

    it("commits straight away when the contract names this node the leader", async () => {
      const f = make();
      const vm = vmStub({ vote: () => Promise.resolve({ leader: true }) });

      await f.proc.handleVM(vm, payload, "abc.js");

      expect(f.proc.nodeResponse.vote).to.equal(true);
      expect(f.proc.nodeResponse.leader).to.equal(true);
      expect(commits).to.deep.equal([[vm]]);
      expect(postVoted).to.deep.equal([]);
    });

    describe("a transaction with no inputs is a read", () => {
      const reading = (extra: any = {}) =>
        make({ $tx: { $namespace: "ns", $contract: "abc", $o: {}, ...extra } });

      it("answers with what the contract's read returns and does not vote", async () => {
        const f = reading();

        await f.proc.handleVM(vmStub(), payload, "abc.js");

        expect(f.proc.nodeResponse.return).to.equal("read result");
        expect(f.proc.nodeResponse.commit).to.equal(true);
        expect(f.events).to.deep.equal([{ event: "commited", payload: undefined }]);
        expect(calls).to.deep.equal(["initialise", "verify", "read:read"]);
        expect(postVoted).to.deep.equal([]);
      });

      it("calls the entry point the transaction names", async () => {
        const f = reading({ $entry: "balance" });

        await f.proc.handleVM(vmStub(), payload, "abc.js");

        expect(calls).to.include("read:balance");
      });

      it("reports a read that throws, and still finishes", async () => {
        const f = reading();

        await f.proc.handleVM(
          vmStub({ read: () => Promise.reject({ reason: "no such entry" }) }),
          payload,
          "abc.js"
        );

        expect(f.proc.nodeResponse.error).to.equal('Read Error - {"reason":"no such entry"}');
        expect(f.proc.nodeResponse.early).to.equal(false);
        expect(f.events.map((e) => e.event)).to.deep.equal(["commited"]);
      });
    });
  });

  describe("process", () => {
    it("raises a read only stream failure and passes the error on", async () => {
      const f = make();
      f.proc.contractLocation = "/c/ns/abc.js";
      const failure = new Error("stream gone");
      f.proc.getReadOnlyStreams = () => Promise.reject(failure);

      let thrown: unknown;
      try {
        await f.proc.process([], []);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).to.equal(failure);
      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
        [1210, "Read Only Stream Error"],
      ]);
    });
  });

  describe("getReadOnlyStreams", () => {
    it("is empty when the transaction reads nothing", async () => {
      const f = make();

      expect(await f.proc.getReadOnlyStreams()).to.deep.equal({});
    });

    it("returns each stream's state without its database fields", async () => {
      const f = make({ $tx: { $namespace: "ns", $contract: "abc", $i: {}, $r: { a: "id-a", b: "id-b" } } });
      const asked: string[] = [];
      f.proc.db = {
        get: (id: string) => (
          asked.push(id),
          Promise.resolve({ _id: id, _rev: "1-x", balance: id === "id-a" ? 1 : 2 })
        ),
      };

      expect(await f.proc.getReadOnlyStreams()).to.deep.equal({ a: { balance: 1 }, b: { balance: 2 } });
      expect(asked.sort()).to.deep.equal(["id-a", "id-b"]);
    });

    it("fails when a read only stream cannot be fetched", async () => {
      const f = make({ $tx: { $namespace: "ns", $contract: "abc", $i: {}, $r: { a: "id-a" } } });
      const missing = new Error("missing");
      f.proc.db = { get: () => Promise.reject(missing) };

      let thrown: unknown;
      try {
        await f.proc.getReadOnlyStreams();
      } catch (e) {
        thrown = e;
      }

      expect(thrown).to.equal(missing);
    });
  });

  describe("getContractDate", () => {
    const withData = (exists: boolean, processed: () => Promise<any>) => {
      const f = make();
      f.proc.contractId = "abc";
      f.proc.db = { exists: () => Promise.resolve(exists) };
      f.proc.permissionChecker = { process: processed };
      return f;
    };

    it("starts a contract with no data record from empty data and caches that", async () => {
      const f = withData(false, () => Promise.reject(new Error("not asked")));

      expect(await f.proc.getContractDate(undefined)).to.deep.equal({ _id: "", data: {} });
      expect(f.events).to.deep.equal([
        { event: "contractData", payload: { contract: "abc", data: { _id: "", data: {} } } },
      ]);
    });

    it("reads a contract's data record as a checked output stream", async () => {
      const state = { _id: "abc:data", _rev: "3-x", data: { n: 1 } };
      const f = withData(true, () => Promise.resolve([{ state }]));

      expect(await f.proc.getContractDate(undefined)).to.equal(state);
      expect(f.events).to.deep.equal([
        { event: "contractData", payload: { contract: "abc", data: state } },
      ]);
    });

    it("clears the cached data and fails on a position error, so the node can recover", async () => {
      const position = { code: 1200, reason: "Output Stream Position Incorrect" };
      const f = withData(true, () => Promise.reject(position));

      let thrown: unknown;
      try {
        await f.proc.getContractDate(undefined);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).to.equal(position);
      expect(f.events).to.deep.equal([
        { event: "contractData", payload: { contract: "abc", data: {} } },
      ]);
    });

    it("carries on without data when the record cannot be read for another reason", async () => {
      const f = withData(true, () => Promise.reject(new Error("not there yet")));

      expect(await f.proc.getContractDate(undefined)).to.equal(undefined);
    });

    describe("with data that was cached", () => {
      it("fails on a position error when the revision differs from the transaction's", async () => {
        const f = withData(true, () => Promise.reject(new Error("not asked")));
        f.entry.$revs = { $i: {}, $o: { "abc:data": "0-context:1-old" } };

        let thrown: any;
        try {
          await f.proc.getContractDate({ _id: "abc:data", _rev: "2-new", data: {} });
        } catch (e) {
          thrown = e;
        }

        expect(thrown).to.deep.equal({ code: 1200, reason: "Output Stream Position Incorrect" });
        expect(f.events).to.deep.equal([
          { event: "contractData", payload: { contract: "abc", data: {} } },
        ]);
      });

      it("accepts it when the revision matches", async () => {
        const f = withData(true, () => Promise.reject(new Error("not asked")));
        f.entry.$revs = { $i: {}, $o: { "abc:data": "0-context:2-new" } };
        const cached = { _id: "abc:data", _rev: "2-new", data: {} };

        expect(await f.proc.getContractDate(cached)).to.equal(cached);
        expect(f.events).to.deep.equal([]);
      });
    });
  });

  describe("destroy", () => {
    it("releases a direct transaction's VM state and entry a minute later", () => {
      const f = make();
      const vm = (Process as any).generalContractVM;
      const destroyed: string[] = [];
      const ownDestroy = Object.prototype.hasOwnProperty.call(vm, "destroy");
      const originalDestroy = vm.destroy;
      vm.destroy = (umid: string) => destroyed.push(umid);
      const captured: Array<{ fn: Function; ms: number }> = [];
      const originalTimeout = global.setTimeout;
      (global as any).setTimeout = (fn: Function, ms: number) => {
        captured.push({ fn, ms });
        return originalTimeout(() => undefined, 0);
      };

      try {
        f.proc.destroy("umid-under-test");
        // Nothing is released yet: an early commit still needs the entry
        expect(destroyed).to.deep.equal([]);
        expect(f.proc.entry).to.not.equal(undefined);
        expect(captured.map((t) => t.ms)).to.deep.equal([60000]);

        captured[0].fn();

        expect(destroyed).to.deep.equal(["umid-under-test"]);
        expect(f.proc.entry).to.equal(undefined);
      } finally {
        global.setTimeout = originalTimeout;
        if (ownDestroy) vm.destroy = originalDestroy;
        else delete vm.destroy;
      }
    });
  });
});
