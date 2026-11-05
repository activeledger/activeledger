import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { ActiveLogger } from "@activeledger/activelogger";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

const UMID = "u".repeat(64);
const CONTRACT = "c".repeat(64);

describe("StreamUpdater behaviours (cov)", () => {
  const saved: any = {};
  let logged: { level: string; args: any[] }[];
  const realDelays = StreamUpdater.SAVE_RETRY_DELAYS_MS;

  beforeEach(() => {
    logged = [];
    for (const level of ["error", "info", "debug"]) {
      saved[level] = (ActiveLogger as any)[level];
      (ActiveLogger as any)[level] = (...args: any[]) => logged.push({ level, args });
    }
    StreamUpdater.SAVE_RETRY_DELAYS_MS = [1, 1, 1];
  });
  afterEach(() => {
    for (const level of Object.keys(saved)) (ActiveLogger as any)[level] = saved[level];
    StreamUpdater.SAVE_RETRY_DELAYS_MS = realDelays;
    (StreamUpdater as any).pendingEventPosts.clear();
  });

  type Over = {
    streams?: any[];
    vm?: any;
    db?: any;
    dbev?: any;
    shared?: any;
    entry?: any;
    reference?: string;
  };

  const build = (over: Over = {}) => {
    const emitted: string[] = [];
    const emitter = new EventEmitter();
    const origEmit = emitter.emit.bind(emitter);
    (emitter as any).emit = (ev: string, ...a: any[]) => {
      emitted.push(ev);
      return origEmit(ev, ...a);
    };
    const raised: any[] = [];
    const entry = over.entry || {
      $umid: UMID,
      $datetime: "2026-06-01T12:00:00.000Z",
      $tx: { $namespace: "ns", $contract: "c" },
      $sigs: { s: "sig" },
      $revs: { $i: {}, $o: {} },
      $origin: "origin",
      $remoteAddr: "1.2.3.4",
      $nodes: {},
    };
    const calls: string[] = [];
    const vm: any = {
      getActivityStreamsFromVM: () => over.streams || [],
      getReturnContractData: () => ({ ret: 1 }),
      getEvents: () => [{ event: "e" }],
      getNewContractData: () => false,
      postProcess: async (...a: any[]) => {
        calls.push("postProcess:" + JSON.stringify(a));
        return { post: true };
      },
      takeReloadRequest: () => false,
      getInternodeCommsFromVM: () => ({ comms: 1 }),
      clearingInternodeCommsFromVM: () => false,
      ...over.vm,
    };
    const bulk: any[] = [];
    const posts: any[] = [];
    const db: any = {
      bulkDocs: async (docs: any[]) => {
        bulk.push(docs);
        return { ok: true };
      },
      exists: async () => false,
      ...over.db,
    };
    const dbev: any = {
      post: async (d: any) => {
        posts.push(d);
        return { ok: true };
      },
      ...over.dbev,
    };
    const shared: any = {
      raiseLedgerError: async (...a: any[]) => {
        raised.push(a);
      },
      filterPrefix: (id: string) => id,
      assumedVirtualPrefix: "",
      clearAllComms: (_vm: any, _pres: any) => {
        calls.push("clearAllComms");
        return entry;
      },
      ...over.shared,
    };
    const nodeResponse: any = {};
    const updater = new StreamUpdater(
      entry,
      vm,
      over.reference || "me",
      nodeResponse,
      db,
      dbev,
      emitter,
      shared,
      CONTRACT
    );
    return { updater, emitted, raised, bulk, posts, nodeResponse, entry, calls, db };
  };

  const newStream = (extra: any = {}) => ({
    state: { _id: undefined as any, _rev: "x" },
    meta: { name: "thing", ...extra },
    volatile: { _rev: "x" } as any,
  });

  describe("transactions that change no streams", () => {
    it("claims territoriality when first, responds and runs post processing", async () => {
      const { updater, emitted, nodeResponse, entry, calls } = build({ reference: "me" });
      let early = 0;
      await updater.updateStreams(() => early++);
      expect(entry.$territoriality).to.equal("me");
      expect(nodeResponse.return).to.deep.equal({ ret: 1 });
      expect(nodeResponse.post).to.deep.equal({ post: true });
      expect(nodeResponse.incomms).to.deep.equal({ comms: 1 });
      // postProcess(isTerritorial, territoriality, umid)
      expect(calls[0]).to.equal(`postProcess:${JSON.stringify([true, "me", UMID])}`);
      expect(calls).to.include("clearAllComms");
      expect(early).to.equal(1);
      expect(emitted).to.deep.equal(["commited"]);
    });

    it("leaves an existing territoriality and tells post processing it is not the territorial node", async () => {
      const entry: any = { $umid: UMID, $territoriality: "other", $nodes: {}, $tx: {} };
      const { updater, entry: e, calls } = build({ entry, reference: "me" });
      await updater.updateStreams();
      expect(e.$territoriality).to.equal("other");
      expect(calls[0]).to.equal(`postProcess:${JSON.stringify([false, "other", UMID])}`);
    });

    it("asks the node to reload when the contract requested it", async () => {
      const { updater, emitted } = build({ vm: { takeReloadRequest: () => true } });
      await updater.updateStreams();
      expect(emitted).to.deep.equal(["commited", "reload"]);
    });

    it("still commits, and lets the other nodes know, when post processing fails", async () => {
      const { updater, emitted } = build({
        vm: {
          postProcess: async () => {
            throw new Error("post failed");
          },
        },
      });
      let early = 0;
      await updater.updateStreams(() => early++);
      expect(early).to.equal(1);
      expect(emitted).to.deep.equal(["commited", "commited"]);
    });
  });

  describe("new streams", () => {
    it("get ids from the umid and index, a first transaction and no revisions", async () => {
      const streams = [newStream(), newStream({ name: "second" })];
      const { updater, bulk, entry } = build({ streams });
      await updater.updateStreams();
      expect(bulk).to.have.length(1);
      const docs = bulk[0];
      // loop runs from the last stream down
      const ids = docs.map((d: any) => d._id);
      expect(ids).to.deep.equal([
        UMID + "1",
        UMID + "1:stream",
        UMID + "1:volatile",
        UMID + "0",
        UMID + "0:stream",
        UMID + "0:volatile",
        UMID + ":umid",
      ]);
      const meta0 = docs.find((d: any) => d._id === UMID + "0:stream");
      expect(meta0.txs).to.deep.equal([UMID]);
      expect(meta0).to.not.have.property("_rev");
      expect(docs.find((d: any) => d._id === UMID + "0")).to.not.have.property("_rev");
      expect(docs.find((d: any) => d._id === UMID + "0:volatile")).to.not.have.property("_rev");
      const umidDoc = docs[docs.length - 1];
      expect(umidDoc.streams.new).to.deep.equal([
        { id: UMID + "1", name: "second" },
        { id: UMID + "0", name: "thing" },
      ]);
      expect(umidDoc.streams.updated).to.deep.equal([]);
      expect(umidDoc.events).to.deep.equal([{ event: "e" }]);
      expect(umidDoc.umid.$umid).to.equal(UMID);
      expect(umidDoc.umid.$selfsign).to.equal(false);
      expect(umidDoc.umid.$origin).to.equal("origin");
      expect(umidDoc.umid.$remoteAddr).to.equal("1.2.3.4");
      expect(umidDoc.umid).to.not.have.property("$nodes");
      expect(umidDoc.umid).to.not.have.property("$relay");
      expect(entry.$territoriality).to.equal("me");
    });

    it("prefixes ids with the virtual prefix and shows the origin node its streams", async () => {
      const { updater, entry, nodeResponse } = build({
        streams: [newStream()],
        shared: { assumedVirtualPrefix: "ab" },
        reference: "origin",
      });
      await updater.updateStreams();
      expect(nodeResponse.streams.new).to.deep.equal([{ id: "ab" + UMID + "0", name: "thing" }]);
      expect(entry.$streams).to.equal(nodeResponse.streams);
    });

    it("does not set entry.$streams on a node that is not the origin", async () => {
      const { updater, entry } = build({ streams: [newStream()], reference: "other" });
      await updater.updateStreams();
      expect(entry.$streams).to.equal(undefined);
    });
  });

  describe("updated streams", () => {
    it("record the previous umid and point the stream at this transaction", async () => {
      const stream = {
        state: { _id: "s1", _rev: "2-a" },
        meta: { _id: "s1:stream", _rev: "2-a", umid: "prevumid" },
        volatile: { _id: "s1:volatile", _rev: "2-a" },
      };
      const { updater, bulk } = build({ streams: [stream] });
      await updater.updateStreams();
      expect(stream.meta.umid).to.equal(UMID);
      const umidDoc = bulk[0][bulk[0].length - 1];
      expect(umidDoc.streams.updated).to.deep.equal([{ id: "s1", prev: "prevumid" }]);
      expect(umidDoc.streams.new).to.deep.equal([]);
      expect(bulk[0].slice(0, 3)).to.deep.equal([stream.state, stream.meta, stream.volatile]);
    });
  });

  describe("contract data", () => {
    it("is stored under the contract id when addressed by a label", async () => {
      const labelled: any = { _id: "mycontract:data", data: 1 };
      const full: any = { _id: CONTRACT + ":data", data: 2 };
      const { updater, bulk } = build({ streams: [labelled, full] as any });
      await updater.updateStreams();
      expect(labelled._id).to.equal(CONTRACT + ":data");
      expect(full._id).to.equal(CONTRACT + ":data");
      expect(bulk[0].slice(0, 2)).to.deep.equal([full, labelled]);
    });
  });

  describe("deterministic stream names", () => {
    const deterministic = () => [newStream({ deterministic: true })];

    it("fails the transaction (1530) and writes nothing when the name already exists", async () => {
      const asked: string[] = [];
      const { updater, raised, bulk, nodeResponse } = build({
        streams: deterministic(),
        db: { exists: async (id: string) => (asked.push(id), true) },
      });
      nodeResponse.commit = true;
      await updater.updateStreams();
      expect(asked).to.deep.equal([UMID + "0:stream"]);
      expect(bulk).to.have.length(0);
      expect(nodeResponse.commit).to.equal(false);
      expect(raised).to.have.length(1);
      expect(raised[0][0]).to.equal(1530);
      expect(raised[0][1].message).to.equal("Deterministic Stream Name Exists");
      expect(raised[0].slice(2)).to.deep.equal([false, 0, true]);
    });

    it("writes the streams when no name exists", async () => {
      const { updater, raised, bulk } = build({ streams: deterministic() });
      await updater.updateStreams();
      expect(raised).to.have.length(0);
      expect(bulk).to.have.length(1);
    });

    it("assumes no collision and carries on when the existence check itself fails", async () => {
      const { updater, raised, bulk } = build({
        streams: deterministic(),
        db: {
          exists: async () => {
            throw new Error("db unreachable");
          },
        },
      });
      await updater.updateStreams();
      expect(raised).to.have.length(0);
      expect(bulk).to.have.length(1);
    });

    it("only checks streams that were seeded", async () => {
      let asked = 0;
      const { updater, bulk } = build({
        streams: [newStream()],
        db: { exists: async () => (asked++, true) },
      });
      await updater.updateStreams();
      expect(asked).to.equal(0);
      expect(bulk).to.have.length(1);
    });
  });

  describe("event row", () => {
    it("is posted after the write with the umid and datetime in its id", async () => {
      const { updater, posts } = build({ streams: [newStream()] });
      await updater.updateStreams();
      await StreamUpdater.flushEventPosts(1000);
      expect(posts).to.deep.equal([
        { _id: `umid:${new Date("2026-06-01T12:00:00.000Z").getTime()},${UMID}` },
      ]);
    });

    it("failing to post it is logged but does not fail the transaction", async () => {
      const { updater, raised, nodeResponse } = build({
        streams: [newStream()],
        dbev: {
          post: async () => {
            throw new Error("event store down");
          },
        },
      });
      await updater.updateStreams();
      await StreamUpdater.flushEventPosts(1000);
      expect(raised).to.deep.equal([]);
      expect(nodeResponse.commit).to.not.equal(false);
      const err = logged.find(
        (l) => l.level === "error" && l.args[1] === "Event record failed after commit (streams are written)"
      );
      expect(err).to.not.equal(undefined);
      expect(err!.args[0].umid).to.equal(UMID);
      expect((StreamUpdater as any).pendingEventPosts.size).to.equal(0);
    });
  });

  describe("saving", () => {
    it("retries a failed batch and then succeeds", async () => {
      let attempts = 0;
      const { updater, raised } = build({
        streams: [newStream()],
        db: {
          bulkDocs: async () => (++attempts < 3 ? { ok: false } : { ok: true }),
        },
      });
      await updater.updateStreams();
      expect(attempts).to.equal(3);
      expect(raised).to.deep.equal([]);
    });

    it("raises 1510 and does not claim the commit once every attempt has failed", async () => {
      let attempts = 0;
      const { updater, raised, nodeResponse, posts } = build({
        streams: [newStream()],
        db: {
          bulkDocs: async () => {
            attempts++;
            throw new Error("down");
          },
        },
      });
      await updater.updateStreams();
      expect(attempts).to.equal(4);
      expect(raised).to.have.length(1);
      expect(raised[0][0]).to.equal(1510);
      expect(raised[0][1].message).to.equal("Failed to save streams");
      expect(nodeResponse.streams).to.equal(undefined);
      expect(posts).to.deep.equal([]);
    });
  });
});
