import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { Contract } from "../packages/restore/src/modules/contract/contract";
import { Helper } from "../packages/restore/src/modules/helper/helper";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { expect } from "chai";
import "mocha";

/**
 * QuickRestore against an in-memory store and scripted neighbours.
 */
describe("QuickRestore (cov)", () => {
  const realExit = process.exit;
  const realSetTimeout = global.setTimeout;
  const keep: any = {};
  let opts: Record<string, any>;
  let logs: { l: string; m: string }[];
  let store: Map<string, any>;
  let writes: { docs: any[]; opts: any }[];
  let events: any[];
  let neighbours: Record<string, any>;
  let knocks: { path: string; body: any }[];
  let streamAnswers: (body: any) => any[];
  let umidAnswers: Record<string, any[]>;
  let rebuilt: any[];
  let exits: any[];
  let allDocsImpl: (o: any) => Promise<any>;

  const text = () => logs.map((x) => x.m).join("\n");
  const has = (re: RegExp, level?: string) => logs.some((x) => re.test(x.m) && (!level || x.l === level));

  const doc = (id: string, rev: string, extra: any = {}) => ({ _id: id, _rev: rev, ...extra });
  const node = (reference: string, ids: [string, string][], pageSize = 2) => ({
    reference,
    knock: async (p: string) => {
      const start = p.replace(/^all\//, "");
      const all = ids.map(([id, rev]) => ({ id, rev }));
      const from = start ? all.findIndex((s) => s.id === start) + 1 : 0;
      return { data: all.slice(from, from + pageSize) };
    },
  });

  beforeEach(() => {
    opts = { fast: true };
    logs = [];
    store = new Map();
    writes = [];
    events = [];
    knocks = [];
    neighbours = {};
    umidAnswers = {};
    rebuilt = [];
    exits = [];
    streamAnswers = () => [];
    allDocsImpl = async () => ({ rows: [] });
    for (const k of ["get", "set"]) keep["o" + k] = (ActiveOptions as any)[k];
    for (const k of ["info", "warn", "error"]) keep["l" + k] = (ActiveLogger as any)[k];
    for (const k of ["database", "eventDatabase", "network", "neighbourCount", "consensusReachedAmount"]) keep["p" + k] = (Provider as any)[k];
    keep.rebuild = Contract.rebuild;
    keep.homeRef = (ActiveNetwork.Home as any).reference;
    keep.verbose = Helper.verbose;
    (ActiveOptions as any).get = (k: string, d: any) => (k in opts ? opts[k] : d);
    for (const k of ["info", "warn", "error"]) {
      (ActiveLogger as any)[k] = (...a: any[]) => logs.push({ l: k, m: String(a.length > 1 && typeof a[1] === "string" ? a[1] : a[0]) });
    }
    (process as any).exit = (c: any) => exits.push(c);
    (ActiveNetwork.Home as any).reference = "self";
    Helper.verbose = false;
    (Contract as any).rebuild = async (c: any) => {
      rebuilt.push(c);
    };
    (Provider as any).neighbourCount = 4;
    (Provider as any).consensusReachedAmount = 75; // ceil(3 - 1) = 2 votes
    (Provider as any).database = {
      get: async (id: string) => {
        if (!store.has(id)) throw new Error("missing " + id);
        return store.get(id);
      },
      allDocs: (o: any) => allDocsImpl(o),
      bulkDocs: async (docs: any[], o: any) => {
        writes.push({ docs, opts: o });
        for (const d of docs) store.set(d._id, d);
        return { ok: true };
      },
    };
    (Provider as any).eventDatabase = {
      post: async (e: any) => {
        events.push(e);
      },
    };
    (Provider as any).network = {
      neighbourhood: {
        get: () => neighbours,
        knockAll: async (p: string, body: any) => {
          knocks.push({ path: p, body });
          if (p === "stream") return streamAnswers(body);
          if (p.startsWith("umid/")) return umidAnswers[p.slice(5)] ?? [];
          return [];
        },
      },
    };
  });

  afterEach(async () => {
    // Constructed instances schedule an exit 200ms on
    await new Promise((r) => realSetTimeout(r, 0));
    (global as any).setTimeout = realSetTimeout;
    for (const k of ["get", "set"]) (ActiveOptions as any)[k] = keep["o" + k];
    for (const k of ["info", "warn", "error"]) (ActiveLogger as any)[k] = keep["l" + k];
    for (const k of ["database", "eventDatabase", "network", "neighbourCount", "consensusReachedAmount"]) (Provider as any)[k] = keep["p" + k];
    (Contract as any).rebuild = keep.rebuild;
    (ActiveNetwork.Home as any).reference = keep.homeRef;
    Helper.verbose = keep.verbose;
    (process as any).exit = realExit;
  });

  // The constructor runs a restore and schedules the exit, so stop it
  // doing anything and use the instance for its helpers
  const make = (): any => {
    const proto: any = QuickRestore.prototype;
    const real = proto.runQuickFullRestore;
    proto.runQuickFullRestore = () => new Promise(() => {});
    try {
      return new QuickRestore();
    } finally {
      proto.runQuickFullRestore = real;
    }
  };

  describe("constructor", () => {
    const run = async (ok: boolean) => {
      const proto: any = QuickRestore.prototype;
      const real = proto.runQuickFullRestore;
      proto.runQuickFullRestore = async () => ok;
      const timers: [Function, number][] = [];
      (global as any).setTimeout = (fn: Function, ms: number) => (timers.push([fn, ms]), 0 as any);
      try {
        new QuickRestore();
        await new Promise((r) => setImmediate(r));
      } finally {
        proto.runQuickFullRestore = real;
        (global as any).setTimeout = realSetTimeout;
      }
      return timers;
    };
    it("ends the process with 0 after a restore that worked", async () => {
      const timers = await run(true);
      expect(timers.length).to.equal(1);
      expect(timers[0][1]).to.equal(200);
      timers[0][0]();
      expect(exits).to.deep.equal([0]);
    });
    it("ends the process with 1 after one that did not", async () => {
      const timers = await run(false);
      timers[0][0]();
      expect(exits).to.deep.equal([1]);
    });
  });

  describe("runQuickFullRestore", () => {
    it("refuses --skip-history together with --history-only", async () => {
      opts["skip-history"] = true;
      opts["history-only"] = true;
      expect(await make().runQuickFullRestore()).to.equal(false);
      expect(has(/--skip-history and --history-only/, "error")).to.equal(true);
      expect(knocks).to.deep.equal([]);
    });
    it("allows either of the two on its own", async () => {
      opts["skip-history"] = true;
      neighbours = { b: node("b", [["s1", "1-a"]]), c: node("c", [["s1", "1-a"]]) };
      streamAnswers = (b) => [doc(b.$stream, b.$rev)];
      expect(await make().runQuickFullRestore()).to.equal(true);
      expect(has(/--skip-history and/)).to.equal(false);
    });
    it("fails when the database gives no answer", async () => {
      allDocsImpl = async () => undefined;
      expect(await make().runQuickFullRestore()).to.equal(false);
      expect(has(/database cannot be reached/, "error")).to.equal(true);
      expect(knocks).to.deep.equal([]);
    });
    it("fails when the answer has no rows array", async () => {
      allDocsImpl = async () => ({ rows: "x" });
      expect(await make().runQuickFullRestore()).to.equal(false);
    });
    it("fails when the database throws", async () => {
      allDocsImpl = async () => {
        throw new Error("down");
      };
      expect(await make().runQuickFullRestore()).to.equal(false);
      expect(has(/cannot be reached/)).to.equal(true);
    });
    it("probes with a single-row read", async () => {
      let seen: any;
      allDocsImpl = async (o) => ((seen = o), { rows: [] });
      await make().runQuickFullRestore();
      expect(seen).to.deep.equal({ limit: 1 });
    });
    it("fails, saying why, when no neighbour has anything", async () => {
      neighbours = { b: node("b", []) };
      expect(await make().runQuickFullRestore()).to.equal(false);
      expect(has(/error running quick full restore/, "error")).to.equal(true);
    });

    describe("a full run", () => {
      beforeEach(() => {
        neighbours = {
          self: node("self", [["s9", "9-z"]]),
          b: node("b", [["s1", "2-aa"], ["s2", "1-bb"], ["s3", "1-cc"]]),
          c: node("c", [["s1", "2-aa"], ["s2", "1-xx"], ["s3", "1-cc"]]),
          d: node("d", [["s1", "1-old"]]),
        };
        streamAnswers = (body) => [doc(body.$stream, body.$rev, { v: "net" })];
      });

      it("restores only the revisions a majority holds, never from this node, and succeeds", async () => {
        opts["skip-history"] = true;
        expect(await make().runQuickFullRestore()).to.equal(true);
        const asked = knocks.filter((k) => k.path === "stream").map((k) => k.body);
        expect(asked.map((a) => a.$stream).sort()).to.deep.equal(["s1", "s3"]);
        expect(asked.find((a) => a.$stream === "s1").$rev).to.equal("2-aa");
        // s2 is split 1-1 and s9 only belongs to this node
        expect(store.has("s2")).to.equal(false);
        expect(store.has("s9")).to.equal(false);
        expect(store.get("s1")._rev).to.equal("2-aa");
        expect(writes.every((w) => w.opts.new_edits === false)).to.equal(true);
        expect(has(/Rebuild Complete/)).to.equal(true);
        expect(has(/History pass skipped/)).to.equal(true);
      });

      it("returns false, and says so, when the config has no consensus", async () => {
        (Provider as any).consensusReachedAmount = undefined;
        opts["skip-history"] = true;
        expect(await make().runQuickFullRestore()).to.equal(false);
        expect(has(/consensus.reached is not set/, "error")).to.equal(true);
        expect(writes).to.deep.equal([]);
      });

      it("--history-only leaves the state alone and goes to history", async () => {
        opts["history-only"] = true;
        expect(await make().runQuickFullRestore()).to.equal(true);
        expect(knocks.filter((k) => k.path === "stream")).to.deep.equal([]);
        expect(writes).to.deep.equal([]);
        expect(has(/Rebuild skipped \(--history-only\)/)).to.equal(true);
        expect(has(/History pass: /)).to.equal(true);
      });

      it("fails when restoring the state throws", async () => {
        opts["skip-history"] = true;
        (Provider as any).database.bulkDocs = async () => {
          throw new Error("disk full");
        };
        expect(await make().runQuickFullRestore()).to.equal(false);
        expect(has(/error running quick full restore: disk full/, "error")).to.equal(true);
      });

      it("rebuilds the contract files after every document is written", async () => {
        opts["skip-history"] = true;
        streamAnswers = (body) => [doc(body.$stream, body.$rev, { namespace: "ns", contract: { "1": "x" }, compiled: true })];
        let written = 0;
        (Contract as any).rebuild = async (c: any) => {
          written = writes.length;
          rebuilt.push(c._id);
        };
        await make().runQuickFullRestore();
        expect(rebuilt.sort()).to.deep.equal(["s1", "s3"]);
        expect(written).to.equal(2);
      });
    });
  });

  describe("restoreHistory", () => {
    const S = "s1";
    const umidDoc = (id: string, prev?: string, extra: any = {}) => ({
      _id: `${id}:umid`,
      umid: { $umid: id },
      streams: { updated: [{ id: S, prev }] },
      ...extra,
    });
    const history = (consensus: any[] = [{ stream: S, revision: "1-a" }]) => make().restoreHistory(consensus);

    beforeEach(() => {
      store.set(`${S}:stream`, { _id: `${S}:stream`, umid: "U2" });
    });

    it("is skipped by restore.history: false", async () => {
      opts.restore = { history: false };
      await history();
      expect(has(/History pass skipped/)).to.equal(true);
      expect(knocks).to.deep.equal([]);
    });
    it("is skipped by --skip-history", async () => {
      opts["skip-history"] = true;
      await history();
      expect(has(/History pass skipped/)).to.equal(true);
    });
    it("is skipped, with an error, when there is no bar to hold documents to", async () => {
      (Provider as any).consensusReachedAmount = undefined;
      await history();
      expect(has(/history pass has no bar/, "error")).to.equal(true);
      expect(knocks).to.deep.equal([]);
    });
    it("goes ahead without a consensus setting when the config names its own bar", async () => {
      (Provider as any).consensusReachedAmount = undefined;
      opts.restore = { history: { minAgree: 1 } };
      umidAnswers.U2 = [umidDoc("U2")];
      await history();
      expect(has(/no bar/)).to.equal(false);
      expect(store.has("U2:umid")).to.equal(true);
    });

    it("walks a stream's chain back and fetches what is missing", async () => {
      store.set("U1:umid", umidDoc("U1"));
      umidAnswers.U2 = [umidDoc("U2", "U1", { events: [{ _id: "ev" }] }), umidDoc("U2", "U1", { events: [{ _id: "ev" }] })];
      opts.restore = { history: { hopDelayMs: 0 } };
      await history();
      expect(store.has("U2:umid")).to.equal(true);
      expect(events).to.deep.equal([{ _id: "ev" }]);
      expect(has(/History pass: 1 stream\(s\)/)).to.equal(true);
      expect(has(/1 umid\(s\) recovered/)).to.equal(true);
      expect(has(/could not be completed/)).to.equal(false);
    });

    it("requires as many identical answers as the consensus bar", async () => {
      // votesNeeded is 2 here
      umidAnswers.U2 = [umidDoc("U2")];
      await history();
      expect(store.has("U2:umid")).to.equal(false);
      expect(has(/1 stream\(s\) have a chain that could not be completed, e.g. s1 \(could not recover U2\)/, "warn")).to.equal(true);
      umidAnswers.U2 = [umidDoc("U2"), umidDoc("U2")];
      logs.length = 0;
      await history();
      expect(store.has("U2:umid")).to.equal(true);
      expect(has(/could not be completed/)).to.equal(false);
    });

    it("uses the configured minAgree over the consensus bar", async () => {
      opts.restore = { history: { minAgree: 3, hopDelayMs: 0 } };
      umidAnswers.U2 = [umidDoc("U2"), umidDoc("U2")];
      await history();
      expect(store.has("U2:umid")).to.equal(false);
    });

    it("honours walkLimit", async () => {
      store.set("U2:umid", umidDoc("U2", "U1"));
      opts.restore = { history: { walkLimit: 0 } };
      await history();
      expect(has(/s1 \(limit reached\)/, "warn")).to.equal(true);
    });

    it("only walks state streams, not meta, umid or design documents or ones with a colon", async () => {
      umidAnswers.U2 = [umidDoc("U2"), umidDoc("U2")];
      await history([
        { stream: "s1:stream", revision: "1" },
        { stream: "x:umid", revision: "1" },
        { stream: "_design/x", revision: "1" },
        { stream: "a:b", revision: "1" },
        { stream: S, revision: "1" },
      ]);
      expect(has(/History pass: 1 stream\(s\)/)).to.equal(true);
    });

    it("skips a stream whose meta is missing or names no umid", async () => {
      store.set("n1:stream", { _id: "n1:stream" });
      await history([
        { stream: "n1", revision: "1" },
        { stream: "n2", revision: "1" },
      ]);
      expect(knocks).to.deep.equal([]);
      expect(has(/History pass: 2 stream\(s\)/)).to.equal(true);
      expect(has(/0 umid\(s\) recovered/)).to.equal(true);
    });

    it("reports a walk that throws, naming the failure, and carries on with the next stream", async () => {
      store.set("U2:umid", {
        _id: "U2:umid",
        get streams(): any {
          throw new Error("corrupt umid");
        },
      });
      store.set("s2:stream", { _id: "s2:stream", umid: "U7" });
      store.set("U7:umid", umidDoc("U7"));
      store.set("s3:stream", { _id: "s3:stream", umid: "U8" });
      store.set("U8:umid", { _id: "U8:umid", get streams(): any { throw "plain"; } });
      await history([{ stream: S, revision: "1" }, { stream: "s2", revision: "1" }, { stream: "s3", revision: "1" }]);
      const w = logs.find((x) => /have a chain that could not be completed/.test(x.m))!;
      expect(w.l).to.equal("warn");
      expect(w.m).to.contain("2 stream(s)").and.to.contain("s1 (corrupt umid)").and.to.contain("s3 (failed)");
      expect(w.m).to.not.contain("s2 (");
      expect(has(/History Complete/)).to.equal(true);
    });

    it("logs progress every 500 streams", async () => {
      const many = Array.from({ length: 501 }, (_, i) => ({ stream: "m" + i, revision: "1" }));
      await history(many);
      expect(has(/History progress: 500\/501 \(0 umid\(s\) recovered\)/)).to.equal(true);
      expect(has(/History progress: 0\//)).to.equal(false);
    });

    it("lists at most three incomplete streams in the warning", async () => {
      for (const n of ["a", "b", "c", "d"]) store.set(`${n}:stream`, { umid: "U" + n });
      await history(["a", "b", "c", "d"].map((n) => ({ stream: n, revision: "1" })));
      const w = logs.find((x) => /have a chain that could not be completed/.test(x.m))!;
      expect(w.m).to.match(/^4 stream\(s\)/);
      expect(w.m.split("; ").length).to.equal(3);
    });

    it("throttles after a walk that went to the network", async () => {
      store.set("U1:umid", umidDoc("U1"));
      umidAnswers.U2 = [umidDoc("U2", "U1"), umidDoc("U2", "U1")];
      opts.fast = false;
      opts.restore = { throttle: { pauseMs: 30, batch: 100, batchPauseMs: 0 }, history: { hopDelayMs: 0 } };
      const t0 = Date.now();
      await history();
      expect(Date.now() - t0).to.be.at.least(25);
    });
    it("does not pause for a walk that fetched nothing", async () => {
      store.set("U2:umid", umidDoc("U2"));
      opts.fast = false;
      opts.restore = { throttle: { pauseMs: 300, batch: 100, batchPauseMs: 0 } };
      const t0 = Date.now();
      await history();
      expect(Date.now() - t0).to.be.below(200);
    });
  });

  describe("fetchDocuments", () => {
    const fetch = (c: any[]) => make().fetchDocuments(c);

    it("leaves a document it already holds at the agreed revision", async () => {
      store.set("s1", doc("s1", "2-a"));
      await fetch([{ stream: "s1", revision: "2-a" }]);
      expect(knocks).to.deep.equal([]);
      expect(writes).to.deep.equal([]);
      expect(has(/Restored 0 stream\(s\); 1 already held/)).to.equal(true);
    });
    it("fetches when the held revision differs, overwriting it", async () => {
      store.set("s1", doc("s1", "1-old", { v: "old" }));
      streamAnswers = (b) => [doc(b.$stream, b.$rev, { v: "new" })];
      await fetch([{ stream: "s1", revision: "2-a" }]);
      expect(store.get("s1").v).to.equal("new");
      expect(writes[0].opts).to.deep.equal({ new_edits: true, force_rev: "2-a" });
      expect(has(/Restored 1 stream\(s\); 0 already held/)).to.equal(true);
    });
    it("rebuilds a held contract from the local copy", async () => {
      const c = doc("c1", "1-a", { namespace: "n", contract: {}, compiled: true });
      store.set("c1", c);
      store.set("c2:stream", doc("c2:stream", "1-a", { namespace: "n", contract: {}, compiled: true }));
      store.set("c3", doc("c3", "1-a", { namespace: "n", contract: {} }));
      await fetch([
        { stream: "c1", revision: "1-a" },
        { stream: "c2:stream", revision: "1-a" },
        { stream: "c3", revision: "1-a" },
      ]);
      expect(rebuilt).to.deep.equal([c]);
    });
    it("rebuilds contracts the network supplied", async () => {
      streamAnswers = (b) => [doc(b.$stream, b.$rev, { namespace: "n", contract: { 1: "x" }, compiled: true })];
      await fetch([{ stream: "c9", revision: "1-a" }]);
      expect(rebuilt.map((c) => c._id)).to.deep.equal(["c9"]);
    });
    it("does not rebuild plain streams", async () => {
      streamAnswers = (b) => [doc(b.$stream, b.$rev)];
      await fetch([{ stream: "p", revision: "1-a" }]);
      expect(rebuilt).to.deep.equal([]);
      expect(store.has("p")).to.equal(true);
    });
    it("asks the network for the stream at the agreed revision, over the neighbourhood", async () => {
      streamAnswers = (b) => [doc(b.$stream, b.$rev)];
      await fetch([{ stream: "p", revision: "5-z" }]);
      expect(knocks).to.deep.equal([{ path: "stream", body: { $stream: "p", $rev: "5-z" } }]);
    });
    it("asks again when no neighbour answers, then reports it unrestored", async () => {
      const waits: number[] = [];
      (global as any).setTimeout = (fn: Function, ms: number) => (waits.push(ms), realSetTimeout(fn, 0));
      await fetch([{ stream: "gone", revision: "1-a" }]);
      (global as any).setTimeout = realSetTimeout;
      expect(knocks.length).to.equal(3);
      expect(waits).to.deep.equal([500, 1000]);
      expect(has(/\[Not restored\] gone at 1-a: no neighbour supplied it after 3 attempts/, "error")).to.equal(true);
      expect(has(/1 stream\(s\) could not be restored/, "error")).to.equal(true);
      expect(writes).to.deep.equal([]);
    });
    it("stops asking once an attempt succeeds", async () => {
      let n = 0;
      streamAnswers = (b) => (++n < 2 ? [] : [doc(b.$stream, b.$rev)]);
      (global as any).setTimeout = (fn: Function) => realSetTimeout(fn, 0);
      await fetch([{ stream: "late", revision: "1-a" }]);
      (global as any).setTimeout = realSetTimeout;
      expect(knocks.length).to.equal(2);
      expect(store.has("late")).to.equal(true);
    });
    it("treats a failing knock as no answer", async () => {
      let n = 0;
      (Provider as any).network.neighbourhood.knockAll = async (_p: string, b: any) => {
        if (++n === 1) throw new Error("net");
        return [doc(b.$stream, b.$rev)];
      };
      (global as any).setTimeout = (fn: Function) => realSetTimeout(fn, 0);
      await fetch([{ stream: "x", revision: "1-a" }]);
      (global as any).setTimeout = realSetTimeout;
      expect(store.has("x")).to.equal(true);
    });
    it("logs progress every 500 streams", async () => {
      const c = Array.from({ length: 500 }, (_, i) => {
        store.set("h" + i, doc("h" + i, "1-a"));
        return { stream: "h" + i, revision: "1-a" };
      });
      await fetch(c);
      expect(has(/Restore progress: 500\/500 \(0 fetched, 499 already held\)/)).to.equal(true);
    });
    it("goes through the streams from the last to the first", async () => {
      streamAnswers = (b) => [doc(b.$stream, b.$rev)];
      await fetch([{ stream: "first", revision: "1" }, { stream: "last", revision: "1" }]);
      expect(knocks.map((k) => k.body.$stream)).to.deep.equal(["last", "first"]);
    });
    it("rejects when an upload fails", async () => {
      streamAnswers = (b) => [doc(b.$stream, b.$rev)];
      (Provider as any).database.bulkDocs = async () => {
        throw new Error("write");
      };
      let err: any;
      try {
        await fetch([{ stream: "w", revision: "1-a" }]);
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("write");
    });
    it("throttles between fetches unless fast", async () => {
      streamAnswers = (b) => [doc(b.$stream, b.$rev)];
      opts.fast = false;
      opts.restore = { throttle: { pauseMs: 40, batch: 100, batchPauseMs: 0 } };
      const t0 = Date.now();
      await fetch([{ stream: "t1", revision: "1" }, { stream: "t2", revision: "1" }]);
      expect(Date.now() - t0).to.be.at.least(70);
    });
  });

  describe("uploadData", () => {
    it("replays a umid's events before writing the umid document", async () => {
      const order: string[] = [];
      (Provider as any).eventDatabase.post = async (e: any) => order.push("event:" + e._id);
      (Provider as any).database.bulkDocs = async (d: any[]) => (order.push("write:" + d[0]._id), { ok: true });
      await make().uploadData({ documents: [{ _id: "U:umid", events: [{ _id: "e1" }] }], contracts: [] });
      expect(order).to.deep.equal(["event:e1", "write:U:umid"]);
    });
    it("does not replay events for documents that are not umids", async () => {
      await make().uploadData({ documents: [{ _id: "s", events: [{ _id: "e1" }] }], contracts: [] });
      expect(events).to.deep.equal([]);
      expect(store.has("s")).to.equal(true);
    });
    it("handles a document without an id by just adopting it", async () => {
      await make().uploadData({ documents: [{ x: 1 }], contracts: [] });
      expect(events).to.deep.equal([]);
      expect(writes.length).to.equal(1);
    });
    it("writes documents last to first", async () => {
      await make().uploadData({ documents: [{ _id: "a" }, { _id: "b" }], contracts: [] });
      expect(writes.map((w) => w.docs[0]._id)).to.deep.equal(["b", "a"]);
    });
    it("rejects with the cause and logs when a write fails", async () => {
      (Provider as any).database.bulkDocs = async () => {
        throw new Error("nope");
      };
      let err: any;
      try {
        await make().uploadData({ documents: [{ _id: "a" }], contracts: [] });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("nope");
      expect(has(/Uploading documents to database/, "error")).to.equal(true);
    });
  });

  describe("adoptDocument", () => {
    it("treats a local document without a revision as absent", async () => {
      store.set("a", { _id: "a" });
      await (QuickRestore as any).adoptDocument({ _id: "a", _rev: "3-x" });
      expect(writes[0].opts).to.deep.equal({ new_edits: false });
    });
    it("warns about a divergence before overwriting", async () => {
      store.set("a", doc("a", "1-old"));
      await (QuickRestore as any).adoptDocument({ _id: "a", _rev: "3-x" });
      expect(has(/\[Diverged\] a local 1-old -> network 3-x/, "warn")).to.equal(true);
    });
    it("writes nothing when revisions agree", async () => {
      store.set("a", doc("a", "3-x"));
      await (QuickRestore as any).adoptDocument({ _id: "a", _rev: "3-x" });
      expect(writes).to.deep.equal([]);
    });
  });

  describe("handleNetworkData", () => {
    const h = (a: any) => make().handleNetworkData(a);
    it("takes the last usable answer only", async () => {
      const r = await h([doc("a", "1"), doc("b", "1")]);
      expect(r.documents.map((d: any) => d._id)).to.deep.equal(["b"]);
    });
    it("skips errors, arrays, nulls and id-less answers", async () => {
      const r = await h([doc("good", "1"), { error: "x", _id: "e" }, [], null, { x: 1 }]);
      expect(r.documents.map((d: any) => d._id)).to.deep.equal(["good"]);
    });
    it("flags only complete contract state as a contract", async () => {
      const full = doc("c", "1", { namespace: "n", contract: {}, compiled: true });
      expect((await h([full])).contracts).to.deep.equal([full]);
      expect((await h([doc("c", "1", { namespace: "n", contract: {} })])).contracts).to.deep.equal([]);
      expect((await h([{ ...full, _id: "c:stream" }])).contracts).to.deep.equal([]);
      expect((await h([{ ...full, _id: "c:umid" }])).contracts).to.deep.equal([]);
      expect((await h([{ ...full, _id: "_design/c" }])).contracts).to.deep.equal([]);
    });
    it("logs unusable contract data when verbose", async () => {
      Helper.verbose = true;
      await h([doc("c", "1")]);
      expect(has(/Data does not have required fields/)).to.equal(true);
    });
    it("is empty when nobody answered", async () => {
      expect(await h([])).to.deep.equal({ documents: [], contracts: [] });
    });
  });

  describe("getRebuildData / processRebuildPromises", () => {
    it("pages through every stream a node holds", async () => {
      const r = await make().getRebuildData(node("n", [["a", "1"], ["b", "1"], ["c", "1"], ["d", "1"], ["e", "1"]], 2));
      expect(r.reference).to.equal("n");
      expect(r.streams.map((s: any) => s.id)).to.deep.equal(["a", "b", "c", "d", "e"]);
    });
    it("rejects with No Data for a node with nothing", async () => {
      let err: any;
      try {
        await make().getRebuildData(node("n", []));
      } catch (e) {
        err = e;
      }
      expect(err).to.equal("No Data");
    });
    it("rejects with the knock error", async () => {
      const boom = new Error("boom");
      let err: any;
      try {
        await make().getRebuildData({ reference: "n", knock: async () => { throw boom; } });
      } catch (e) {
        err = e;
      }
      expect(err).to.equal(boom);
      expect(has(/node.knock\('all'\)/, "error")).to.equal(true);
    });
    it("drops empty answers", async () => {
      const r = await make().processRebuildPromises([Promise.resolve(undefined), Promise.resolve({ reference: "a", streams: [] })]);
      expect(r).to.deep.equal([{ reference: "a", streams: [] }]);
    });
    it("rejects when there is nothing to process", async () => {
      let err: any;
      try {
        await make().processRebuildPromises([Promise.resolve(undefined)]);
      } catch (e) {
        err = e;
      }
      expect(err).to.equal("No data to process");
    });
    it("rejects when a node fails", async () => {
      let err: any;
      try {
        await make().processRebuildPromises([Promise.reject("bad")]);
      } catch (e) {
        err = e;
      }
      expect(err).to.equal("bad");
    });
  });
});
