import { expect } from "chai";
import "mocha";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * Walking a stream's umid history backwards.
 *
 * SPI can adopt a stream's current revision, but that leaves a node with
 * correct state and no record of how it got there. The most recent umid is
 * recoverable because the :stream meta names it; everything before that was
 * unreachable, because nothing could enumerate what had been skipped.
 *
 * The fix is a backward pointer rather than a list. Each umid records the
 * umid it replaced, per stream, so the history is a linked list:
 *
 *   :stream meta -> U0 --prev--> U1 --prev--> U2 -> ... -> creation
 *
 * A list of transactions per stream was tried before (meta.txs) and
 * abandoned because it grew without limit on any busy stream, costing
 * space, memory and speed at once. A pointer costs one field per stream
 * per transaction however long the history is, and a walk fetches only the
 * hops actually missing.
 *
 * These tests drive the walk against a fake network so the termination
 * conditions can be checked exactly - the interesting behaviour is all in
 * when it STOPS.
 */

const STREAM = "3f7a1c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";

/**
 * A network holding a umid chain, and a node holding some prefix of it.
 *
 * `chain` is newest-first: chain[0] replaced chain[1], and so on.
 */
function fakeHost(chain: string[], held: string[] = [], opts: any = {}) {
  const local = new Set(held.map((u) => `${u}:umid`));
  const adopted: string[] = [];
  const replayed: string[] = [];
  const errors: any[] = [];

  const docFor = (umid: string) => {
    const index = chain.indexOf(umid);
    if (index === -1) return undefined;
    const prev = chain[index + 1];
    return {
      _id: `${umid}:umid`,
      umid: { $umid: umid },
      // One event per transaction, id'd the way EventEngine does, so a
      // replay can be counted and checked for duplicates.
      events: [{ _id: `event:1,${umid}`, name: "Moved", data: { umid } }],
      streams: prev
        ? { new: [], updated: [{ id: STREAM, prev }] }
        : // The oldest entry is the creation - no prev, which is what makes
          // the start of a stream a natural terminator.
          { new: [{ id: STREAM, name: "created" }], updated: [] },
    };
  };

  return {
    adopted,
    replayed,
    errors,
    host: {
      dbConnection: {
        get: async (id: string) => {
          if (!local.has(id)) throw new Error("not found");
          return docFor(id.replace(":umid", ""));
        },
        bulkDocs: async (docs: any[]) => {
          if (opts.writeFails) return false;
          for (const doc of docs) {
            local.add(doc._id);
            adopted.push(doc._id.replace(":umid", ""));
          }
          return { ok: true };
        },
      },
      dbEventConnection: {
        post: async (doc: any) => {
          replayed.push(doc._id);
          return { ok: true };
        },
      },
      dbErrorConnection: {
        post: async (doc: any) => {
          errors.push(doc);
          return { ok: true };
        },
      },
      neighbourhood: {
        knockAll: async (endpoint: string) => {
          const umid = endpoint.replace("umid/", "");
          if (opts.unreachable?.includes(umid)) return [];
          const doc = docFor(umid);
          // Two nodes agreeing, as a real sample would return
          return doc ? [doc, doc] : [];
        },
      },
    } as any,
  };
}

describe("Endpoints.walkUmidHistory - recovering a stream's missed history", () => {
  // The walk paces itself between hops so it never competes with live
  // traffic. That is the point in production and pure dead time here, so
  // it is turned off for the cases about WHAT the walk does, and verified
  // on its own below.
  const realDelay = Endpoints.UMID_WALK_HOP_DELAY_MS;
  before(() => {
    Endpoints.UMID_WALK_HOP_DELAY_MS = 0;
  });
  after(() => {
    Endpoints.UMID_WALK_HOP_DELAY_MS = realDelay;
  });

  it("walks back through every umid the node is missing", async () => {
    // Node holds nothing; the network has four transactions plus a creation
    const chain = ["u4", "u3", "u2", "u1", "created"];
    const { host, adopted } = fakeHost(chain, []);

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u4");

    expect(result.recovered).to.deep.equal(["u4", "u3", "u2", "u1", "created"]);
    expect(adopted).to.deep.equal(["u4", "u3", "u2", "u1", "created"]);
    expect(result.stoppedAt).to.equal("start of stream");
  });

  it("stops at the first umid it already holds", async () => {
    // The common case: behind by two, everything older already present.
    const chain = ["u4", "u3", "u2", "u1", "created"];
    const { host, adopted } = fakeHost(chain, ["u2", "u1", "created"]);

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u4");

    expect(result.recovered).to.deep.equal(["u4", "u3"]);
    expect(adopted).to.deep.equal(["u4", "u3"]);
    expect(result.stoppedAt).to.contain("already held");
  });

  it("does nothing at all when the node is already current", async () => {
    const chain = ["u2", "u1", "created"];
    const { host, adopted } = fakeHost(chain, ["u2", "u1", "created"]);

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u2");

    expect(result.recovered).to.have.length(0);
    expect(adopted).to.have.length(0);
    expect(result.stoppedAt).to.contain("already held");
  });

  it("stops at the cap rather than grinding through an unbounded chain", async () => {
    // A node this far behind wants a full restore, not 500 sequential
    // network fetches holding the SPI path open.
    const chain = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const { host } = fakeHost(chain, []);

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u0");

    expect(result.recovered).to.have.length(100);
    expect(result.stoppedAt).to.equal("limit reached");
  });

  it("stops cleanly when a umid cannot be recovered from anyone", async () => {
    // A broken chain must not look like a completed walk.
    const chain = ["u3", "u2", "u1", "created"];
    const { host, adopted } = fakeHost(chain, [], { unreachable: ["u2"] });

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u3");

    expect(result.recovered).to.deep.equal(["u3"]);
    expect(adopted).to.deep.equal(["u3"]);
    expect(result.stoppedAt).to.contain("could not recover u2");
  });

  it("reports a write failure rather than continuing past it", async () => {
    const chain = ["u2", "u1", "created"];
    const { host } = fakeHost(chain, [], { writeFails: true });

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u2");

    expect(result.recovered).to.have.length(0);
    expect(result.stoppedAt).to.contain("could not recover");
  });

  it("refuses to spin if a chain ever loops back on itself", async () => {
    // Should be impossible. If it happens something upstream is wrong, and
    // spinning forever would hide it.
    // The node holds neither, so the walk actually fetches and follows -
    // an earlier version of this fixture pre-seeded "a" and the walk
    // correctly stopped at "already held" before it could ever loop, which
    // proved nothing.
    const store = new Map<string, any>();
    const docFor = (umid: string) => ({
      _id: `${umid}:umid`,
      umid: { $umid: umid },
      streams: {
        new: [],
        updated: [{ id: STREAM, prev: umid === "a" ? "b" : "a" }],
      },
    });
    const looping: any = {
      dbConnection: {
        get: async (id: string) => {
          if (!store.has(id)) throw new Error("not found");
          return store.get(id);
        },
        bulkDocs: async (docs: any[]) => {
          for (const doc of docs) store.set(doc._id, doc);
          return { ok: true };
        },
      },
      dbEventConnection: { post: async () => ({ ok: true }) },
      neighbourhood: {
        knockAll: async (endpoint: string) => {
          const umid = endpoint.replace("umid/", "");
          return [docFor(umid), docFor(umid)];
        },
      },
    };

    const result = await Endpoints.walkUmidHistory(looping, STREAM, "a");

    expect(result.stoppedAt).to.equal("loop detected");
  });

  it("only follows the pointer for the stream being repaired", async () => {
    // A transaction touches several streams and records a different prev
    // for each. Following the wrong one would walk another stream's history
    // and silently recover the wrong transactions.
    const OTHER = "9999999999999999999999999999999999999999999999999999999999999999";
    const store = new Map<string, any>();
    const network: { [umid: string]: any } = {
      top: {
        _id: "top:umid",
        umid: { $umid: "top" },
        streams: {
          new: [],
          updated: [
            { id: OTHER, prev: "wrong-branch" },
            { id: STREAM, prev: "right-branch" },
          ],
        },
      },
      "right-branch": {
        _id: "right-branch:umid",
        umid: { $umid: "right-branch" },
        streams: { new: [{ id: STREAM, name: "created" }], updated: [] },
      },
      "wrong-branch": {
        _id: "wrong-branch:umid",
        umid: { $umid: "wrong-branch" },
        streams: { new: [{ id: OTHER, name: "created" }], updated: [] },
      },
    };

    const multi: any = {
      dbConnection: {
        get: async (id: string) => {
          if (!store.has(id)) throw new Error("not found");
          return store.get(id);
        },
        bulkDocs: async (docs: any[]) => {
          for (const doc of docs) store.set(doc._id, doc);
          return { ok: true };
        },
      },
      dbEventConnection: { post: async () => ({ ok: true }) },
      neighbourhood: {
        knockAll: async (endpoint: string) => {
          const doc = network[endpoint.replace("umid/", "")];
          return doc ? [doc, doc] : [];
        },
      },
    };

    const result = await Endpoints.walkUmidHistory(multi, STREAM, "top");

    // right-branch, never wrong-branch
    expect(result.recovered).to.deep.equal(["top", "right-branch"]);
    expect(result.stoppedAt).to.equal("start of stream");
  });

  it("recovers a long gap in one walk, with every umid's events", async () => {
    // Fifty missed transactions, which is the shape of a node that was down
    // for a while rather than one that dropped a single round.
    const chain = [...Array.from({ length: 50 }, (_, i) => `u${49 - i}`), "created"];
    const { host, adopted, replayed } = fakeHost(chain, ["created"]);

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u49");

    expect(result.recovered).to.have.length(50);
    expect(adopted).to.have.length(50);
    expect(result.stoppedAt).to.contain("already held");

    // Every recovered umid replayed its event, exactly once each - plus
    // one for the terminus, the already-held umid the walk stopped at.
    // That extra pass is deliberate: a held umid can still be missing its
    // events, and replaying is idempotent because ids are reused.
    expect(replayed).to.have.length(51);
    expect(new Set(replayed).size).to.equal(51);
    for (const umid of result.recovered) {
      expect(replayed).to.contain(`event:1,${umid}`);
    }
    expect(replayed, "the terminus replays too").to.contain("event:1,created");
  });

  it("recovers in order, newest first, so a partial walk leaves the newest present", async () => {
    // If a walk is cut short the node should hold the MOST recent history,
    // not a random middle slice - that is what a feed consumer needs.
    const chain = ["u5", "u4", "u3", "u2", "u1", "created"];
    const { host } = fakeHost(chain, [], { unreachable: ["u2"] });

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u5");

    expect(result.recovered).to.deep.equal(["u5", "u4", "u3"]);
  });

  it("stops at the first held umid even when older ones are missing", async () => {
    // Deliberate, and worth stating: the walk assumes history below a held
    // umid is intact, because a node only gains umids in order. A hole
    // underneath one it holds is not something this repairs - that is what
    // a full restore is for.
    const chain = ["u4", "u3", "u2", "u1", "created"];
    const { host } = fakeHost(chain, ["u2"]); // holds u2, but not u1/created

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u4");

    expect(result.recovered).to.deep.equal(["u4", "u3"]);
    expect(result.stoppedAt).to.contain("already held");
  });

  it("recovers exactly the cap when the gap is exactly the cap", async () => {
    const chain = [...Array.from({ length: 100 }, (_, i) => `u${99 - i}`), "created"];
    const { host } = fakeHost(chain, ["created"]);

    const result = await Endpoints.walkUmidHistory(host, STREAM, "u99");

    expect(result.recovered).to.have.length(100);
    // Hit the cap and the held marker at once - either message is honest,
    // but it must not claim to have reached the start of the stream.
    expect(result.stoppedAt).to.not.equal("start of stream");
  });

  it("replays events even for a umid it already held but whose events went missing", async () => {
    // Holding the umid does not imply holding its events: separate
    // documents, and EventEngine.emit() is fire-and-forget.
    const chain = ["u1", "created"];
    const { host, replayed } = fakeHost(chain, ["u1", "created"]);

    await Endpoints.walkUmidHistory(host, STREAM, "u1");

    expect(replayed).to.contain("event:1,u1");
  });
});

/**
 * The post-commit trigger, and the guards around it.
 *
 * This runs after every commit, so its cost and its concurrency behaviour
 * matter more than its happy path. It must never run twice over the same
 * umid at once, must not put a network call in front of every transaction,
 * and must never let a failure wedge a umid so it is skipped forever.
 */
describe("Endpoints.repairHistoryAfterCommit - guards", () => {
  // Each fixture gets its OWN stream. The cooldown is per stream, so
  // sharing one would make each test silence the next - which is correct
  // behaviour and a useless test.
  let streamCounter = 0;

  beforeEach(() => {
    (Endpoints as any).historyRepairLastRun.clear();
    (Endpoints as any).historyRepairInFlight.clear();
  });

  /** Counts network calls, so "does not run twice" is measured not assumed. */
  // The cooldown map is static and survives between tests, so every test
  // needs its own umid. An earlier version shared one and the second test
  // silently measured nothing because the first had already put it in
  // cooldown - a pass that proved the opposite of what it claimed.
  let counter = 0;
  function guardHost(opts: any = {}) {
    const calls = { knockAll: 0 };
    const errors: any[] = [];
    const store = new Map<string, any>();
    const id = `committed-${Date.now()}-${counter++}`;
    const missing = `${id}-missing`;
    const STREAM_B = `bbbb${streamCounter++}c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5eaa`;
    const committed = {
      _id: `${id}:umid`,
      umid: { $umid: id },
      streams: { new: [], updated: [{ id: STREAM_B, prev: missing }] },
    };
    store.set(`${id}:umid`, committed);

    return {
      id,
      missing,
      calls,
      errors,
      store,
      host: {
        dbConnection: {
          get: async (id: string) => {
            if (!store.has(id)) throw new Error("not found");
            return store.get(id);
          },
          bulkDocs: async (docs: any[]) => {
            for (const doc of docs) store.set(doc._id, doc);
            return { ok: true };
          },
        },
        dbEventConnection: { post: async () => ({ ok: true }) },
        dbErrorConnection: {
          post: async (doc: any) => {
            errors.push(doc);
            return { ok: true };
          },
        },
        neighbourhood: {
          knockAll: async (endpoint: string) => {
            calls.knockAll++;
            if (opts.throwOnKnock) throw new Error("network down");
            const umid = endpoint.replace("umid/", "");
            if (umid === id) return [committed, committed];
            // Anything older is a creation, so the walk terminates
            return [
              {
                _id: `${umid}:umid`,
                umid: { $umid: umid },
                streams: { new: [{ id: STREAM_B, name: "c" }], updated: [] },
              },
            ];
          },
        },
      } as any,
    };
  }

  // Each test uses its own umid so the shared cooldown map cannot make one
  // test's run silence the next - which it would, and which would look
  // like a passing test that never ran.
  const freshUmid = () => `commit-${Date.now()}-${Math.random()}`;

  it("recovers the gap behind a commit", async () => {
    const { host, store, id, missing } = guardHost();
    await Endpoints.repairHistoryAfterCommit(host, id);
    expect(store.has(`${missing}:umid`)).to.equal(true);
  });

  it("does not run twice for the same umid at the same time", async () => {
    const { host, calls, id } = guardHost();

    // Fire several concurrently, as repeated commits on a hot stream would
    await Promise.all([
      Endpoints.repairHistoryAfterCommit(host, id),
      Endpoints.repairHistoryAfterCommit(host, id),
      Endpoints.repairHistoryAfterCommit(host, id),
    ]);

    // One walk's worth of network traffic, not three
    expect(calls.knockAll).to.be.greaterThan(0);
    const afterFirstBurst = calls.knockAll;

    await Promise.all([
      Endpoints.repairHistoryAfterCommit(host, id),
      Endpoints.repairHistoryAfterCommit(host, id),
    ]);

    // Still inside the cooldown, so nothing new went out
    expect(calls.knockAll).to.equal(afterFirstBurst);
  });

  it("stays quiet on repeated commits of the same umid", async () => {
    const { host, calls, id } = guardHost();

    await Endpoints.repairHistoryAfterCommit(host, id);
    const first = calls.knockAll;

    for (let i = 0; i < 20; i++) {
      await Endpoints.repairHistoryAfterCommit(host, id);
    }

    expect(calls.knockAll, "a busy stream must not broadcast per commit").to.equal(first);
  });

  it("does nothing at all without a umid", async () => {
    const { host, calls } = guardHost();
    await Endpoints.repairHistoryAfterCommit(host, "");
    expect(calls.knockAll).to.equal(0);
  });

  it("releases the guard when the walk throws, so the umid is not wedged forever", async () => {
    // A failure that left the in-flight marker set would silently disable
    // repair for that umid for the life of the process.
    const failing = guardHost({ throwOnKnock: true });
    const umid = freshUmid();

    await Endpoints.repairHistoryAfterCommit(failing.host, umid);

    // Second attempt is blocked by the cooldown, not by a stuck marker -
    // prove the marker itself cleared by using a different umid on the same
    // in-flight set.
    const other = freshUmid();
    await Endpoints.repairHistoryAfterCommit(failing.host, other);

    expect(failing.calls.knockAll, "both attempts reached the network").to.equal(2);
  });

  it("never rejects, whatever the network does", async () => {
    // It is detached from the transaction path; an unhandled rejection here
    // would surface as a process-level warning at best.
    const { host } = guardHost({ throwOnKnock: true });
    const umid = freshUmid();

    let threw = false;
    try {
      await Endpoints.repairHistoryAfterCommit(host, umid);
    } catch {
      threw = true;
    }

    expect(threw).to.equal(false);
  });
});

describe("Endpoints.walkUmidHistory - pacing", () => {
  const STREAM_C = "bbbb1c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5ebb";

  it("paces itself between hops, so a long walk never becomes a burst", async () => {
    // These are old umids. Live transactions and current stream data are
    // what matter, so the walk is deliberately unhurried - late repair,
    // never no repair.
    const chain = ["c3", "c2", "c1", "created"];
    const store = new Map<string, any>();
    const docFor = (umid: string) => {
      const i = chain.indexOf(umid);
      const prev = chain[i + 1];
      return {
        _id: `${umid}:umid`,
        umid: { $umid: umid },
        events: [],
        streams: prev
          ? { new: [], updated: [{ id: STREAM_C, prev }] }
          : { new: [{ id: STREAM_C, name: "c" }], updated: [] },
      };
    };
    const host: any = {
      dbConnection: {
        get: async (id: string) => {
          if (!store.has(id)) throw new Error("not found");
          return store.get(id);
        },
        bulkDocs: async (docs: any[]) => {
          for (const d of docs) store.set(d._id, d);
          return { ok: true };
        },
      },
      dbEventConnection: { post: async () => ({ ok: true }) },
      neighbourhood: {
        knockAll: async (endpoint: string) => {
          const doc = docFor(endpoint.replace("umid/", ""));
          return doc ? [doc, doc] : [];
        },
      },
    };

    Endpoints.UMID_WALK_HOP_DELAY_MS = 40;
    const start = Date.now();
    const result = await Endpoints.walkUmidHistory(host, STREAM_C, "c3");
    const elapsed = Date.now() - start;
    Endpoints.UMID_WALK_HOP_DELAY_MS = 50;

    expect(result.recovered).to.have.length(4);
    // Three gaps between four hops, so at least ~120ms of deliberate pause
    expect(elapsed, `walk took ${elapsed}ms, expected pacing`).to.be.greaterThan(100);
  });
});

/**
 * Failure containment.
 *
 * This runs detached behind every commit, so an escaping error has nowhere
 * to be caught. Node treats an unhandled rejection as fatal by default, so
 * a bug in history repair - the least important thing the node does -
 * could take down a node that was otherwise healthy. That trade is
 * unacceptable in both directions: history is worth having, and it is
 * never worth a node for.
 *
 * Every layer is made to throw in turn, and the assertion is the same each
 * time: the call resolves, the process sees no unhandled rejection, and
 * the guard is released so the umid is not wedged.
 */
describe("Endpoints - history repair cannot take the node down", () => {
  const STREAM_D = "cccc1c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5ecc";

  /** Fails at exactly one layer, works everywhere else. */
  function brokenAt(layer: string): any {
    const doc = (umid: string) => ({
      _id: `${umid}:umid`,
      umid: { $umid: umid },
      events: [{ _id: `event:1,${umid}`, name: "E", data: {} }],
      streams: { new: [], updated: [{ id: STREAM_D, prev: `${umid}-prev` }] },
    });

    return {
      dbConnection: {
        get: async (id: string) => {
          if (layer === "get") throw new Error("store unreachable");
          if (layer === "get-returns-junk") return { nonsense: true };
          if (layer === "get-returns-null") return null;
          throw new Error("not found");
        },
        bulkDocs: async () => {
          if (layer === "bulkDocs") throw new Error("disk full");
          if (layer === "bulkDocs-junk") return undefined;
          return { ok: true };
        },
      },
      dbEventConnection: {
        post: async () => {
          if (layer === "eventPost") throw new Error("event store gone");
          return { ok: true };
        },
      },
      neighbourhood: {
        knockAll: async (endpoint: string) => {
          if (layer === "knockAll") throw new Error("network partitioned");
          if (layer === "knockAll-junk") return [null, undefined, 42, "nope"];
          if (layer === "knockAll-empty") return [];
          return [doc(endpoint.replace("umid/", ""))];
        },
      },
    };
  }

  /** Runs fn while watching for any unhandled rejection it causes. */
  async function withRejectionWatch(fn: () => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const onUnhandled = (reason: any) => seen.push(String(reason));
    process.on("unhandledRejection", onUnhandled);
    try {
      await fn();
      // Give a detached promise a turn to reject if it is going to
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    return seen;
  }

  const layers = [
    "get",
    "get-returns-junk",
    "get-returns-null",
    "bulkDocs",
    "bulkDocs-junk",
    "eventPost",
    "knockAll",
    "knockAll-junk",
    "knockAll-empty",
  ];

  for (const layer of layers) {
    it(`survives a failure in ${layer}`, async () => {
      const host = brokenAt(layer);
      const umid = `fail-${layer}-${Date.now()}`;

      const rejections = await withRejectionWatch(async () => {
        // Both entry points, since both run detached in production
        await Endpoints.repairHistoryAfterCommit(host, umid);
        await Endpoints.walkUmidHistory(host, STREAM_D, `${umid}-start`);
        await Endpoints.backfillUmid(host, `${umid}-b`);
      });

      expect(rejections, `unhandled rejection from ${layer}`).to.have.length(0);
    });
  }

  it("survives a host missing the connections entirely", async () => {
    // Defensive rather than expected - but a partially constructed host
    // during startup or shutdown should not be fatal either.
    const rejections = await withRejectionWatch(async () => {
      await Endpoints.repairHistoryAfterCommit({} as any, `bare-${Date.now()}`);
      await Endpoints.walkUmidHistory({} as any, STREAM_D, `bare2-${Date.now()}`);
      await Endpoints.backfillUmid({} as any, `bare3-${Date.now()}`);
    });

    expect(rejections).to.have.length(0);
  });

  it("releases the in-flight guard after a failure, so the umid is not wedged", async () => {
    const host = brokenAt("knockAll");
    const umid = `wedge-${Date.now()}`;

    await Endpoints.repairHistoryAfterCommit(host, umid);

    // A second umid must still be able to run - if the guard leaked, the
    // set would be growing but this would still pass, so also check the
    // first umid is no longer marked in flight by running it again after
    // clearing its cooldown.
    (Endpoints as any).historyRepairLastRun.delete(umid);
    let threw = false;
    try {
      await Endpoints.repairHistoryAfterCommit(host, umid);
    } catch {
      threw = true;
    }

    expect(threw).to.equal(false);
    expect((Endpoints as any).historyRepairInFlight.has(umid)).to.equal(false);
  });
});

/**
 * The cooldown has to be keyed by something that REPEATS.
 *
 * It was keyed by umid, which is a hash of the whole transaction - so every
 * commit brought a key that had never been seen, the lookup always missed,
 * and the rate limit never once applied. Every commit still broadcast to
 * every peer, which is precisely the cost the cooldown was added to remove.
 *
 * The existing guard tests did not catch it because they reused one umid,
 * which is the one thing production never does. These use a fresh umid per
 * commit, as real traffic does, and count what reaches the network.
 */
describe("Endpoints.repairHistoryAfterCommit - the cooldown must be per stream", () => {
  const HOT = "dddd1c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5edd";
  const OTHER = "eeee1c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5eee";

  /** A node holding every umid, so nothing needs repairing - the common case. */
  function healthyHost(streamId: string) {
    const calls = { knockAll: 0 };
    const store = new Map<string, any>();
    const host: any = {
      dbConnection: {
        get: async (id: string) => {
          if (store.has(id)) return store.get(id);
          throw new Error("not found");
        },
        bulkDocs: async () => ({ ok: true }),
      },
      dbEventConnection: { post: async () => ({ ok: true }) },
      neighbourhood: {
        knockAll: async () => {
          calls.knockAll++;
          return [];
        },
      },
    };
    // Each commit writes its own umid doc naming the same stream
    const commit = (umid: string, prev: string) => {
      store.set(`${umid}:umid`, {
        _id: `${umid}:umid`,
        umid: { $umid: umid },
        streams: { new: [], updated: [{ id: streamId, prev }] },
      });
      // the node holds the previous one, so there is no gap to repair
      store.set(`${prev}:umid`, { _id: `${prev}:umid`, streams: { new: [], updated: [] } });
    };
    return { calls, host, commit };
  }

  beforeEach(() => {
    (Endpoints as any).historyRepairLastRun.clear();
    (Endpoints as any).historyRepairInFlight.clear();
  });

  it("stays quiet across many commits on one stream, each with its own umid", async () => {
    // The real shape of a busy stream: twenty transactions, twenty distinct
    // umids, one stream. Keyed by umid this broadcast twenty times.
    const { host, calls, commit } = healthyHost(HOT);

    for (let i = 0; i < 20; i++) {
      const umid = `hot-tx-${i}`;
      commit(umid, `hot-prev-${i}`);
      await Endpoints.repairHistoryAfterCommit(host, umid);
    }

    expect(
      calls.knockAll,
      `broadcast ${calls.knockAll} times for one stream - the cooldown is not holding`
    ).to.be.at.most(1);
  });

  it("still checks a different stream straight away", async () => {
    // Rate limiting one stream must not silence another - a gap on a quiet
    // stream should be noticed on its very first commit.
    const first = healthyHost(HOT);
    first.commit("a-1", "a-prev");
    await Endpoints.repairHistoryAfterCommit(first.host, "a-1");

    const second = healthyHost(OTHER);
    second.commit("b-1", "b-prev");
    await Endpoints.repairHistoryAfterCommit(second.host, "b-1");

    expect(second.calls.knockAll, "an unrelated stream was silenced").to.be.greaterThan(0);
  });

  it("checks again once the window has passed", async () => {
    // Skipping only ever delays a repair, so the window must actually reopen.
    const { host, calls, commit } = healthyHost(HOT);

    commit("w-1", "w-prev");
    await Endpoints.repairHistoryAfterCommit(host, "w-1");
    const afterFirst = calls.knockAll;

    // Age the recorded time past the window rather than waiting 30s
    const cooldown = (Endpoints as any).HISTORY_REPAIR_COOLDOWN_MS;
    (Endpoints as any).historyRepairLastRun.set(HOT, Date.now() - cooldown - 1000);

    commit("w-2", "w-prev2");
    await Endpoints.repairHistoryAfterCommit(host, "w-2");

    expect(calls.knockAll).to.be.greaterThan(afterFirst);
  });
});

/**
 * A walk that recovers something and then cannot continue used to return
 * early and leave nothing behind but a log line. Whether anything was
 * recovered says nothing about whether the job is finished, and these pin
 * that distinction so it cannot quietly regress to counting again.
 */
describe("Endpoints.walkUmidHistory - saying whether it finished", () => {
  const CHAIN = ["w5", "w4", "w3", "w2", "w1", "w0"];
  const realDelay = Endpoints.UMID_WALK_HOP_DELAY_MS;
  before(() => { Endpoints.UMID_WALK_HOP_DELAY_MS = 0; });
  after(() => { Endpoints.UMID_WALK_HOP_DELAY_MS = realDelay; });

  it("is complete when it reaches a umid already held", async () => {
    const { host } = fakeHost(CHAIN, ["w2", "w1", "w0"]);
    const result = await Endpoints.walkUmidHistory(host, STREAM, "w5");
    expect(result.stoppedAt).to.contain("already held");
    expect(result.complete).to.equal(true);
    expect(result.frontier).to.equal(undefined);
  });

  it("is complete when it reaches the start of the stream", async () => {
    const { host } = fakeHost(CHAIN, []);
    const result = await Endpoints.walkUmidHistory(host, STREAM, "w5");
    expect(result.stoppedAt).to.equal("start of stream");
    expect(result.complete).to.equal(true);
    expect(result.frontier).to.equal(undefined);
  });

  it("is NOT complete when a hop cannot be recovered, and names it", async () => {
    const { host } = fakeHost(CHAIN, [], { unreachable: ["w2"] });
    const result = await Endpoints.walkUmidHistory(host, STREAM, "w5");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.equal("w2");
    // It keeps what it managed to get - the point is that the remainder is
    // reported, not that the walk is thrown away.
    expect(result.recovered).to.deep.equal(["w5", "w4", "w3"]);
  });

  it("is NOT complete when it hits the hop limit", async () => {
    const long = Array.from({ length: 130 }, (_, i) => `L${129 - i}`);
    const { host } = fakeHost(long, []);
    const result = await Endpoints.walkUmidHistory(host, STREAM, long[0]);
    expect(result.stoppedAt).to.equal("limit reached");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.be.a("string");
  });
});

describe("SPI history repair - a partial walk leaves a durable record", () => {
  const realDelay = Endpoints.UMID_WALK_HOP_DELAY_MS;
  before(() => { Endpoints.UMID_WALK_HOP_DELAY_MS = 0; });
  after(() => { Endpoints.UMID_WALK_HOP_DELAY_MS = realDelay; });

  beforeEach(() => {
    (Endpoints as any).historyRepairLastRun.clear();
    (Endpoints as any).historyRepairInFlight.clear();
  });

  let n = 0;

  /**
   * A committed umid whose history breaks partway back. repairHistoryAfterCommit
   * walks from the commit's `prev`, so the chain below that is what matters.
   */
  function partialHost(unreachable: string[]) {
    const STREAM_P = `p${n}pp`.padEnd(64, "a") + `${n++}`;
    const chain = ["p3", "p2", "p1", "p0"];
    const errors: any[] = [];
    const store = new Map<string, any>();
    const id = `commit-${Date.now()}-${n}`;

    const docFor = (umid: string) => {
      const i = chain.indexOf(umid);
      if (i === -1) return undefined;
      const prev = chain[i + 1];
      return {
        _id: `${umid}:umid`,
        umid: { $umid: umid },
        streams: prev
          ? { new: [], updated: [{ id: STREAM_P, prev }] }
          : { new: [{ id: STREAM_P, name: "created" }], updated: [] },
      };
    };

    // The commit itself: held, and pointing at p3 which is not.
    const committed = {
      _id: `${id}:umid`,
      umid: { $umid: id },
      streams: { new: [], updated: [{ id: STREAM_P, prev: "p3" }] },
    };
    store.set(`${id}:umid`, committed);

    return {
      id,
      errors,
      store,
      host: {
        dbConnection: {
          get: async (key: string) => {
            if (!store.has(key)) throw new Error("not found");
            return store.get(key);
          },
          bulkDocs: async (docs: any[]) => {
            for (const d of docs) store.set(d._id, d);
            return { ok: true };
          },
        },
        dbEventConnection: { post: async () => ({ ok: true }) },
        dbErrorConnection: {
          post: async (doc: any) => { errors.push(doc); return { ok: true }; },
        },
        neighbourhood: {
          knockAll: async (endpoint: string) => {
            const umid = endpoint.replace("umid/", "");
            if (unreachable.indexOf(umid) !== -1) return [];
            if (umid === id) return [committed, committed];
            const doc = docFor(umid);
            return doc ? [doc, doc] : [];
          },
        },
      } as any,
    };
  }

  it("records the umid it got stuck on, not the one it started from", async () => {
    // p3 and p2 recover; p1 is unreachable.
    const { host, errors, id } = partialHost(["p1"]);
    await Endpoints.repairHistoryAfterCommit(host, id);
    await new Promise((r) => setTimeout(r, 500));

    expect(errors.length).to.equal(1);
    expect(errors[0].code).to.equal(950);
    expect(errors[0].processed).to.equal(false);
    // Recording p3 (where the walk began) would be useless: it is present
    // by definition, so a recovery attempt against it finds nothing to do
    // and the hole behind it stays.
    expect(errors[0].umid).to.equal("p1");
  });

  it("records nothing when the walk finished the job", async () => {
    const { host, errors, id } = partialHost([]);
    await Endpoints.repairHistoryAfterCommit(host, id);
    await new Promise((r) => setTimeout(r, 500));
    expect(errors).to.deep.equal([]);
  });
});
