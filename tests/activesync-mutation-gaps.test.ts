import { expect } from "chai";
import "mocha";
import { spiConsensus, describeFork } from "../packages/activesync/src/spi";
import { backfillUmid, walkUmidHistory, SyncContext } from "../packages/activesync/src/umid";

/**
 * Behaviour the SPI and umid code promises, that a mutation pass found nothing
 * checking: each test here fails if the line it names is broken on purpose.
 */

const ID = "088067b4";
const at = (rev: string) => ({ _id: ID, _rev: rev });

describe("spiConsensus - one node's answer is read in full and counted once", () => {
  it("counts a stream listed twice in one node's answer as one vote", () => {
    // One node, the same stream twice. Needing 2 votes, a single node must not
    // be able to carry a revision on its own.
    const { winners } = spiConsensus([[at("2-aaaa"), at("2-aaaa")]], 2);
    expect(winners[ID]).to.equal(undefined);
  });

  it("does not stop reading a node's answer at an entry with no _id", () => {
    // Entries are read from the end, so the malformed one comes first
    const node = () => [at("2-aaaa"), {} as any];
    const { winners } = spiConsensus([node(), node()], 2);
    expect(winners[ID]?.rev).to.equal("2-aaaa");
  });

  it("does not stop reading a node's answer at an entry with no _rev", () => {
    const node = () => [at("2-aaaa"), { _id: "other-stream" }];
    const { winners } = spiConsensus([node(), node()], 2);
    expect(winners[ID]?.rev).to.equal("2-aaaa");
  });

  it("does not stop at a repeated entry either, so a later stream still votes", () => {
    const other = { _id: "other", _rev: "2-bbbb" };
    // read from the end: other, then the duplicate pair for ID
    const node = () => [at("2-aaaa"), at("2-aaaa"), other];
    const { winners } = spiConsensus([node(), node()], 2);
    expect(winners[ID]?.rev).to.equal("2-aaaa");
    expect(winners["other"]?.rev).to.equal("2-bbbb");
  });
});

describe("describeFork - how often it has been seen", () => {
  const fork = () => {
    const a = at("2-aaaa");
    const b = at("2-bbbb");
    return spiConsensus([[a], [a], [b], [b]], 2).forks[ID];
  };

  it("says how many times once it has been seen more than once", () => {
    expect(describeFork(ID, fork(), { seen: 2, firstSeen: "t0" })).to.contain("Seen 2 times since first logged at t0");
  });

  it("says nothing about repeats the first time", () => {
    expect(describeFork(ID, fork(), { seen: 1 })).to.not.contain("Seen ");
  });
});

// ---- umid adoption and the history walk ------------------------------------

const STREAM = "3f7a1c9e5b2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";
const docFor = (umid: string, prev?: string) => ({
  _id: `${umid}:umid`,
  umid: { $umid: umid },
  events: [],
  streams: prev ? { new: [], updated: [{ id: STREAM, prev }] } : { new: [{ id: STREAM }], updated: [] },
});

function sync(opts: {
  chain?: Record<string, string | undefined>; // umid -> prev, what the network holds
  held?: string[];
  getReturns?: (id: string, written: Set<string>) => any; // override store.get
  bulk?: (docs: any[], options: any, written: Set<string>) => any;
  peers?: (umid: string) => any[];
  continuePastHeld?: boolean;
}) {
  const written = new Set<string>(opts.held || []);
  const bulkCalls: Array<{ docs: any[]; options: any }> = [];
  const posted: string[] = [];
  const chain = opts.chain || {};
  const ctx: SyncContext = {
    store: {
      get: async (id: string) => {
        if (opts.getReturns) return opts.getReturns(id, written);
        if (!written.has(id)) throw new Error("not found");
        const u = id.replace(":umid", "");
        return docFor(u, chain[u]);
      },
      bulkDocs: async (docs: any[], options: any) => {
        bulkCalls.push({ docs, options });
        if (opts.bulk) return opts.bulk(docs, options, written);
        docs.forEach((d) => written.add(d._id));
        return { ok: true };
      },
    },
    events: { post: async (d: any) => (posted.push(d._id), {}) },
    peers: {
      umid: async (u: string) => (opts.peers ? opts.peers(u) : u in chain ? [docFor(u, chain[u]), docFor(u, chain[u])] : []),
    },
    hopDelayMs: 0,
    continuePastHeld: opts.continuePastHeld,
  };
  return { ctx, written, bulkCalls, posted };
}

describe("backfillUmid - what it refuses and how it writes", () => {
  it("refuses an empty umid without asking anyone", async () => {
    let asked = 0;
    const { ctx } = sync({ peers: () => (asked++, []) });
    expect(await backfillUmid(ctx, "")).to.equal(false);
    expect(asked).to.equal(0);
  });

  it("only ever adds a document: it writes with new_edits false", async () => {
    const { ctx, bulkCalls } = sync({ chain: { U1: undefined } });
    expect(await backfillUmid(ctx, "U1")).to.equal(true);
    expect(bulkCalls).to.have.length(1);
    expect(bulkCalls[0].options).to.deep.equal({ new_edits: false });
  });

  it("is false and writes nothing when no node can supply the umid", async () => {
    const { ctx, bulkCalls, posted } = sync({ chain: {} });
    expect(await backfillUmid(ctx, "U1")).to.equal(false);
    expect(bulkCalls).to.have.length(0);
    expect(posted).to.have.length(0);
  });

  it("is false when the network cannot be reached at all", async () => {
    const { ctx, bulkCalls } = sync({
      peers: () => {
        throw new Error("no route");
      },
    });
    expect(await backfillUmid(ctx, "U1")).to.equal(false);
    expect(bulkCalls).to.have.length(0);
  });

  it("is false, with no index row, when the write throws", async () => {
    const { ctx, posted } = sync({
      chain: { U1: undefined },
      bulk: () => {
        throw new Error("storage down");
      },
    });
    expect(await backfillUmid(ctx, "U1")).to.equal(false);
    expect(posted.filter((p) => p.startsWith("umid:"))).to.have.length(0);
  });

  it("does not treat a stored document with no _id as held", async () => {
    // A store answering {} for a umid it does not really have
    const { ctx, bulkCalls } = sync({
      chain: { U1: undefined },
      getReturns: (_id, written) => (written.has("U1:umid") ? docFor("U1") : {}),
    });
    expect(await backfillUmid(ctx, "U1")).to.equal(true);
    expect(bulkCalls, "it was fetched and written").to.have.length(1);
  });
});

describe("walkUmidHistory - saying when it did not finish", () => {
  it("reports a chain that loops as not complete", async () => {
    const { ctx } = sync({ chain: { U1: "U2", U2: "U1" } });
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.stoppedAt).to.equal("loop detected");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.equal("U1");
  });

  it("does not take a document with no _id for a held umid, so it still walks it", async () => {
    const { ctx } = sync({
      chain: { U1: undefined },
      getReturns: (id, written) => (written.has(id) ? docFor("U1") : {}),
    });
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.recovered).to.deep.equal(["U1"]);
    expect(result.stoppedAt).to.equal("start of stream");
    expect(result.complete).to.equal(true);
  });

  it("reports an adopted umid it cannot read back as not complete", async () => {
    // Written, but the store never gives it back
    const { ctx } = sync({
      chain: { U1: "U2", U2: undefined },
      getReturns: () => {
        throw new Error("not found");
      },
    });
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.stoppedAt).to.contain("could not be read back");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.equal("U1");
  });

  it("reports a held umid it cannot read as not complete", async () => {
    let reads = 0;
    const { ctx } = sync({
      held: ["U1:umid"],
      continuePastHeld: true,
      getReturns: () => {
        // the held check reads it once, the walk's own read then fails
        if (++reads === 1) return docFor("U1", "U2");
        throw new Error("gone");
      },
    });
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.stoppedAt).to.equal("held umid could not be read");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.equal("U1");
  });

  it("reports a umid nobody can supply as not complete, at that umid", async () => {
    const { ctx } = sync({ chain: { U1: "U2" } }); // the network knows U1 but not U2
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.recovered).to.deep.equal(["U1"]);
    expect(result.stoppedAt).to.equal("could not recover U2");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.equal("U2");
  });

  it("stops exactly at the walk limit and says it did not finish", async () => {
    const { ctx } = sync({ chain: { U1: "U2", U2: "U3", U3: "U4", U4: undefined } });
    ctx.walkLimit = 2;
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.recovered).to.deep.equal(["U1", "U2"]);
    expect(result.stoppedAt).to.equal("limit reached");
    expect(result.complete).to.equal(false);
    expect(result.frontier).to.equal("U3");
  });

  it("honours a walk limit of 0 rather than falling back to the default", async () => {
    const { ctx } = sync({ chain: { U1: undefined } });
    ctx.walkLimit = 0;
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.recovered).to.deep.equal([]);
    expect(result.stoppedAt).to.equal("limit reached");
  });

  it("finishes, completely, when it reaches a umid it already holds", async () => {
    const { ctx } = sync({ chain: { U1: "U2", U2: undefined }, held: ["U2:umid"] });
    const result = await walkUmidHistory(ctx, STREAM, "U1");
    expect(result.recovered).to.deep.equal(["U1"]);
    expect(result.stoppedAt).to.equal("reached a umid already held");
    expect(result.complete).to.equal(true);
  });
});
