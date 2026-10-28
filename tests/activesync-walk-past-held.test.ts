import { expect } from "chai";
import "mocha";
import { walkUmidHistory, SyncContext } from "../packages/activesync/src/umid";

// A full restore has to find a gap in the middle of a chain, so it walks
// through the umids it already holds instead of stopping at the first one.
describe("walkUmidHistory - continuePastHeld (Activesync)", () => {
  const S = "s".repeat(64);
  const doc = (id: string, prev?: string) => ({
    _id: `${id}:umid`,
    umid: { $umid: id },
    streams: { updated: [{ id: S, prev }] },
  });
  // U3 -> U2 -> U1; this node holds U3 and U1 but not U2
  const make = (extra: Partial<SyncContext> = {}) => {
    const held = new Map<string, any>([["U3:umid", doc("U3", "U2")], ["U1:umid", doc("U1")]]);
    const asked: string[] = [];
    const ctx: SyncContext = {
      store: {
        get: async (id: string) => {
          if (!held.has(id)) throw new Error("missing");
          return held.get(id);
        },
        bulkDocs: async (docs: any[]) => (docs.forEach((d) => held.set(d._id, d)), { ok: true }),
      },
      events: { post: async () => ({}) },
      peers: {
        umid: async (umid: string) => {
          asked.push(umid);
          return [{ ...doc("U2", "U1") }];
        },
      },
      hopDelayMs: 0,
      ...extra,
    };
    return { ctx, held, asked };
  };

  it("by default stops at the first umid it holds", async () => {
    const { ctx, asked } = make();
    const walk = await walkUmidHistory(ctx, S, "U3");
    expect(walk.recovered).to.deep.equal([]);
    expect(walk.stoppedAt).to.equal("reached a umid already held");
    expect(asked).to.deep.equal([]);
  });

  it("with continuePastHeld it finds and fetches the one missing from the middle", async () => {
    const { ctx, held, asked } = make({ continuePastHeld: true });
    const walk = await walkUmidHistory(ctx, S, "U3");
    expect(walk.recovered).to.deep.equal(["U2"]);
    expect(walk.complete).to.equal(true);
    expect(asked).to.deep.equal(["U2"]);
    expect(held.has("U2:umid")).to.equal(true);
  });

  it("reads held umids without asking the network about them", async () => {
    const { ctx, asked } = make({ continuePastHeld: true });
    ctx.store.get = (async (id: string) => ({ ...doc(id.replace(":umid", ""), id === "U3:umid" ? "U1" : undefined) })) as any;
    const walk = await walkUmidHistory(ctx, S, "U3");
    expect(walk.recovered).to.deep.equal([]);
    expect(walk.stoppedAt).to.equal("start of stream");
    expect(asked).to.deep.equal([]);
  });
});
