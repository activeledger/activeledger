import { expect } from "chai";
import "mocha";
import { DEFAULT_DAYS, PruneDeps, PruneFlags, pruneCommand } from "../packages/activeledger/src/cli/prune";

const NOW = 1_800_000_000_000;
const DAY = 86400e3;

/** A storage server that answers from a table, and records every call */
const fake = (over: Partial<{ dbs: unknown; pages: Record<string, any[]>; info: Record<string, any>; interactive: boolean; answers: boolean[]; selfhost: boolean; deleteAnswer: any }> = {}) => {
  const calls: { url: string; method: string; body?: any }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const answers = [...(over.answers ?? [])];
  const pages = { ...(over.pages ?? {}) };
  const deps: PruneDeps = {
    loadDb: () => (over.selfhost === false ? {} : { selfhost: { host: "127.0.0.1", port: "5259" }, database: "activeledger", event: "activeledgerevents", error: "activeledgererrors" }),
    request: async (url, method, body) => {
      calls.push({ url, method, body });
      const path = url.replace("http://127.0.0.1:5259", "");
      if (path === "/_all_dbs") return over.dbs === undefined ? ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererrors_archive"] : over.dbs;
      if (path.endsWith("/_prune")) {
        const queue = pages[`${path}:${body.kind}`] ?? pages[path];
        return queue && queue.length ? queue.shift() : { removed: 0, scanned: 0, kept: 0, done: true };
      }
      if (path.endsWith("/_compact")) return { ok: true };
      if (method === "DELETE") return over.deleteAnswer ?? { ok: true };
      if (method === "GET") return (over.info ?? {})[path.slice(1)] ?? {};
      return undefined;
    },
    confirm: async (q) => (asked.push(q), answers.length ? answers.shift()! : false),
    interactive: over.interactive ?? false,
    now: () => NOW,
    sleep: async () => undefined,
    out: { log: (t) => logs.push(t), error: (t) => errors.push(t) },
  };
  const prunes = () => calls.filter((c) => c.url.endsWith("/_prune"));
  return { deps, calls, logs, errors, asked, prunes };
};

const run = (days: string | undefined, flags: PruneFlags, f = fake()) => pruneCommand(days, flags, f.deps).then((code) => ({ code, ...f }));

describe("activeledger prune (CLI)", () => {
  describe("days", () => {
    it("keeps 30 days unless told, and says where the line is", async () => {
      const r = await run(undefined, {});
      expect(r.code).to.equal(0);
      expect(r.prunes()[0].body.before).to.equal(NOW - DEFAULT_DAYS * DAY);
      expect(r.logs[0]).to.contain("last 30 days");
    });

    it("uses the number given as the days to keep", async () => {
      const r = await run("7", {});
      expect(r.prunes()[0].body.before).to.equal(NOW - 7 * DAY);
    });

    it("says 'day' for one", async () => {
      expect((await run("1", {})).logs[0]).to.contain("last 1 day;");
    });

    for (const bad of ["0", "-3", "1.5", "abc", "", "7d", "1e3"]) {
      it(`refuses "${bad}" and touches nothing`, async () => {
        const r = await run(bad, {});
        expect(r.code).to.equal(1);
        expect(r.errors[0]).to.contain("whole number of at least 1");
        expect(r.calls).to.have.length(0);
      });
    }
  });

  describe("what it prunes", () => {
    it("by default, handled errors, the error archive and the node's expired resent records, and nothing else in the events database or the ledger", async () => {
      const r = await run("30", {});
      expect(r.prunes().map((c) => [c.url, c.body.kind, c.body.requireProcessed])).to.deep.equal([
        ["http://127.0.0.1:5259/activeledgererrors/_prune", "error", true],
        ["http://127.0.0.1:5259/activeledgererrors_archive/_prune", "error", false],
        ["http://127.0.0.1:5259/activeledgerevents/_prune", "resent", undefined],
      ]);
    });

    it("removes a resent record by when its transaction expired, not by the days to keep", async () => {
      const r = await run("7", {});
      const resent = r.prunes().find((c) => c.body.kind === "resent")!;
      expect(resent.body.before).to.equal(NOW - 60 * 60 * 1000);
      expect(r.prunes().find((c) => c.body.kind === "error")!.body.before).to.equal(NOW - 7 * DAY);
    });

    it("adds the umid index (umid and fail rows) only with --include-umids", async () => {
      const r = await run("30", { includeUmids: true });
      expect(r.prunes().map((c) => [c.url.split("/")[3], c.body.kind])).to.deep.equal([
        ["activeledgererrors", "error"],
        ["activeledgererrors_archive", "error"],
        ["activeledgerevents", "resent"],
        ["activeledgerevents", "umid"],
        ["activeledgerevents", "fail"],
      ]);
    });

    it("adds the contract events only with --include-events", async () => {
      const r = await run("30", { includeEvents: true });
      expect(r.prunes().map((c) => c.body.kind)).to.deep.equal(["error", "error", "resent", "event"]);
    });

    it("never asks about the ledger database", async () => {
      const r = await run("30", { includeUmids: true, includeEvents: true });
      expect(r.calls.filter((c) => c.url.includes("/activeledger/"))).to.have.length(0);
    });

    it("skips a database the node has not created yet", async () => {
      const r = await run("30", {}, fake({ dbs: ["activeledger", "activeledgererrors"] }));
      expect(r.prunes()).to.have.length(1);
      expect(r.logs.join("\n")).to.contain("no activeledgererrors_archive database, skipped");
    });

    it("uses the database names from the config", async () => {
      const f = fake({ dbs: ["led", "evt", "err", "err_archive"] });
      f.deps.loadDb = () => ({ selfhost: { host: "127.0.0.1", port: "5259" }, database: "led", event: "evt", error: "err" });
      const r = await run("30", { includeEvents: true }, f);
      expect(r.prunes().map((c) => c.url.split("/")[3])).to.deep.equal(["err", "err_archive", "evt", "evt"]);
      expect(r.calls.filter((c) => c.url.includes("/led/"))).to.have.length(0);
    });

    it("sends the cutoff, the page size and whether it is a dry run", async () => {
      const r = await run("30", { dryRun: true });
      expect(r.prunes()[0].body).to.deep.include({ before: NOW - 30 * DAY, limit: 5000, dryRun: true });
    });
  });

  describe("paging", () => {
    it("asks again from where the last page stopped, until the server says it is done", async () => {
      const f = fake({
        pages: {
          "/activeledgererrors/_prune": [
            { removed: 5000, scanned: 6000, kept: 1000, next: "A", done: false },
            { removed: 5000, scanned: 5000, kept: 0, next: "B", done: false },
            { removed: 120, scanned: 300, kept: 180, done: true },
          ],
        },
      });
      const r = await run("30", {}, f);
      const sent = r.prunes().filter((c) => c.url.includes("/activeledgererrors/"));
      expect(sent.map((c) => c.body.after)).to.deep.equal([undefined, "A", "B"]);
      expect(r.logs.join("\n")).to.contain("removed 10,120");
      expect(r.logs[r.logs.length - 1]).to.contain("Removed 10,120 rows in total.");
    });

    it("stops with an error if the storage refuses a page", async () => {
      const f = fake({ pages: { "/activeledgererrors/_prune": [{ error: "before must be at least an hour ago" }] } });
      const r = await run("30", {}, f);
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.contain("the storage refused: before must be at least an hour ago");
    });

    it("stops with an error if the storage gives no answer", async () => {
      const f = fake();
      const real = f.deps.request;
      f.deps.request = async (url, method, body) => (url.endsWith("/_prune") ? undefined : real(url, method, body));
      const r = await pruneCommand("30", {}, f.deps);
      expect(r).to.equal(1);
      expect(f.errors[0]).to.contain("no answer from the storage");
    });
  });

  describe("a dry run", () => {
    it("removes nothing, deletes no database and does not compact", async () => {
      const f = fake({ dbs: ["activeledger", "activeledgererrors", "activeledgererrors_archive", "stray"], pages: { "/activeledgererrors/_prune": [{ removed: 4, scanned: 4, kept: 0, done: true }] } });
      const r = await run("30", { dryRun: true, deleteDb: "stray" }, f);
      expect(r.code).to.equal(0);
      expect(r.calls.filter((c) => c.method === "DELETE")).to.have.length(0);
      expect(r.calls.filter((c) => c.url.endsWith("/_compact"))).to.have.length(0);
      expect(r.logs.join("\n")).to.contain("Dry run");
      expect(r.logs.join("\n")).to.contain("would delete database stray");
      expect(r.logs[r.logs.length - 1]).to.contain("Would remove 4 rows in total.");
    });
  });

  describe("compacting", () => {
    const removedSome = { "/activeledgererrors/_prune": [{ removed: 3, scanned: 3, kept: 0, done: true }] };

    it("compacts a database it removed from, and only that one", async () => {
      const r = await run("30", {}, fake({ pages: removedSome }));
      expect(r.calls.filter((c) => c.url.endsWith("/_compact")).map((c) => c.url)).to.deep.equal(["http://127.0.0.1:5259/activeledgererrors/_compact"]);
    });

    it("does not compact when nothing was removed", async () => {
      const r = await run("30", {});
      expect(r.calls.filter((c) => c.url.endsWith("/_compact"))).to.have.length(0);
    });

    it("does not compact with --no-compact", async () => {
      const r = await run("30", { noCompact: true }, fake({ pages: removedSome }));
      expect(r.calls.filter((c) => c.url.endsWith("/_compact"))).to.have.length(0);
    });
  });

  describe("the umid index warning", () => {
    it("asks before keeping under 30 days of it, and stops on anything but yes", async () => {
      const f = fake({ interactive: true, answers: [false] });
      const r = await run("7", { includeUmids: true }, f);
      expect(r.code).to.equal(1);
      expect(r.asked).to.have.length(1);
      expect(r.asked[0]).to.contain("7 days");
      expect(r.prunes()).to.have.length(0);
    });

    it("carries on when told yes", async () => {
      const r = await run("7", { includeUmids: true }, fake({ interactive: true, answers: [true] }));
      expect(r.code).to.equal(0);
      expect(r.prunes().length).to.be.greaterThan(0);
    });

    it("does not ask with --yes", async () => {
      const r = await run("7", { includeUmids: true, yes: true }, fake({ interactive: true }));
      expect(r.asked).to.have.length(0);
      expect(r.code).to.equal(0);
    });

    it("refuses without --yes when there is no terminal to ask on", async () => {
      const r = await run("7", { includeUmids: true }, fake({ interactive: false }));
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.contain("needs --yes");
      expect(r.prunes()).to.have.length(0);
    });

    it("does not ask at 30 days or more, or without --include-umids", async () => {
      expect((await run("30", { includeUmids: true }, fake({ interactive: true }))).asked).to.have.length(0);
      expect((await run("7", {}, fake({ interactive: true }))).asked).to.have.length(0);
      expect((await run("7", { includeEvents: true }, fake({ interactive: true }))).asked).to.have.length(0);
    });
  });

  describe("databases it does not recognise", () => {
    const dbs = ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererrors_archive", "other_tool", "old_test"];
    const info = { other_tool: { doc_count: 1200, data_size: 5 * 1024 * 1024 }, old_test: { doc_count: 3, data_size: 2048 } };

    it("lists them and leaves them alone when there is no terminal", async () => {
      const r = await run("30", {}, fake({ dbs, info }));
      expect(r.calls.filter((c) => c.method === "DELETE")).to.have.length(0);
      const text = r.logs.join("\n");
      expect(text).to.contain("left alone: old_test (3 documents, 0.0 MB) (use --delete-db old_test to delete it)");
      expect(text).to.contain("left alone: other_tool (1,200 documents, 5.0 MB)");
    });

    it("asks about each, defaulting to no, and deletes only what is answered yes", async () => {
      const f = fake({ dbs, info, interactive: true, answers: [false, true] });
      const r = await run("30", {}, f);
      expect(r.asked).to.have.length(2);
      expect(r.asked[0]).to.contain("old_test");
      expect(r.asked[1]).to.contain("other_tool");
      expect(r.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).to.deep.equal(["http://127.0.0.1:5259/other_tool"]);
    });

    it("does not delete a database because of --yes", async () => {
      const r = await run("30", { yes: true }, fake({ dbs, info, interactive: false }));
      expect(r.calls.filter((c) => c.method === "DELETE")).to.have.length(0);
    });

    it("deletes a database named with --delete-db, without asking", async () => {
      const f = fake({ dbs, info, interactive: true });
      const r = await run("30", { deleteDb: "old_test" }, f);
      expect(r.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).to.deep.equal(["http://127.0.0.1:5259/old_test"]);
      expect(r.asked.some((q) => q.includes("old_test"))).to.equal(false);
    });

    it("takes --delete-db more than once", async () => {
      const r = await run("30", { deleteDb: ["old_test", "other_tool"] }, fake({ dbs, info }));
      expect(r.calls.filter((c) => c.method === "DELETE").map((c) => c.url).sort()).to.deep.equal(["http://127.0.0.1:5259/old_test", "http://127.0.0.1:5259/other_tool"]);
    });

    it("says so when a database named with --delete-db is not there", async () => {
      const r = await run("30", { deleteDb: "ghost" }, fake({ dbs, info }));
      expect(r.logs.join("\n")).to.contain("--delete-db ghost: there is no such database");
      expect(r.calls.filter((c) => c.method === "DELETE")).to.have.length(0);
    });

    for (const protectedName of ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererrors_archive"]) {
      it(`refuses to delete the node's own ${protectedName} before touching anything`, async () => {
        const r = await run("30", { deleteDb: ["old_test", protectedName] }, fake({ dbs, info }));
        expect(r.code).to.equal(1);
        expect(r.errors[0]).to.contain("one of this node's own databases");
        expect(r.calls).to.have.length(0);
      });
    }

    for (const bad of ["../etc", "a/b", "..", "a b", "", "x\u0000"]) {
      it(`refuses the name ${JSON.stringify(bad)} as not a plain database name`, async () => {
        const r = await run("30", { deleteDb: bad }, fake({ dbs, info }));
        expect(r.code).to.equal(1);
        expect(r.errors[0]).to.contain("not a plain database name");
        expect(r.calls).to.have.length(0);
      });
    }

    it("stops with an error if a delete is not acknowledged", async () => {
      const r = await run("30", { deleteDb: "old_test" }, fake({ dbs, info, deleteAnswer: { error: "busy" } }));
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.contain("could not delete old_test: busy");
    });

    it("does not ask in --json mode, where there is nothing to read the question", async () => {
      const f = fake({ dbs, info, interactive: true, answers: [true, true] });
      const r = await run("30", { json: true }, f);
      expect(r.asked).to.have.length(0);
      expect(r.calls.filter((c) => c.method === "DELETE")).to.have.length(0);
    });
  });

  describe("when it cannot run", () => {
    it("says so for a node on CouchDB", async () => {
      const r = await run("30", {}, fake({ selfhost: false }));
      expect(r.code).to.equal(1);
      expect(r.errors[0]).to.contain("CouchDB");
      expect(r.calls).to.have.length(0);
    });

    it("says the node may not be running when the storage does not answer", async () => {
      const f = fake();
      f.deps.request = async () => {
        throw new Error("ECONNREFUSED");
      };
      const r = await run("30", {}, f);
      expect(r.code).to.equal(2);
      expect(r.errors[0]).to.contain("Is the node running?");
    });

    it("says the same when the answer is not a list of databases", async () => {
      const r = await run("30", {}, fake({ dbs: null }));
      expect(r.code).to.equal(2);
    });
  });

  describe("--json", () => {
    it("prints one JSON object and nothing else", async () => {
      const f = fake({ pages: { "/activeledgererrors/_prune": [{ removed: 3, scanned: 5, kept: 2, done: true }] } });
      const r = await run("30", { json: true }, f);
      expect(r.logs).to.have.length(1);
      const out = JSON.parse(r.logs[0]);
      expect(out).to.deep.include({ days: 30, before: NOW - 30 * DAY, dryRun: false, removed: 3 });
      expect(out.tallies[0]).to.deep.equal({ label: "errors", db: "activeledgererrors", removed: 3, scanned: 5, kept: 2 });
      expect(out.compacted).to.deep.equal(["activeledgererrors"]);
    });
  });
});
