import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";
import { ReadLock } from "../packages/protocol/src/protocol/readlock";

// The setters that write lock fields only work on a new stream, but a
// contract holds the meta object itself. This is the check on what is about
// to be written, against what the stream was loaded with.
describe("Commit guard: stream locks are fixed at creation (Activeprotocol)", () => {
  const LOADED = { ns: "owner", readLock: { volatile: ["a"] }, contractlock: ["c"], namespaceLock: ["owner"] };

  const run = async (
    meta: any,
    opts: { namespace?: string; build?: number; loaded?: any } = {}
  ) => {
    const raised: any[] = [];
    const updater: any = Object.create(StreamUpdater.prototype);
    updater.entry = {
      $umid: "u".repeat(64),
      $datetime: "2026-06-01T12:00:00.000Z",
      $tx: { $namespace: opts.namespace ?? "foreign" },
    };
    updater.streams = [{ state: { _id: "s" }, meta: { _id: "s:stream", ...meta }, volatile: { _id: "s:volatile" } }];
    updater.docs = [];
    updater.refStreams = { new: [], updated: [] };
    updater.shared = {
      raiseLedgerError: (code: number, error: Error) => raised.push({ code, message: error.message }),
      filterPrefix: (id: string) => id,
      assumedVirtualPrefix: "",
    };
    const snapshot = ReadLock.snapshot([{ state: { _id: "s" }, meta: opts.loaded ?? LOADED }] as any);
    updater.virtualMachine = { getEvents: () => [], getLoadedLocks: () => snapshot };
    updater.detectCollisions = async () => undefined;
    const before = ActiveOptions.get<number>("build", 0);
    ActiveOptions.set("build", opts.build ?? ReadLock.BUILD);
    try {
      await updater.processStreams();
    } catch {
      // The fixture is thin; only the guard's verdict matters
    } finally {
      ActiveOptions.set("build", before);
    }
    return raised;
  };

  const existing = (changes: any = {}) => ({ _rev: "1-a", ...LOADED, ...changes });

  it("lets an existing stream through when its locks are as loaded", async () => {
    expect(await run(existing())).to.deep.equal([]);
  });

  it("refuses an existing stream whose read lock was removed or changed", async () => {
    for (const changes of [{ readLock: undefined }, { readLock: {} }, { readLock: { volatile: "*" } }]) {
      const raised = await run(existing(changes));
      expect(raised, JSON.stringify(changes)).to.have.length(1);
      expect(raised[0].code).to.equal(1238);
      expect(raised[0].message).to.contain("readLock");
    }
  });

  it("refuses a change to the contract lock, namespace lock or creator namespace", async () => {
    for (const [field, value] of [
      ["contractlock", ["other"]],
      ["namespaceLock", undefined],
      ["ns", "foreign"],
    ] as const) {
      const raised = await run(existing({ [field]: value }));
      expect(raised, field).to.have.length(1);
      expect(raised[0].message).to.contain(field);
    }
  });

  it("refuses a lock added to a stream that had none", async () => {
    const raised = await run(existing({ readLock: { state: [] } }), { loaded: {} });
    expect(raised).to.have.length(1);
    expect(raised[0].code).to.equal(1238);
  });

  it("only lets a new stream name its own namespace as creator", async () => {
    expect(await run({ ns: "foreign", readLock: {} })).to.deep.equal([]);
    const raised = await run({ ns: "varnir", readLock: {} });
    expect(raised).to.have.length(1);
    expect(raised[0].code).to.equal(1238);
  });

  it("does not look at the default namespace or a build below the gate", async () => {
    expect(await run(existing({ readLock: undefined }), { namespace: "default" })).to.deep.equal([]);
    expect(await run(existing({ readLock: undefined }), { build: ReadLock.BUILD - 1 })).to.deep.equal([]);
    expect(await run({ ns: "varnir" }, { namespace: "default" })).to.deep.equal([]);
  });

  it("skips a stream the execution did not load", async () => {
    const raised: any[] = [];
    const updater: any = Object.create(StreamUpdater.prototype);
    updater.entry = { $umid: "u".repeat(64), $datetime: "2026-06-01T12:00:00.000Z", $tx: { $namespace: "foreign" } };
    updater.streams = [{ state: { _id: "other" }, meta: { _id: "other:stream", _rev: "1-a", contractlock: ["c"] }, volatile: { _id: "other:volatile" } }];
    updater.docs = [];
    updater.refStreams = { new: [], updated: [] };
    updater.shared = { raiseLedgerError: (c: number) => raised.push(c), filterPrefix: (i: string) => i, assumedVirtualPrefix: "" };
    updater.virtualMachine = { getEvents: () => [], getLoadedLocks: () => () => undefined };
    updater.detectCollisions = async () => undefined;
    const before = ActiveOptions.get<number>("build", 0);
    ActiveOptions.set("build", ReadLock.BUILD);
    try { await updater.processStreams(); } catch { /* thin fixture */ } finally { ActiveOptions.set("build", before); }
    expect(raised).to.deep.equal([]);
  });
});
