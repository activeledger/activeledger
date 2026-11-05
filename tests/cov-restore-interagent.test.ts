import { Interagent } from "../packages/restore/src/modules/interagent/interagent";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { ErrorCodes } from "../packages/restore/src/modules/interagent/error-codes.enum";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { expect } from "chai";
import "mocha";

/**
 * Interagent against in-process fakes of the stores and the network.
 */
describe("Restore Interagent (cov)", () => {
  const realSetTimeout = global.setTimeout;
  const saved: any = {};
  let timers: { fn: Function; ms: number }[];
  let logs: { level: string; msg: any }[];
  let purged: any[];
  let archived: any[];
  let putArchive: any[];
  let live: Record<string, any>;
  let bulk: any[];
  let posted: any[];
  let knockCalls: any[];
  let knockResult: any[];
  let rows: any[];
  let allDocsOptions: any;
  const origLog: any = {};

  const build = (): any => {
    // Capture the constructor's timers rather than letting a 5s loop run
    (global as any).setTimeout = (fn: Function, ms: number) => {
      timers.push({ fn, ms });
      return 0 as any;
    };
    try {
      return new Interagent() as any;
    } finally {
      (global as any).setTimeout = realSetTimeout;
    }
  };

  beforeEach(() => {
    timers = [];
    logs = [];
    purged = [];
    archived = [];
    putArchive = [];
    live = {};
    bulk = [];
    posted = [];
    knockCalls = [];
    knockResult = [];
    rows = [];
    allDocsOptions = undefined;
    for (const k of ["database", "errorDatabase", "errorArchive", "eventDatabase", "network"]) {
      saved[k] = (Provider as any)[k];
    }
    for (const l of ["info", "warn", "error"]) {
      origLog[l] = (ActiveLogger as any)[l];
      (ActiveLogger as any)[l] = (msg: any, other?: any) => {
        logs.push({ level: l, msg: other ?? msg });
      };
    }
    (Provider as any).database = {
      exists: async (id: string) => id in live,
      get: async (id: string) => {
        if (!(id in live)) throw new Error("missing");
        return live[id];
      },
      bulkDocs: async (docs: any[], opts: any) => {
        bulk.push({ docs, opts });
      },
    };
    (Provider as any).errorDatabase = {
      allDocs: async (o: any) => {
        allDocsOptions = o;
        return { rows };
      },
      purge: async (d: any) => {
        purged.push(d);
      },
    };
    (Provider as any).errorArchive = {
      purge: async (d: any) => {
        archived.push(d);
      },
      put: async (d: any) => {
        putArchive.push(d);
      },
    };
    (Provider as any).eventDatabase = {
      post: async (d: any) => {
        posted.push(d);
      },
    };
    (Provider as any).network = {
      neighbourhood: {
        knockAll: async (...args: any[]) => {
          knockCalls.push(args);
          return knockResult;
        },
      },
    };
  });

  afterEach(() => {
    (global as any).setTimeout = realSetTimeout;
    for (const k of Object.keys(saved)) (Provider as any)[k] = saved[k];
    for (const l of Object.keys(origLog)) (ActiveLogger as any)[l] = origLog[l];
  });

  const umidDoc = (id: string, extra: any = {}) => ({
    _id: id + ":umid",
    umid: { $umid: id },
    ...extra,
  });

  describe("start up", () => {
    it("waits 5s before starting the checker", () => {
      build();
      expect(timers.length).to.equal(1);
      expect(timers[0].ms).to.equal(5000);
    });

    it("runs a check on start and re-arms 5s later, even if the check throws", async () => {
      (Provider as any).errorDatabase.allDocs = async () => {
        throw new Error("db down");
      };
      const ia = build();
      const start = timers.shift()!;
      // the checker's re-arm timer should be captured
      (global as any).setTimeout = (fn: Function, ms: number) => {
        timers.push({ fn, ms });
        return 0 as any;
      };
      start.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      (global as any).setTimeout = realSetTimeout;
      expect(timers.length).to.equal(1);
      expect(timers[0].ms).to.equal(5000);
      expect(logs.some((l) => l.level === "error" && l.msg === "Skipped Error Checker")).to.equal(true);
      expect(ia).to.not.equal(undefined);
      // firing the re-armed timer checks again
      let checks = 0;
      (Provider as any).errorDatabase.allDocs = async () => {
        checks++;
        return { rows: [] };
      };
      timers[0].fn();
      await new Promise((r) => setImmediate(r));
      expect(checks).to.equal(1);
    });
  });

  describe("skippedChecker", () => {
    it("asks for at most 200 documents with their bodies", async () => {
      const ia = build();
      await ia.skippedChecker();
      expect(allDocsOptions).to.deep.equal({ include_docs: true, limit: 200 });
    });

    it("does nothing with no rows", async () => {
      const ia = build();
      logs.length = 0;
      await ia.skippedChecker();
      expect(purged).to.deep.equal([]);
      expect(logs.length).to.equal(0);
    });

    it("archives a processed doc without storing it, and processes the rest", async () => {
      const done = { _id: "done", processed: true };
      const fresh = { _id: "fresh", code: 9999, umid: "u" };
      rows = [done, fresh];
      const ia = build();
      await ia.skippedChecker();
      expect(purged.map((d) => d._id).sort()).to.deep.equal(["done", "fresh"]);
      // processed ones are not kept in the archive
      expect(putArchive).to.deep.equal([]);
      expect(fresh).to.have.property("processed", true);
      expect(done).to.not.have.property("processedAt");
      expect(logs.some((l) => /Checking 2 Documents/.test(String(l.msg)))).to.equal(true);
    });
  });

  describe("processDocument", () => {
    it("records a position error in the archive and does not touch the store", async () => {
      const ia = build();
      const doc = { _id: "e1", code: ErrorCodes.StreamPositionIncorrect, umid: "u1" };
      await ia.processDocument(doc);
      expect(purged).to.deep.equal([doc]);
      expect(archived).to.deep.equal([doc]);
      expect(putArchive).to.deep.equal([doc]);
      expect(doc).to.have.property("processed", true);
      expect(doc.processedAt).to.be.instanceOf(Date);
      expect(bulk).to.deep.equal([]);
      expect(knockCalls).to.deep.equal([]);
    });

    it("ignores codes it does not act on, removing without archiving", async () => {
      const ia = build();
      const doc = { _id: "e2", code: ErrorCodes.Unknown, umid: "u2" };
      await ia.processDocument(doc);
      expect(purged).to.deep.equal([doc]);
      expect(putArchive).to.deep.equal([]);
      expect(knockCalls).to.deep.equal([]);
      expect(bulk).to.deep.equal([]);
    });

    it("leaves a missing-stream error alone when the umid is already held", async () => {
      live["u3:umid"] = umidDoc("u3");
      const ia = build();
      const doc = { _id: "e3", code: ErrorCodes.StreamNotFound, umid: "u3" };
      await ia.processDocument(doc);
      expect(knockCalls).to.deep.equal([]);
      expect(bulk).to.deep.equal([]);
      expect(putArchive).to.deep.equal([]);
      expect(purged).to.deep.equal([doc]);
    });

    it("fetches a missing umid from the neighbours, inserts it and archives the error", async () => {
      const good = umidDoc("u4", { events: [{ _id: "ev1" }] });
      knockResult = [good];
      const ia = build();
      const doc = { _id: "e4", code: ErrorCodes.StreamNotFound, umid: "u4" };
      await ia.processDocument(doc);
      expect(knockCalls).to.deep.equal([["umid/u4", null, true]]);
      expect(bulk).to.deep.equal([{ docs: [good], opts: { new_edits: false } }]);
      expect(posted.length).to.equal(2);
      expect(posted[0]._id).to.match(/^umid:\d+,u4$/);
      expect(posted[1]).to.deep.equal({ _id: "ev1" });
      expect(putArchive).to.deep.equal([doc]);
    });

    it("takes the answer most neighbours gave", async () => {
      const a = umidDoc("u5", { v: "a" });
      const b = umidDoc("u5", { v: "b" });
      knockResult = [a, b, b, b];
      const ia = build();
      await ia.processDocument({ _id: "e5", code: ErrorCodes.StreamNotFound, umid: "u5" });
      expect(bulk[0].docs[0].v).to.equal("b");
    });

    it("discards neighbour answers that carry no umid", async () => {
      const ia = build();
      knockResult = [{ error: "nope" }, { umid: {} }];
      const doc = { _id: "e6", code: ErrorCodes.StreamNotFound, umid: "u6" };
      await ia.processDocument(doc);
      expect(bulk).to.deep.equal([]);
      // failure to find it: removed but not archived
      expect(purged).to.deep.equal([doc]);
      expect(putArchive).to.deep.equal([]);
      expect(logs.some((l) => l.level === "error" && /not found #2/.test(String(l.msg)))).to.equal(true);
    });

    it("hashes answers the same way the network does", async () => {
      // Two byte-identical answers are one vote group
      const a = umidDoc("u7");
      const dup = JSON.parse(JSON.stringify(a));
      expect(ActiveCrypto.Hash.getHash(JSON.stringify(a))).to.equal(ActiveCrypto.Hash.getHash(JSON.stringify(dup)));
      knockResult = [a, dup];
      const ia = build();
      await ia.processDocument({ _id: "e7", code: ErrorCodes.StreamNotFound, umid: "u7" });
      expect(bulk.length).to.equal(1);
    });

    it("propagates an insert failure and keeps the error document", async () => {
      knockResult = [umidDoc("u8")];
      (Provider as any).database.bulkDocs = async () => {
        throw new Error("disk");
      };
      const ia = build();
      let err: any;
      try {
        await ia.processDocument({ _id: "e8", code: ErrorCodes.StreamNotFound, umid: "u8" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("disk");
      expect(purged).to.deep.equal([]);
      expect(logs.some((l) => /Adding UMID failed/.test(String(l.msg)))).to.equal(true);
    });
  });

  describe("verifyUmidNotFound", () => {
    it("is true when the store says it does not exist", async () => {
      expect(await build().verifyUmidNotFound("x")).to.equal(true);
    });
    it("is false when it exists and can be read", async () => {
      live["x:umid"] = {};
      expect(await build().verifyUmidNotFound("x")).to.equal(false);
    });
    it("is true when exists lies and the read fails", async () => {
      (Provider as any).database.exists = async () => true;
      expect(await build().verifyUmidNotFound("x")).to.equal(true);
    });
  });

  describe("insertUmid", () => {
    it("resolves without writing for an empty document", async () => {
      await build().insertUmid(undefined);
      expect(bulk).to.deep.equal([]);
      expect(posted).to.deep.equal([]);
    });
  });

  describe("setProcessed / archive", () => {
    it("rejects when archiving fails", async () => {
      (Provider as any).errorDatabase.purge = async () => {
        throw new Error("nope");
      };
      let err: any;
      try {
        await build().setProcessed({ _id: "z" }, true);
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("nope");
    });
    it("replaces any earlier archive copy before storing", async () => {
      const order: string[] = [];
      (Provider as any).errorArchive.purge = async () => order.push("purge");
      (Provider as any).errorArchive.put = async () => order.push("put");
      await build().archive({ _id: "z" }, true);
      expect(order).to.deep.equal(["purge", "put"]);
    });
    it("does not touch the archive when not asked", async () => {
      await build().archive({ _id: "z" });
      expect(archived).to.deep.equal([]);
      expect(putArchive).to.deep.equal([]);
    });
  });
});
