import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

/**
 * What a mutation pass over StreamUpdater found nothing checking: the permanent
 * authority guard looking at every stream (not stopping at one without meta),
 * where a contract data id is left as it is, which items count as contract
 * data, and whether post processing is told this node is the territorial node
 * on the path that writes streams.
 */
const UMID = "u".repeat(64);
const CONTRACT = "c".repeat(64);
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function build(streams: any[], entryOver: any = {}, reference = "me") {
  const raised: any[] = [];
  const bulk: any[] = [];
  const postProcess: any[] = [];
  const entry: any = {
    $umid: UMID,
    $datetime: "2026-06-01T12:00:00.000Z",
    $tx: { $namespace: "ns", $contract: "c" },
    $sigs: {},
    $revs: { $i: {}, $o: {} },
    $origin: "origin",
    $remoteAddr: "1.2.3.4",
    $nodes: {},
    ...entryOver,
  };
  const vm: any = {
    getActivityStreamsFromVM: () => streams,
    getReturnContractData: () => ({}),
    getEvents: () => [],
    getNewContractData: () => false,
    postProcess: async (...a: any[]) => (postProcess.push(a), {}),
    takeReloadRequest: () => false,
    getInternodeCommsFromVM: () => ({}),
    clearingInternodeCommsFromVM: () => false,
  };
  const db: any = { bulkDocs: async (docs: any[]) => (bulk.push(docs), { ok: true }), exists: async () => false };
  const dbev: any = { post: async () => ({ ok: true }) };
  const shared: any = {
    raiseLedgerError: async (code: number, error: Error) => raised.push({ code, message: error.message }),
    filterPrefix: (id: string) => id,
    assumedVirtualPrefix: "",
    clearAllComms: () => entry,
  };
  const updater = new StreamUpdater(entry, vm, reference, {} as any, db, dbev, new EventEmitter(), shared, CONTRACT);
  return { updater, raised, bulk, postProcess, entry };
}

describe("StreamUpdater - mutation gaps (Activeprotocol)", () => {
  const pending = (id: string, authorities?: any[]) => ({
    state: { _id: id, _rev: "1-a" },
    meta: { _id: `${id}:stream`, _rev: "1-a", ...(authorities ? { authorities } : {}) },
    volatile: { _id: `${id}:volatile`, _rev: "1-a" },
  });

  describe("the permanent authority guard", () => {
    it("still checks the other streams when one has no meta", async () => {
      const bad = pending("s1", [{ public: "p", type: "rsa", stake: 100, hash: "h", expire: FUTURE }]);
      const noMeta = { state: { _id: "s2", _rev: "1-a" }, volatile: { _id: "s2:volatile" } };
      // The guard walks from the last stream to the first: the one without meta is met first
      const { updater, raised, bulk } = build([bad, noMeta]);
      await updater.updateStreams();
      expect(raised).to.have.length(1);
      expect(raised[0].code).to.equal(1236);
      expect(bulk).to.have.length(0);
    });
  });

  describe("contract data ids", () => {
    it("leaves an id that is already a full 64 character one", async () => {
      const own: any = { _id: "a".repeat(64) + ":data", data: 1 };
      const { updater } = build([own]);
      await updater.updateStreams();
      expect(own._id).to.equal("a".repeat(64) + ":data");
    });

    it("replaces a label one character short of a full id", async () => {
      const label: any = { _id: "a".repeat(63) + ":data", data: 1 };
      const { updater } = build([label]);
      await updater.updateStreams();
      expect(label._id).to.equal(CONTRACT + ":data");
    });

    it("does not treat an item as contract data unless its id says so", async () => {
      const plain: any = { ...pending("s1"), _id: "plain-id" };
      const { updater, bulk } = build([plain]);
      await updater.updateStreams();
      const written = bulk[0];
      expect(written).to.not.include(plain);
      expect(written.slice(0, 3)).to.deep.equal([plain.state, plain.meta, plain.volatile]);
    });
  });

  describe("post processing after streams are written", () => {
    it("is told this node is the territorial node when it is", async () => {
      const { updater, postProcess } = build([pending("s1")], { $territoriality: "me" }, "me");
      await updater.updateStreams();
      expect(postProcess[0]).to.deep.equal([true, "me", UMID]);
    });

    it("is told it is not when another node is", async () => {
      const { updater, postProcess } = build([pending("s1")], { $territoriality: "other" }, "me");
      await updater.updateStreams();
      expect(postProcess[0]).to.deep.equal([false, "other", UMID]);
    });
  });
});
