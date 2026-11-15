import { Process } from "../packages/protocol/src/protocol/process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { EventEmitter } from "events";
import { expect } from "chai";
import "mocha";
import { buildProcess, ProcessFixture, voteNodes } from "./helpers/process-fixture";

/**
 * What a mutation pass over Process found nothing checking: how a failure is
 * held back or sent, what a broadcast does to a transaction still being
 * decided, what a hybrid dry run reports and records, and the small rules
 * around contract versions and the contract path cache.
 */
describe("Process - mutation gaps (Activeprotocol)", () => {
  let savedLength: number;
  let savedConsensus: unknown;
  let fixture: ProcessFixture | undefined;

  beforeEach(() => {
    savedLength = (Process as any).networkNodeLength;
    savedConsensus = ActiveOptions.get("consensus", null);
    ActiveOptions.set("consensus", { reached: 60 });
  });
  afterEach(() => {
    if (fixture) {
      clearTimeout(fixture.proc.willEmit);
      clearTimeout(fixture.proc.broadcastTimeout);
      fixture = undefined;
    }
    (Process as any).networkNodeLength = savedLength;
    ActiveOptions.set("consensus", savedConsensus ?? undefined);
  });

  const make = (spec: string, entry: any = {}, total = spec.length) => {
    fixture = buildProcess({ entry: { $nodes: voteNodes(spec), ...entry } });
    fixture.proc.reference = "n0";
    fixture.proc.nodeResponse = fixture.entry.$nodes.n0;
    (Process as any).networkNodeLength = total;
    return fixture;
  };

  describe("emitFailed", () => {
    const failure = { status: 1510, error: "no" };

    it("clears the committing state", () => {
      const f = make("yn");
      f.proc.commiting = true;
      f.proc.emitFailed(failure);
      expect(f.proc.commiting).to.equal(false);
    });

    it("tells the client straight away when told not to wait, even for a broadcast with votes outstanding", () => {
      const f = make("yn", { $broadcast: true }, 4);
      f.proc.emitFailed(failure, true);
      expect(f.events.map((e) => e.event)).to.deep.equal(["failed"]);
      expect(f.proc.willEmit).to.equal(undefined);
    });

    it("tells the client straight away when the transaction is not a broadcast, even with votes outstanding", () => {
      const f = make("yn", { $broadcast: false }, 4);
      f.proc.emitFailed(failure);
      expect(f.events.map((e) => e.event)).to.deep.equal(["failed"]);
      expect(f.proc.willEmit).to.equal(undefined);
    });

    it("holds a broadcast failure back while votes are outstanding", () => {
      const f = make("yn", { $broadcast: true }, 4);
      f.proc.emitFailed(failure);
      expect(f.events).to.have.length(0);
      expect(f.proc.willEmit).to.not.equal(undefined);
      expect(f.proc.willEmitData).to.equal(failure);
    });

    it("sends a broadcast failure straight away when every vote is in and it cannot commit", () => {
      const f = make("nn", { $broadcast: true }, 2);
      f.proc.emitFailed(failure);
      expect(f.events.map((e) => e.event)).to.deep.equal(["failed"]);
    });

    it("sends it once a peer has reported its streams", () => {
      const f = make("yn", { $broadcast: true }, 4);
      f.entry.$nodes.n1.streams = {};
      f.proc.emitFailed(failure);
      expect(f.events.map((e) => e.event)).to.deep.equal(["failed"]);
    });

    it("sends the held failure, not the new one, when one is already waiting", () => {
      const f = make("yn", { $broadcast: true }, 4);
      f.proc.emitFailed(failure);
      f.proc.emitFailed({ status: 1, error: "later" });
      expect(f.events).to.have.length(1);
      expect(f.events[0].payload).to.equal(failure);
    });
  });

  describe("updatedFromBroadcast", () => {
    const waiting = (f: ProcessFixture, failed: any[]) => {
      f.proc.willEmit = setTimeout(() => undefined, 60_000);
      f.proc.willEmitData = { status: 1510, error: "no" };
      f.proc.emitFailed = (...a: any[]) => failed.push(a);
    };

    it("fails a waiting transaction once every vote is in and it cannot commit", () => {
      const f = make("nn", {}, 2);
      const failed: any[] = [];
      waiting(f, failed);
      f.proc.updatedFromBroadcast({});
      expect(failed).to.have.length(1);
    });

    it("does not fail a waiting transaction that can still commit", () => {
      const f = make("yy", {}, 2);
      const failed: any[] = [];
      waiting(f, failed);
      f.proc.updatedFromBroadcast({});
      expect(failed).to.have.length(0);
    });

    it("does not fail a waiting transaction while votes are outstanding", () => {
      const f = make("nn", {}, 4);
      const failed: any[] = [];
      waiting(f, failed);
      f.proc.updatedFromBroadcast({});
      expect(failed).to.have.length(0);
    });

    it("fails a waiting transaction as soon as a peer reports its streams", () => {
      const f = make("nn", {}, 4);
      const failed: any[] = [];
      waiting(f, failed);
      f.proc.updatedFromBroadcast({ n1: { vote: false, streams: {} } });
      expect(failed).to.have.length(1);
    });

    it("runs the commit when nothing is waiting and the vote is not still going", () => {
      const f = make("yyy");
      const commits: any[] = [];
      f.proc.commit = (...a: any[]) => commits.push(a);
      f.proc.voting = false;
      f.proc.updatedFromBroadcast({});
      expect(commits).to.have.length(1);
    });

    it("does not run the commit while this node is still voting", () => {
      const f = make("yyy");
      const commits: any[] = [];
      f.proc.commit = (...a: any[]) => commits.push(a);
      f.proc.voting = true;
      f.proc.updatedFromBroadcast({});
      expect(commits).to.have.length(0);
    });

    it("does not touch a transaction that is already committing", () => {
      const f = make("yyy");
      const commits: any[] = [];
      f.proc.commit = (...a: any[]) => commits.push(a);
      f.proc.voting = false;
      f.proc.commiting = true;
      f.proc.updatedFromBroadcast({ n1: { vote: false } });
      expect(commits).to.have.length(0);
      expect(f.entry.$nodes.n1.vote).to.equal(true);
    });

    it("never overwrites this node's own answer", () => {
      const f = make("yyy");
      f.proc.voting = true;
      f.proc.updatedFromBroadcast({ n0: { vote: false }, n1: { vote: false } });
      expect(f.entry.$nodes.n0.vote).to.equal(true);
      expect(f.entry.$nodes.n1.vote).to.equal(false);
    });
  });

  describe("starting to process a broadcast transaction", () => {
    const run = async (entry: any, localOnly = false) => {
      const f = make("y", entry);
      f.proc.contractLocation = "/c/ns/abc.js";
      f.proc.localOnly = localOnly;
      f.proc.getReadOnlyStreams = async () => ({});
      f.proc.handleVM = () => undefined;
      await f.proc.process([], []);
      return f.events.filter((e) => e.event === "broadcast");
    };

    it("asks for a broadcast when this node is the origin", async () => {
      const sent = await run({ $broadcast: true, $origin: "n0" });
      expect(sent).to.have.length(1);
      expect(sent[0].payload).to.equal(true);
    });
    it("leaves the broadcast to the origin when this node is not it", async () => {
      expect(await run({ $broadcast: true, $origin: "elsewhere" })).to.have.length(0);
    });
    it("does not broadcast a transaction that is not one", async () => {
      expect(await run({ $broadcast: false, $origin: "n0" })).to.have.length(0);
    });
    it("does not broadcast one that is being waited on", async () => {
      expect(await run({ $broadcast: true, $origin: "n0", $wait: true })).to.have.length(0);
    });
    it("does not broadcast from a hybrid", async () => {
      expect(await run({ $broadcast: true, $origin: "n0" }, true)).to.have.length(0);
    });
  });

  describe("voting", () => {
    const vmStub = (vote: any) => ({
      initialise: () => Promise.resolve(),
      verify: () => Promise.resolve(),
      vote: () => Promise.resolve(vote),
      getReturnContractData: () => "returned",
      getInternodeCommsFromVM: () => "inter",
      clearingInternodeCommsFromVM: () => false,
    });
    const handle = async (vote: any) => {
      const f = make("y", { $tx: { $namespace: "ns", $contract: "abc", $i: { a: {} }, $o: {} } });
      const commits: any[] = [];
      const postVoted: any[] = [];
      f.proc.commit = (...a: any[]) => commits.push(a);
      f.proc.postVote = (...a: any[]) => postVoted.push(a);
      await f.proc.handleVM(vmStub(vote), { umid: "umid-under-test" }, "abc.js");
      return { f, commits, postVoted };
    };

    it("only starts out voting", () => {
      expect(make("y").proc.voting).to.equal(true);
    });

    it("does not commit early for a vote that is an object but names no leader", async () => {
      const { commits, postVoted } = await handle({ leader: false });
      expect(commits).to.have.length(0);
      expect(postVoted).to.have.length(1);
    });

    it("does not commit early for a plain yes", async () => {
      const { commits, postVoted } = await handle(true);
      expect(commits).to.have.length(0);
      expect(postVoted).to.have.length(1);
    });
  });

  describe("postVote in hybrid mode", () => {
    const hybridError = (error: any) => {
      const f = make("y");
      f.proc.localOnly = true;
      f.proc.postVote({}, error);
      return f;
    };

    it("raises the error's own code and reason", () => {
      const f = hybridError({ code: 1234, reason: "because" });
      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1234, "because"]]);
      expect(f.entry.$nodes.n0.error).to.equal("because");
    });

    it("falls back to code 1000 and to the error itself", () => {
      const f = hybridError("plain text");
      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([[1000, "plain text"]]);
    });
  });

  describe("getContractDate", () => {
    it("carries on when the contract's data record comes back empty", async () => {
      const f = make("y");
      f.proc.isDefault = false;
      f.proc.contractId = "c".repeat(64);
      f.proc.db = { exists: async () => true };
      f.proc.permissionChecker = { process: async () => [] };
      await f.proc.getContractDate(undefined);
      expect(f.raised).to.deep.equal([]);
    });
  });

  describe("contract versions", () => {
    it("orders versions by number, not as text", () => {
      const { proc } = make("y");
      expect(proc.sortVersions("1.10.0", "1.2.0")).to.be.greaterThan(0);
      expect(proc.sortVersions("1.2.0", "1.10.0")).to.be.lessThan(0);
      expect(proc.sortVersions("10.0.0", "2.0.0")).to.be.greaterThan(0);
      expect(proc.sortVersions("1.2.3", "1.2.3")).to.equal(0);
    });
  });

  describe("clearContractPathCache", () => {
    const cache = () => (Process as any).contractPathCache as { [k: string]: string };
    let saved: any;
    beforeEach(() => {
      saved = { ...cache() };
      for (const k of Object.keys(cache())) delete cache()[k];
    });
    afterEach(() => {
      for (const k of Object.keys(cache())) delete cache()[k];
      Object.assign(cache(), saved);
    });

    it("removes the entry for the contract and any path that mentions it, and keeps the rest", () => {
      Object.assign(cache(), {
        target: "/c/other.js",
        "ns:other": "/c/target/v1.js",
        unrelated: "/c/else.js",
      });
      Process.clearContractPathCache("target");
      expect(Object.keys(cache())).to.deep.equal(["unrelated"]);
    });

    it("removes the entry that is keyed by the contract even if no path mentions it", () => {
      Object.assign(cache(), { target: "/c/a.js", other: "/c/b.js" });
      Process.clearContractPathCache("target");
      expect(Object.keys(cache())).to.deep.equal(["other"]);
    });

    it("removes everything when no contract is named", () => {
      Object.assign(cache(), { a: "/a", b: "/b" });
      Process.clearContractPathCache();
      expect(Object.keys(cache())).to.deep.equal([]);
    });
  });

  describe("hybrid mode", () => {
    const hybrid = (db: any = {}, entry: any = {}) =>
      buildProcess({ db, entry: { $nodes: { self: {} }, ...entry }, processOptions: { mode: "hybrid" } });

    it("runs on this node alone, without being the supernode, and as a dry run", () => {
      const { proc } = hybrid();
      expect(proc.localOnly).to.equal(true);
      expect(proc.execution.supernode).to.equal(false);
      expect(proc.execution.dryRun).to.equal(true);
    });

    it("records what is written instead of writing it, and answers that it worked", async () => {
      const { proc } = hybrid({ get: async (id: string) => ({ id }) });
      expect(await proc.db.post({ _id: "a", n: 1 })).to.deep.equal({ ok: true });
      expect(await proc.db.put({ _id: "b" })).to.deep.equal({ ok: true });
      expect(await proc.db.bulkDocs([{ _id: "c" }, { _id: "d" }])).to.deep.equal({ ok: true });
      expect(proc.written.db.map((d: any) => d._id)).to.deep.equal(["a", "b", "c", "d"]);
      for (const call of ["purge", "drop", "createIndex"]) {
        expect(await proc.db[call](), call).to.deep.equal({ ok: true });
      }
    });

    it("snapshots a document, so later changes to it are not recorded", async () => {
      const { proc } = hybrid();
      const doc: any = { _id: "a", n: 1 };
      await proc.db.post(doc);
      doc.n = 2;
      expect(proc.written.db[0].n).to.equal(1);
    });

    it("reads from the real store, with its own `this`, and passes plain properties through", async () => {
      const real: any = { name: "real", get: async function (this: any, id: string) { return `${this.name}:${id}`; }, location: "http://x/db" };
      const { proc } = hybrid(real);
      expect(await proc.db.get("s1")).to.equal("real:s1");
      expect(proc.db.location).to.equal("http://x/db");
    });

    it("works over a store that has no methods at all", async () => {
      const { proc } = buildProcess({ db: undefined, processOptions: { mode: "hybrid" } });
      expect(await proc.db.post({ _id: "a" })).to.deep.equal({ ok: true });
    });
  });

  describe("dryRun", () => {
    const realVM = (Process as any).generalContractVM;
    afterEach(() => {
      (Process as any).generalContractVM = realVM;
    });
    const withVM = () => {
      (Process as any).generalContractVM = {
        getExecutionReport: () => ({ supernodeDependent: true, dependence: ["d"], adopt: ["a"] }),
        getEvents: () => [{ event: "e" }],
      };
    };
    const hybrid = (finishWith: (p: any) => void) => {
      const f = buildProcess({ processOptions: { mode: "hybrid" } });
      withVM();
      f.proc.destroy = () => undefined;
      // the fixture records emitted events; dryRun listens for real ones
      f.proc.emit = EventEmitter.prototype.emit.bind(f.proc);
      f.proc.start = async () => finishWith(f.proc);
      return f;
    };

    it("refuses to run outside hybrid mode", async () => {
      const f = buildProcess();
      let message = "";
      await f.proc.dryRun().catch((e: Error) => (message = e.message));
      expect(message).to.equal("dryRun needs a Process in hybrid mode");
    });

    it("reports a commit with what was written, sorted into streams, volatile and the umid document", async () => {
      const f = hybrid((p) => {
        p.written.db.push({ _id: "s1", v: 1 }, { _id: "s1:volatile" }, { _id: "umid-under-test:umid" }, {});
        p.nodeResponse = { vote: true, commit: true, return: "r" };
        p.emit("commited");
      });
      const got = await f.proc.dryRun();
      expect(got.umid).to.equal("umid-under-test");
      expect(got.vote).to.equal(true);
      expect(got.committed).to.equal(true);
      expect(got.documents).to.deep.equal({ s1: { _id: "s1", v: 1 } });
      expect(got.volatile).to.deep.equal({ "s1:volatile": { _id: "s1:volatile" } });
      expect(got.umidDoc).to.deep.equal({ _id: "umid-under-test:umid" });
      expect(got.return).to.equal("r");
      expect(got.events).to.deep.equal([{ event: "e" }]);
      expect(got.supernodeDependent).to.equal(true);
      expect(got.dependence).to.deep.equal(["d"]);
      expect(got.adopt).to.deep.equal(["a"]);
      expect(got.error).to.equal(undefined);
    });

    it("does not call it committed when this node never committed", async () => {
      const f = hybrid((p) => {
        p.nodeResponse = { vote: true };
        p.emit("commited");
      });
      expect((await f.proc.dryRun()).committed).to.equal(false);
    });

    it("does not call it committed when it carries an error", async () => {
      const f = hybrid((p) => {
        p.nodeResponse = { vote: true, commit: true, error: "late" };
        p.emit("commited");
      });
      const got = await f.proc.dryRun();
      expect(got.committed).to.equal(false);
      expect(got.error).to.equal("late");
    });

    it("reports a no vote with the reason the failure gave", async () => {
      const f = hybrid((p) => {
        p.nodeResponse = { vote: false };
        p.emit("failed", { status: 1510, error: new Error("it said no") });
      });
      const got = await f.proc.dryRun();
      expect(got.vote).to.equal(false);
      expect(got.error).to.equal("it said no");
    });

    it("takes a reason from an object that has one instead of a message", async () => {
      const f = hybrid((p) => p.emit("failed", { error: { reason: "by reason" } }));
      expect((await f.proc.dryRun()).error).to.equal("by reason");
    });

    it("says it failed when the failure gives no reason", async () => {
      const f = hybrid((p) => p.emit("failed"));
      expect((await f.proc.dryRun()).error).to.equal("Failed");
    });

    it("reports an error thrown while starting", async () => {
      const f = hybrid(() => {
        throw new Error("could not start");
      });
      expect((await f.proc.dryRun()).error).to.equal("could not start");
    });

    it("reports once, however many times it finishes, and stops listening", async () => {
      const f = hybrid((p) => {
        p.emit("commited");
        p.emit("failed", { error: "second" });
      });
      const got = await f.proc.dryRun();
      expect(got.error).to.equal(undefined);
      expect(f.proc.listenerCount("commited")).to.equal(0);
      expect(f.proc.listenerCount("failed")).to.equal(0);
    });
  });

  describe("dryRunHybrid", () => {
    it("runs a copy of the entry as one node with no broadcast, and leaves the entry alone", async () => {
      const entry: any = {
        $umid: "u1",
        $tx: { $namespace: "default", $contract: "onboard", $i: {}, $o: {} },
        $revs: { $i: { a: "1-x" }, $o: {} },
        $nodes: { other: {} },
        $broadcast: true,
        $instant: true,
        $territoriality: "someone",
        $sigs: {},
      };
      const before = JSON.stringify(entry);
      let seen: any;
      const realDry = Process.prototype.dryRun;
      Process.prototype.dryRun = function (this: any, version?: string) {
        seen = { entry: this.entry, reference: this.reference, selfHost: this.selfHost, version };
        return Promise.resolve({ umid: "u1" } as any);
      };
      const fs = await import("fs");
      fs.writeFileSync("./packages/protocol/src/protocol/vmscript.js", "{}");
      try {
        await Process.dryRunHybrid(entry, {} as any, { contractVersion: "2.0.0" });
        expect(seen.reference).to.equal("hybrid");
        expect(seen.selfHost).to.equal("hybrid");
        expect(seen.version).to.equal("2.0.0");
        expect(seen.entry.$broadcast).to.equal(false);
        expect(seen.entry.$instant).to.equal(false);
        expect(seen.entry.$territoriality).to.equal(undefined);
        expect(Object.keys(seen.entry.$nodes)).to.deep.equal(["hybrid"]);
        seen.entry.$revs.$i.a = "changed";
        await Process.dryRunHybrid(entry, {} as any, { reference: "mine", selfHost: "host" });
        expect(seen.reference).to.equal("mine");
        expect(seen.selfHost).to.equal("host");
      } finally {
        Process.prototype.dryRun = realDry;
        if (fs.existsSync("./packages/protocol/src/protocol/vmscript.js")) fs.unlinkSync("./packages/protocol/src/protocol/vmscript.js");
      }
      expect(JSON.stringify(entry)).to.equal(before);
    });
  });
});

describe("Process - small hand-offs (Activeprotocol)", () => {
  it("hands back what the event flush gives, so a caller can wait on it", async () => {
    const { StreamUpdater } = await import("../packages/protocol/src/protocol/streamUpdater");
    const real = StreamUpdater.flushEventPosts;
    const sentinel = Promise.resolve();
    let asked: number | undefined;
    StreamUpdater.flushEventPosts = ((ms?: number) => ((asked = ms), sentinel)) as any;
    try {
      expect(Process.flushEventRecords(1234)).to.equal(sentinel);
      expect(asked).to.equal(1234);
    } finally {
      StreamUpdater.flushEventPosts = real;
    }
  });
});
