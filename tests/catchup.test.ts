import { expect } from "chai";
import "mocha";
import { Catchup, CatchupDeps, CatchupOptions } from "../packages/network/src/network/catchup";

/**
 * The catch-up with fake neighbours: a node that missed commits adopts the tip
 * of each stream once, and only when a majority agrees, it is behind, and the
 * stream is not held by a transaction.
 */
describe("Catchup (a node finds the commits it missed)", () => {
  const options: CatchupOptions = { margin: 1000, cap: 50, pageSize: 3, concurrency: 2 };

  /** The network's index (what the one neighbour lists) and the streams it holds */
  let index: { umid: string; at: number }[];
  let networkDocs: { [id: string]: any };
  let umidStreams: { [umid: string]: string[] };
  let held: Set<string>;
  let local: { [id: string]: any };
  let rewrites: any[];
  let history: string[];
  let locked: Set<string>;
  let asked: { from: number; limit: number }[];
  let nodes: number; // neighbours answering the stream request
  let answerList: boolean;
  let failWrite: boolean;

  const deps = (): CatchupDeps => ({
    umidsSince: async (from, limit) => {
      asked.push({ from, limit });
      if (!answerList) return null;
      const rows = index.filter((r) => r.at >= from).sort((a, b) => a.at - b.at);
      return {
        rows: rows.slice(0, limit).map((r) => ({ umid: r.umid, timestamp: String(r.at) })),
        more: rows.length > limit,
      };
    },
    holds: async (umid) => held.has(umid),
    adopt: async (umid) => {
      if (!umidStreams[umid]) return null;
      held.add(umid);
      return umidStreams[umid];
    },
    networkStreams: async (ids) =>
      Array.from({ length: nodes }, () => ids.map((id) => networkDocs[id]).filter(Boolean).map((d) => ({ ...d }))),
    consensusNeeded: () => 2,
    local: async (id) => local[id],
    rewrite: async (doc) => {
      if (failWrite) return false;
      rewrites.push(doc);
      local[doc._id] = doc;
      return true;
    },
    lock: (streams) => {
      if (streams.some((s) => locked.has(s))) return false;
      return true;
    },
    unlock: () => undefined,
    repairHistory: async (id) => void history.push(id),
    sleep: async () => undefined,
  });

  const stream = (id: string, rev: string) => {
    networkDocs[id] = { _id: id, _rev: rev };
    networkDocs[`${id}:stream`] = { _id: `${id}:stream`, _rev: rev };
  };

  beforeEach(() => {
    index = [];
    networkDocs = {};
    umidStreams = {};
    held = new Set();
    local = {};
    rewrites = [];
    history = [];
    locked = new Set();
    asked = [];
    nodes = 3;
    answerList = true;
    failWrite = false;
  });

  const missed = (umid: string, at: number, streams: string[]) => {
    index.push({ umid, at });
    umidStreams[umid] = streams;
  };

  it("adopts a stream once however many commits it missed on it", async () => {
    stream("s1", "4-aaa");
    local["s1"] = { _id: "s1", _rev: "1-old" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "1-old" };
    missed("u2", 10000, ["s1"]);
    missed("u3", 10100, ["s1"]);
    missed("u4", 10200, ["s1"]);

    const result = (await new Catchup(deps(), options).run(10000))!;

    expect(result.missing).to.equal(3);
    expect(result.streams).to.equal(1);
    expect(result.rewritten).to.equal(1);
    expect(rewrites.map((d) => d._id)).to.deep.equal(["s1", "s1:stream"]);
    expect(history).to.deep.equal(["s1"]);
    expect(result.settled).to.equal(true);
  });

  it("looks from the start point less the margin, and pages through the index", async () => {
    for (let i = 0; i < 7; i++) missed(`u${i}`, 20000 + i, [`s${i}`]);
    for (let i = 0; i < 7; i++) {
      stream(`s${i}`, "2-x");
      local[`s${i}`] = { _id: `s${i}`, _rev: "1-y" };
      local[`s${i}:stream`] = { _id: `s${i}:stream`, _rev: "1-y" };
    }
    const result = (await new Catchup(deps(), options).run(20000))!;
    expect(asked[0].from).to.equal(19000);
    expect(asked.length).to.be.greaterThan(2);
    expect(result.scanned).to.equal(7);
    expect(result.rewritten).to.equal(7);
  });

  it("skips umids it already holds, and does nothing when it is in sync", async () => {
    stream("s1", "2-x");
    local["s1"] = { _id: "s1", _rev: "2-x" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "2-x" };
    missed("u1", 10000, ["s1"]);
    held.add("u1");
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(result.missing).to.equal(0);
    expect(rewrites).to.have.length(0);
    expect(result.settled).to.equal(true);
  });

  it("leaves a stream that is already at the network's revision alone", async () => {
    stream("s1", "3-x");
    local["s1"] = { _id: "s1", _rev: "3-x" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "3-x" };
    missed("u1", 10000, ["s1"]);
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(result.current).to.equal(1);
    expect(rewrites).to.have.length(0);
    expect(history).to.have.length(0);
  });

  it("never moves a stream backwards", async () => {
    stream("s1", "2-x");
    local["s1"] = { _id: "s1", _rev: "5-z" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "5-z" };
    missed("u1", 10000, ["s1"]);
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(rewrites).to.have.length(0);
    expect(result.current).to.equal(1);
  });

  it("leaves a different revision at the same position alone, as a fork", async () => {
    stream("s1", "3-x");
    local["s1"] = { _id: "s1", _rev: "3-other" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "3-other" };
    missed("u1", 10000, ["s1"]);
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(result.forks).to.equal(1);
    expect(rewrites).to.have.length(0);
  });

  it("adopts a stream this node does not have at all", async () => {
    stream("s1", "1-x");
    missed("u1", 10000, ["s1"]);
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(rewrites.map((d) => d._id)).to.deep.equal(["s1", "s1:stream"]);
    expect(result.rewritten).to.equal(1);
  });

  it("does not decide on too few answers, and says it is not settled", async () => {
    nodes = 1; // 2 needed
    stream("s1", "4-x");
    local["s1"] = { _id: "s1", _rev: "1-old" };
    missed("u1", 10000, ["s1"]);
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(rewrites).to.have.length(0);
    expect(result.undecided).to.equal(1);
    expect(result.settled).to.equal(false);
  });

  it("leaves a stream a transaction holds for the next run", async () => {
    stream("s1", "4-x");
    local["s1"] = { _id: "s1", _rev: "1-old" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "1-old" };
    missed("u1", 10000, ["s1"]);
    locked.add("s1");
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(rewrites).to.have.length(0);
    expect(result.settled).to.equal(false);
    // the next run, when it is free
    locked.clear();
    held.delete("u1");
    const again = (await new Catchup(deps(), options).run(10000))!;
    expect(again.rewritten).to.equal(1);
    expect(again.settled).to.equal(true);
  });

  it("does not settle when a write fails, and a second run finishes it", async () => {
    stream("s1", "4-x");
    local["s1"] = { _id: "s1", _rev: "1-old" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "1-old" };
    missed("u1", 10000, ["s1"]);
    failWrite = true;
    const first = (await new Catchup(deps(), options).run(10000))!;
    expect(first.settled).to.equal(false);
    failWrite = false;
    held.delete("u1");
    const second = (await new Catchup(deps(), options).run(10000))!;
    expect(second.settled).to.equal(true);
    expect(local["s1"]._rev).to.equal("4-x");
  });

  it("does not settle when a umid could not be fetched", async () => {
    index.push({ umid: "ghost", at: 10000 });
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(result.missing).to.equal(1);
    expect(result.settled).to.equal(false);
  });

  it("stops at the cap and says so, without settling", async () => {
    for (let i = 0; i < 10; i++) {
      missed(`u${i}`, 10000 + i, [`s${i}`]);
      stream(`s${i}`, "2-x");
    }
    const result = (await new Catchup(deps(), { ...options, cap: 4 })).run(10000);
    const r = (await result)!;
    expect(r.capped).to.equal(true);
    expect(r.missing).to.equal(4);
    expect(r.settled).to.equal(false);
  });

  it("does nothing when no neighbour can list its umids", async () => {
    answerList = false;
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(result.unavailable).to.equal(true);
    expect(result.settled).to.equal(false);
    expect(rewrites).to.have.length(0);
  });

  it("repairs several streams, a few at a time", async () => {
    for (let i = 0; i < 6; i++) {
      missed(`u${i}`, 10000 + i, [`s${i}`]);
      stream(`s${i}`, "2-x");
    }
    const result = (await new Catchup(deps(), options).run(10000))!;
    expect(result.rewritten).to.equal(6);
    expect(history.sort()).to.deep.equal(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("never runs beside itself", async () => {
    missed("u1", 10000, ["s1"]);
    stream("s1", "2-x");
    const c = new Catchup(deps(), options);
    const first = c.run(10000);
    expect(c.busy).to.equal(true);
    expect(await c.run(10000)).to.equal(null);
    await first;
    expect(c.busy).to.equal(false);
  });

  it("a second run straight after does nothing more", async () => {
    stream("s1", "4-x");
    local["s1"] = { _id: "s1", _rev: "1-old" };
    local["s1:stream"] = { _id: "s1:stream", _rev: "1-old" };
    missed("u1", 10000, ["s1"]);
    const c = new Catchup(deps(), options);
    await c.run(10000);
    const n = rewrites.length;
    const again = (await c.run(10000))!;
    expect(rewrites.length).to.equal(n);
    expect(again.missing).to.equal(0);
    expect(again.settled).to.equal(true);
  });
});
