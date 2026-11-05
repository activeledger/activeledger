import { expect } from "chai";
import "mocha";
import { ActiveLogger } from "@activeledger/activelogger";
import { Shared } from "../packages/protocol/src/protocol/shared";

type Emitted = { event: string; args: any[] };

describe("Shared error handling and stream helpers (cov)", () => {
  const saved: any = {};
  let logged: { level: string; args: any[] }[];

  beforeEach(() => {
    logged = [];
    for (const level of ["error", "fatal"]) {
      saved[level] = (ActiveLogger as any)[level];
      (ActiveLogger as any)[level] = (...args: any[]) => {
        logged.push({ level, args });
        return new Error("x");
      };
    }
  });
  afterEach(() => {
    for (const level of Object.keys(saved)) (ActiveLogger as any)[level] = saved[level];
  });

  const build = (opts: { single?: boolean; post?: (doc: any) => Promise<any> } = {}) => {
    const posts: any[] = [];
    const emitted: Emitted[] = [];
    const entry: any = {
      $umid: "umid1",
      $tx: { a: 1 },
      $nodes: {
        n1: { vote: true, incomms: { secret: 1 } },
        n2: { vote: false, incomms: "x" },
      },
    };
    const dbe: any = {
      post: (doc: any) => {
        posts.push(doc);
        return opts.post ? opts.post(doc) : Promise.resolve({ id: "doc-" + posts.length });
      },
    };
    const emitter: any = {
      emitFailed: (...args: any[]) => emitted.push({ event: "emitFailed", args }),
      emit: (event: string, ...args: any[]) => emitted.push({ event, args }),
    };
    const shared = new Shared(!!opts.single, entry, dbe, emitter);
    return { shared, posts, emitted, entry };
  };

  describe("errorOut", () => {
    it("starts empty and can be replaced wholesale", () => {
      const { shared } = build();
      expect(shared.errorOut).to.deep.equal({ code: 0, reason: "", priority: 0 });
      shared.errorOut = { code: 9, reason: "r", priority: 3 };
      expect(shared.errorOut).to.deep.equal({ code: 9, reason: "r", priority: 3 });
    });
  });

  describe("storeError", () => {
    it("records the code and the most useful reason text", async () => {
      const { shared } = build();
      await shared.storeError(1200, new Error("boom"));
      expect(shared.errorOut).to.deep.equal({ code: 1200, reason: "boom", priority: 0 });
    });

    it("falls back from message to error to toString to a default reason", async () => {
      const { shared } = build({ single: true });
      await shared.storeError(1, { message: "m", error: "e" });
      expect(shared.errorOut.reason).to.equal("m");
      await shared.storeError(1, { error: "e" });
      expect(shared.errorOut.reason).to.equal("e");
      await shared.storeError(1, "plain");
      expect(shared.errorOut.reason).to.equal("plain");
      await shared.storeError(1, { toString: () => "" } as any);
      expect(shared.errorOut.reason).to.equal("Uncaught Error Reason");
      await shared.storeError(1, undefined as any);
      expect(shared.errorOut.reason).to.equal("Uncaught Error Reason");
    });

    it("only a priority at least as high replaces the reported error", async () => {
      const { shared } = build({ single: true });
      await shared.storeError(10, "first", 5);
      await shared.storeError(20, "lower", 4);
      expect(shared.errorOut).to.deep.equal({ code: 10, reason: "first", priority: 5 });
      await shared.storeError(30, "equal", 5);
      expect(shared.errorOut).to.deep.equal({ code: 30, reason: "equal", priority: 5 });
      await shared.storeError(40, "higher", 6);
      expect(shared.errorOut).to.deep.equal({ code: 40, reason: "higher", priority: 6 });
    });

    it("stores one error document with the incomms stripped from a copy of the nodes", async () => {
      const { shared, posts, entry } = build();
      const before = Date.now();
      const result = await shared.storeError(1300, "bad thing");
      expect(result).to.deep.equal({ id: "doc-1" });
      expect(posts).to.have.length(1);
      const doc = posts[0];
      expect(doc._id).to.match(/^umid1:\d+$/);
      expect(parseInt(doc._id.split(":")[1], 10)).to.be.within(before, Date.now());
      expect(doc.code).to.equal(1300);
      expect(doc.umid).to.equal("umid1");
      expect(doc.processed).to.equal(false);
      expect(doc.reason).to.equal("bad thing");
      expect(doc.transaction.$tx).to.equal(entry.$tx);
      expect(doc.transaction.$nodes).to.deep.equal({
        n1: { vote: true, incomms: null },
        n2: { vote: false, incomms: null },
      });
      // the live entry keeps its incomms for the other nodes
      expect(entry.$nodes.n1.incomms).to.deep.equal({ secret: 1 });
      expect(logged[0].level).to.equal("error");
      expect(logged[0].args[1]).to.equal("TX Error Logged umid : umid1");
    });

    it("a second error is not stored and returns the first document", async () => {
      const { shared, posts } = build();
      const first = await shared.storeError(1, "one");
      const second = await shared.storeError(2, "two");
      expect(posts).to.have.length(1);
      expect(second).to.equal((shared as any)._storedSingleErrorDoc);
      expect(first).to.deep.equal({ id: "doc-1" });
    });

    it("with single error storage on it never posts and returns the default document", async () => {
      const { shared, posts } = build({ single: true });
      const doc = await shared.storeError(1, "x");
      expect(posts).to.have.length(0);
      expect(doc).to.deep.equal({ id: "Default Error Id" });
    });
  });

  describe("raiseLedgerError", () => {
    it("emits the failure with the stored error id appended", async () => {
      const { shared, emitted } = build();
      await shared.raiseLedgerError(1400, "went wrong", false, 0, true);
      expect(emitted).to.deep.equal([
        {
          event: "emitFailed",
          args: [{ status: 1400, error: "went wrong - Error doc-1" }, true],
        },
      ]);
    });

    it("leaves the reason alone when the stored document has no id", async () => {
      const { shared, emitted } = build({ post: async () => ({}) });
      await shared.raiseLedgerError(1401, "no id");
      expect(emitted[0].args).to.deep.equal([{ status: 1401, error: "no id" }, false]);
    });

    it("emits the highest priority error seen, not the latest", async () => {
      const { shared, emitted } = build({ single: true });
      await shared.raiseLedgerError(1, "important", false, 9);
      await shared.raiseLedgerError(2, "minor", false, 1);
      expect(emitted[1].args[0]).to.deep.equal({
        status: 1,
        error: "important - Error Default Error Id",
      });
    });

    it("stores but does not emit when asked to stop", async () => {
      const { shared, emitted, posts } = build();
      await shared.raiseLedgerError(1500, "quiet", true);
      expect(posts).to.have.length(1);
      expect(emitted).to.deep.equal([]);
    });

    it("still fails the transaction when the error cannot be stored", async () => {
      const dbError = new Error("database down");
      const { shared, emitted } = build({ post: () => Promise.reject(dbError) });
      await shared.raiseLedgerError(1600, "lost", false, 0, true);
      expect(emitted).to.deep.equal([
        { event: "failed", args: [{ status: 1600, error: dbError }, true] },
      ]);
      expect(logged.find((l) => l.level === "fatal")!.args[1]).to.equal(
        "Database Error Log Issues"
      );
    });

    it("emits nothing for an unstorable error when told to stop", async () => {
      const { shared, emitted } = build({ post: () => Promise.reject(new Error("down")) });
      await shared.raiseLedgerError(1, "x", true);
      expect(emitted).to.deep.equal([]);
      expect(logged.some((l) => l.level === "fatal")).to.equal(true);
    });
  });

  describe("filterPrefix", () => {
    const id = (c: string) => c.repeat(64);

    it("passes a normal stream id through, keeping any suffix", () => {
      const { shared } = build();
      expect(shared.filterPrefix(id("a"))).to.equal(id("a"));
      expect(shared.filterPrefix(id("a") + ":stream")).to.equal(id("a") + ":stream");
      expect(shared.assumedVirtualPrefix).to.equal("");
    });

    it("keeps an id of exactly 64 characters but trims 65", () => {
      const { shared } = build();
      expect(shared.filterPrefix("x" + id("b"))).to.equal(id("b"));
      expect(shared.assumedVirtualPrefix).to.equal("xb");
    });

    it("trims a prefixed id to its last 64 characters, remembers the prefix and keeps the suffix", () => {
      const { shared } = build();
      const long = "ab" + id("c");
      expect(shared.filterPrefix(long + ":volatile")).to.equal(id("c") + ":volatile");
      expect(shared.assumedVirtualPrefix).to.equal("ab");
      // the first prefix seen wins
      shared.filterPrefix("zz" + id("d"));
      expect(shared.assumedVirtualPrefix).to.equal("ab");
    });

    it("maps both ways and answers repeat lookups from the map", () => {
      const { shared } = build();
      const long = "ab" + id("e");
      expect(shared.filterPrefix(long)).to.equal(id("e"));
      expect(shared.filterPrefix(long)).to.equal(id("e"));
      // the trimmed form maps back to what was asked for
      expect(shared.filterPrefix(id("e"))).to.equal(long);
      // skipMap recomputes instead of using the map
      expect(shared.filterPrefix(id("e"), true)).to.equal(id("e"));
      expect(shared.filterPrefix(long, true)).to.equal(id("e"));
    });
  });

  describe("clearAllComms", () => {
    it("wipes every node's incomms except the preserved output when the VM asks", () => {
      const { shared, entry } = build();
      const keep = { keep: true };
      entry.$nodes.n1.incomms = keep;
      entry.$nodes.n2.incomms = { other: 1 };
      const asked: string[] = [];
      const vm: any = {
        clearingInternodeCommsFromVM: (umid: string) => (asked.push(umid), true),
      };
      const out = shared.clearAllComms(vm, keep);
      expect(out).to.equal(entry);
      expect(asked).to.deep.equal(["umid1"]);
      expect(entry.$nodes.n1.incomms).to.equal(keep);
      expect(entry.$nodes.n2.incomms).to.equal(null);
    });

    it("leaves incomms alone when the VM did not ask", () => {
      const { shared, entry } = build();
      const vm: any = { clearingInternodeCommsFromVM: () => false };
      shared.clearAllComms(vm, null);
      expect(entry.$nodes.n1.incomms).to.deep.equal({ secret: 1 });
      expect(entry.$nodes.n2.incomms).to.equal("x");
    });
  });
});
