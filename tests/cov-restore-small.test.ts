import { Helper } from "../packages/restore/src/modules/helper/helper";
import { Throttle, DEFAULT_THROTTLE } from "../packages/restore/src/modules/helper/throttle";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { Contract } from "../packages/restore/src/modules/contract/contract";
import { ActiveLogger } from "@activeledger/activelogger";
import { expect } from "chai";
import "mocha";

describe("Restore helper output (cov)", () => {
  let infos: any[];
  const orig = (ActiveLogger as any).info;
  const verbose = Helper.verbose;
  beforeEach(() => {
    infos = [];
    (ActiveLogger as any).info = (...a: any[]) => infos.push(a);
  });
  afterEach(() => {
    (ActiveLogger as any).info = orig;
    Helper.verbose = verbose;
  });

  it("is silent when not verbose", () => {
    Helper.verbose = false;
    Helper.output("hello", { a: 1 });
    expect(infos).to.deep.equal([]);
  });
  it("logs the message alone when verbose", () => {
    Helper.verbose = true;
    Helper.output("hello");
    expect(infos).to.deep.equal([["hello"]]);
  });
  it("logs the data first, then the message, when there is data", () => {
    Helper.verbose = true;
    Helper.output("hello", { a: 1 });
    expect(infos).to.deep.equal([[{ a: 1 }, "hello"]]);
  });
});

describe("Restore helper consensus arithmetic (cov)", () => {
  const saved = { n: Provider.neighbourCount, c: Provider.consensusReachedAmount };
  afterEach(() => {
    Provider.neighbourCount = saved.n;
    Provider.consensusReachedAmount = saved.c;
  });

  it("neighbour count can leave this node out", () => {
    Provider.neighbourCount = 5;
    expect(Helper.getNeighbourCount(true)).to.equal(4);
    expect(Helper.getNeighbourCount(false)).to.equal(5);
  });
  it("metConsensus compares the percentage with the configured one, inclusive", () => {
    Provider.neighbourCount = 5;
    Provider.consensusReachedAmount = 60;
    expect(Helper.metConsensus(3)).to.equal(true);
    expect(Helper.metConsensus(2)).to.equal(false);
    // 4 others: 3 votes = 75%, 2 votes = 50%
    expect(Helper.metConsensus(3, true)).to.equal(true);
    expect(Helper.metConsensus(2, true)).to.equal(false);
  });
  it("votesNeeded is the consensus share of nodes less this one, rounded up", () => {
    Provider.neighbourCount = 4;
    Provider.consensusReachedAmount = 50;
    expect(Helper.votesNeeded()).to.equal(1);
    Provider.neighbourCount = 10;
    Provider.consensusReachedAmount = 66;
    expect(Helper.votesNeeded()).to.equal(6); // ceil(6.6 - 1)
    Provider.consensusReachedAmount = 100;
    expect(Helper.votesNeeded()).to.equal(9);
  });
  it("votesNeeded is at least 1", () => {
    Provider.neighbourCount = 2;
    Provider.consensusReachedAmount = 10;
    expect(Helper.votesNeeded()).to.equal(1);
  });
  it("votesNeeded is Infinity with no neighbours or no consensus setting", () => {
    Provider.neighbourCount = 0;
    Provider.consensusReachedAmount = 50;
    expect(Helper.votesNeeded()).to.equal(Infinity);
    Provider.neighbourCount = 4;
    Provider.consensusReachedAmount = undefined as any;
    expect(Helper.votesNeeded()).to.equal(Infinity);
  });
  it("majority never syncs volatile documents", () => {
    const n = (r: string) => ({ reference: r, streams: [{ id: "s:volatile", rev: "1-a" }, { id: "s", rev: "1-a" }] });
    expect(Helper.majority([n("a"), n("b")], 2)).to.deep.equal([{ stream: "s", revision: "1-a" }]);
  });
});

describe("Restore replayEvents (cov)", () => {
  const saved = (Provider as any).eventDatabase;
  const orig = (ActiveLogger as any).error;
  afterEach(() => {
    (Provider as any).eventDatabase = saved;
    (ActiveLogger as any).error = orig;
  });
  it("does nothing without events", async () => {
    let n = 0;
    (Provider as any).eventDatabase = { post: async () => n++ };
    await Helper.replayEvents(undefined);
    await Helper.replayEvents({});
    await Helper.replayEvents({ events: "x" });
    await Helper.replayEvents({ events: [] });
    expect(n).to.equal(0);
  });
  it("posts each event and carries on past one that fails", async () => {
    const posted: any[] = [];
    const errs: any[] = [];
    (ActiveLogger as any).error = (...a: any[]) => errs.push(a);
    (Provider as any).eventDatabase = {
      post: async (e: any) => {
        if (e._id === "bad") throw new Error("boom");
        posted.push(e);
      },
    };
    await Helper.replayEvents({ umid: { $umid: "U" }, events: [{ _id: "a" }, { _id: "bad" }, { _id: "c" }] });
    expect(posted.map((e) => e._id).sort()).to.deep.equal(["a", "c"]);
    expect(errs.length).to.equal(1);
    expect(errs[0][1]).to.contain("bad").and.to.contain("U");
  });
  it("names the document id when the umid is absent", async () => {
    const errs: any[] = [];
    (ActiveLogger as any).error = (...a: any[]) => errs.push(a);
    (Provider as any).eventDatabase = { post: async () => { throw new Error("x"); } };
    await Helper.replayEvents({ _id: "doc1", events: [{ _id: "e" }] });
    expect(errs[0][1]).to.contain("doc1");
  });
});

describe("Restore Throttle (cov)", () => {
  const mk = (cfg: any, fast = false) => {
    const slept: number[] = [];
    const t = Throttle.fromConfig(cfg, fast, async (ms) => {
      slept.push(ms);
    });
    return { t, slept };
  };
  it("a fast or disabled throttle never waits and never backs off", async () => {
    for (const [cfg, fast] of [[{}, true], [{ throttle: false }, false]] as any) {
      const { t, slept } = mk(cfg, fast);
      await t.wait();
      t.record(1e9);
      expect(slept).to.deep.equal([]);
      expect(t.backingOff).to.equal(0);
    }
  });
  it("ignores unusable settings and uses defaults", async () => {
    const { t } = mk({ throttle: { pauseMs: -1, batch: 0, slowMs: "x" } });
    expect((t as any).options).to.deep.equal({ ...DEFAULT_THROTTLE, batch: 1 });
  });
  it("uses the real timer by default", async () => {
    const t = new Throttle({ pauseMs: 20, batch: 100, batchPauseMs: 0, slowMs: 1, maxBackoffMs: 1 });
    const start = Date.now();
    await t.wait();
    expect(Date.now() - start).to.be.at.least(15);
  });
  it("pauses between streams, longer on each batch, and backs off when slow", async () => {
    const { t, slept } = mk({
      throttle: { pauseMs: 10, batch: 2, batchPauseMs: 100, slowMs: 50, maxBackoffMs: 300 },
    });
    await t.wait();
    await t.wait();
    expect(slept).to.deep.equal([10, 110]);
    t.record(60);
    expect(t.backingOff).to.equal(50);
    t.record(60);
    expect(t.backingOff).to.equal(100);
    for (let i = 0; i < 5; i++) t.record(60);
    expect(t.backingOff).to.equal(300);
    t.record(10);
    expect(t.backingOff).to.equal(150);
    await t.wait();
    expect(slept[2]).to.equal(160);
  });
  it("does not sleep when the wait would be zero", async () => {
    const { t, slept } = mk({ throttle: { pauseMs: 0, batch: 1000, batchPauseMs: 0 } });
    await t.wait();
    expect(slept).to.deep.equal([]);
  });
});

import { ProviderDataTypes } from "../packages/restore/src/modules/provider/provider.enum";
describe("Restore ProviderDataTypes (cov)", () => {
  it("numbers its members in declaration order", () => {
    expect(ProviderDataTypes.IsSelfHost).to.equal(0);
    expect(ProviderDataTypes.Database).to.equal(7);
    expect(ProviderDataTypes[3]).to.equal("Network");
  });
});
