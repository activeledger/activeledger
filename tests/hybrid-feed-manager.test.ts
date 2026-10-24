import { expect } from "chai";
import "mocha";
import { FeedManager, atOrPast, cursorKey } from "../packages/hybrid/src/feed";
import { UpstreamError } from "../packages/hybrid/src/http-upstream";
import { NodeState } from "../packages/hybrid/src/types";

const state = (): NodeState => ({
  version: "5.1.0",
  ready: false,
  cursor: "",
  headConfirmedAt: 0,
  upstreams: [],
});

/** An upstream whose feed plays a script: items, heartbeats, then ends or throws */
const fake = (id: string, plays: ((ctx: { onItem: any; onBeat: any; signal: AbortSignal; cursor: string }) => Promise<void>)[]) => {
  const calls: string[] = [];
  return {
    id,
    calls,
    feed: async (cursor: string, onItem: any, signal: AbortSignal, onBeat: any) => {
      calls.push(cursor);
      const play = plays.shift();
      if (!play) return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await play({ onItem, onBeat, signal, cursor });
    },
  } as any;
};

const item = (n: number) => ({ cursor: `umid:${n},u${n}`, item: { umid: `u${n}` } as any });
const outcome = (umid: string): any => ({ umid, action: "saved", vote: "yes", warnings: [], reasons: [] });
// Must yield to the event loop, or a retry loop starves the timers the tests wait on
const noSleep = () => new Promise<void>((r) => setImmediate(r));

describe("cursor helpers", () => {
  it("compares committed and failed cursors by their shared key", () => {
    expect(cursorKey("fail:5,u")).to.equal("5,u");
    expect(atOrPast("umid:5,u", "fail:5,u")).to.equal(true);
    expect(atOrPast("umid:4,u", "umid:5,u")).to.equal(false);
    expect(atOrPast("", "")).to.equal(true);
    expect(atOrPast("", "umid:1,a")).to.equal(false);
    expect(atOrPast("umid:1,a", "")).to.equal(true);
  });
});

describe("FeedManager", () => {
  const make = (upstreams: any[], over: any = {}) => {
    const st = state();
    const applied: string[] = [];
    const saved: string[] = [];
    const m = new FeedManager({
      upstreams,
      state: st,
      apply: async (it) => (applied.push(it.umid), outcome(it.umid)),
      saveCursor: async (c) => void saved.push(c),
      sleep: noSleep,
      ...over,
    });
    return { m, st, applied, saved };
  };

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("applies items in order, saves each cursor and advances the state", async () => {
    const up = fake("a", [async ({ onItem }) => { for (const i of [item(1), item(2)]) await onItem(i.cursor, i.item); }]);
    const { m, st, applied, saved } = make([up]);
    m.start("");
    await until(() => applied.length === 2);
    await m.stop();
    expect(applied).to.deep.equal(["u1", "u2"]);
    expect(saved).to.deep.equal(["umid:1,u1", "umid:2,u2"]);
    expect(st.cursor).to.equal("umid:2,u2");
  });

  it("resumes from its cursor after the upstream ends the stream", async () => {
    const up = fake("a", [async ({ onItem }) => { await onItem("umid:1,u1", { umid: "u1" }); }, async () => undefined]);
    const { m, applied } = make([up]);
    m.start("");
    await until(() => up.calls.length >= 2);
    await m.stop();
    expect(applied).to.deep.equal(["u1"]);
    expect(up.calls.slice(0, 2)).to.deep.equal(["", "umid:1,u1"]);
  });

  it("fails over to the next upstream and marks the broken one", async () => {
    const bad = fake("bad", [async () => { throw new UpstreamError("down", "network"); }]);
    const good = fake("good", [async ({ onItem, onBeat }) => { onBeat("umid:1,u1", 1); await onItem("umid:1,u1", { umid: "u1" }); }]);
    const { m, st, applied } = make([bad, good]);
    m.start("");
    await until(() => applied.length === 1);
    await m.stop();
    expect(applied).to.deep.equal(["u1"]);
    expect(st.upstreams.find((u) => u.host === "bad")?.ok).to.equal(false);
    expect(st.upstreams.find((u) => u.host === "good")?.ok).to.equal(true);
  });

  it("backs off between rounds when nothing works, doubling to the cap", async () => {
    const waits: number[] = [];
    const up = fake("a", Array.from({ length: 6 }, () => async () => { throw new UpstreamError("down", "network"); }));
    const { m } = make([up], { backoffMs: { min: 10, max: 40 }, sleep: async (ms: number) => { waits.push(ms); await new Promise((r) => setTimeout(r, 1)); } });
    m.start("");
    await until(() => waits.length >= 5);
    await m.stop();
    expect(waits.slice(0, 5)).to.deep.equal([20, 40, 40, 40, 40]);
  });

  it("confirms the head only when it has applied everything up to it", async () => {
    let now = 1000;
    const up = fake("a", [async ({ onItem, onBeat }) => {
      onBeat("umid:2,u2", 1);
      expect(st.headConfirmedAt).to.equal(0);
      await onItem("umid:1,u1", { umid: "u1" });
      expect(st.headConfirmedAt).to.equal(0);
      now = 2000;
      await onItem("umid:2,u2", { umid: "u2" });
      expect(st.headConfirmedAt).to.equal(2000);
      now = 3000;
      onBeat("umid:2,u2", 2);
    }]);
    const { m, st } = make([up], { now: () => now });
    m.start("");
    await until(() => st.headConfirmedAt === 3000);
    await m.stop();
    expect(st.headConfirmedAt).to.equal(3000);
  });

  it("a quiet empty ledger reads as at the head", async () => {
    const up = fake("a", [async ({ onBeat }) => onBeat("", 1)]);
    const { m, st } = make([up], { now: () => 5000 });
    m.start("");
    await until(() => st.headConfirmedAt === 5000);
    await m.stop();
    expect(st.headConfirmedAt).to.equal(5000);
  });

  it("applies nothing while outdated, and resumes when upgraded", async () => {
    const up = fake("a", [async ({ onItem }) => { await onItem("umid:1,u1", { umid: "u1" }); }]);
    const { m, st, applied } = make([up]);
    st.reason = "outdated";
    m.start("");
    await new Promise((r) => setTimeout(r, 30));
    expect(up.calls).to.have.length(0);
    expect(applied).to.deep.equal([]);
    st.reason = undefined;
    await until(() => applied.length === 1);
    await m.stop();
    expect(applied).to.deep.equal(["u1"]);
  });

  it("does not skip an item whose apply throws: the cursor stays and it is retried", async () => {
    let fail = true;
    const up = fake("a", [
      async ({ onItem }) => { await onItem("umid:1,u1", { umid: "u1" }); },
      async ({ onItem, cursor }) => { expect(cursor).to.equal(""); await onItem("umid:1,u1", { umid: "u1" }); },
    ]);
    const applied: string[] = [];
    const { m, st } = make([up], {
      apply: async (it: any) => { if (fail) { fail = false; throw new Error("boom"); } applied.push(it.umid); return outcome(it.umid); },
    });
    m.start("");
    await until(() => applied.length === 1);
    await m.stop();
    expect(applied).to.deep.equal(["u1"]);
    expect(st.cursor).to.equal("umid:1,u1");
  });

  it("stop() ends the loop and does not apply further items", async () => {
    const up = fake("a", []);
    const { m, applied } = make([up]);
    m.start("");
    await until(() => up.calls.length === 1);
    await m.stop();
    expect(applied).to.deep.equal([]);
  });
});
