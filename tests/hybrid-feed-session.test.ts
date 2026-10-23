import { expect } from "chai";
import "mocha";
import { FeedSession } from "../packages/network/src/network/hybridRoutes";

const fakeApi = (batches: { cursor: string; item: any }[][], head = "umid:1,a") => {
  const calls: string[] = [];
  return {
    calls,
    feedSince: async (cursor: string) => {
      calls.push(cursor);
      return batches.shift() ?? [];
    },
    head: async () => head,
  } as any;
};

const item = (n: number) => ({ cursor: `umid:${n},u${n}`, item: { umid: `u${n}`, n } });

describe("FeedSession", () => {
  it("starts with a heartbeat, then sends items with their cursor as the id", async () => {
    const out: string[] = [];
    const s = new FeedSession(fakeApi([[item(1), item(2)]]), (c) => (out.push(c), true), "", 1000, 10_000);
    await s.start();
    await s.tick();
    s.stop();
    expect(out[0]).to.match(/^event: heartbeat\ndata: {"head":"umid:1,a","time":\d+}\n\n$/);
    expect(out[1]).to.equal(`id: umid:1,u1\ndata: ${JSON.stringify({ umid: "u1", n: 1 })}\n\n`);
    expect(out[2]).to.contain("id: umid:2,u2");
    expect(s.cursor).to.equal("umid:2,u2");
  });

  it("asks for items after the last one it sent", async () => {
    const api = fakeApi([[item(1)], []]);
    const s = new FeedSession(api, () => true, "umid:0,u0", 1000, 10_000);
    await s.tick();
    await s.tick();
    expect(api.calls).to.deep.equal(["umid:0,u0", "umid:1,u1"]);
  });

  it("drains full pages before waiting", async () => {
    const full = Array.from({ length: 50 }, (_, i) => item(i + 1));
    const api = fakeApi([full, [item(51)]]);
    const out: string[] = [];
    const s = new FeedSession(api, (c) => (out.push(c), true), "", 1000, 10_000);
    await s.tick();
    expect(out.filter((c) => c.startsWith("id:"))).to.have.length(51);
  });

  it("sends another heartbeat once one is due", async () => {
    let now = 0;
    const out: string[] = [];
    const s = new FeedSession(fakeApi([]), (c) => (out.push(c), true), "", 1000, 10_000, () => now);
    await s.start();
    now = 5_000;
    await s.tick();
    expect(out.filter((c) => c.startsWith("event: heartbeat"))).to.have.length(1);
    now = 10_001;
    await s.tick();
    s.stop();
    expect(out.filter((c) => c.startsWith("event: heartbeat"))).to.have.length(2);
  });

  it("stops when the client has gone", async () => {
    const api = fakeApi([[item(1), item(2)], [item(3)]]);
    const s = new FeedSession(api, () => false, "", 1000, 10_000);
    await s.tick();
    await s.tick();
    expect(s.cursor).to.equal("");
    expect(api.calls).to.have.length(2);
  });

  it("reports an error to the client and stops when the feed throws", async () => {
    const out: string[] = [];
    const api = { feedSince: async () => { throw new Error("db down"); }, head: async () => "" } as any;
    const s = new FeedSession(api, (c) => (out.push(c), true), "", 1000, 10_000);
    await s.tick();
    expect(out.join("")).to.contain("event: error");
  });

  it("ends the session when the key is no longer allowed, checked at each heartbeat", async () => {
    let now = 0;
    let allowed = true;
    const out: string[] = [];
    let stops = 0;
    const s = new FeedSession(fakeApi([]), (c) => (out.push(c), true), "", 1000, 10_000, () => now, async () => allowed, () => stops++);
    await s.start();
    expect(stops).to.equal(0);
    allowed = false;
    now = 10_001;
    await s.tick();
    expect(out.join("")).to.contain("not authorised");
    expect(stops).to.equal(1);
  });

  it("calls onStop once however it ends", async () => {
    let stops = 0;
    const s = new FeedSession(fakeApi([[item(1)]]), () => false, "", 1000, 10_000, Date.now, async () => true, () => stops++);
    await s.tick();
    s.stop();
    s.stop();
    expect(stops).to.equal(1);
  });
});
