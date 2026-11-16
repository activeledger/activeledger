import { expect } from "chai";
import "mocha";
import { HybridApi } from "../packages/network/src/network/hybridApi";

/**
 * Edges a mutation pass over HybridApi.feedSince found nothing checking: how
 * many items one call returns, how long the feed waits for a commit's
 * attestation before stepping past it, and how far one call scans.
 */
class Mem {
  docs = new Map<string, any>();
  calls = 0;
  put(d: any) {
    this.docs.set(d._id, d);
    return this;
  }
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? { ...d } : { notFound: true };
  }
  async allDocs(o: any) {
    this.calls++;
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()].sort().filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    return { rows: keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k })) };
  }
}

describe("HybridApi.feedSince - edges the tests did not pin (Activenetwork)", () => {
  let clock: number;
  const setup = (over: any = {}) => {
    const db = new Mem();
    const events = new Mem();
    clock = 10_000_000;
    const api = new HybridApi({
      db: db as any,
      events: events as any,
      registry: { lookup: async () => undefined, list: async () => [] },
      ledgerConfig: () => ({}),
      setupStreamId: () => "setup",
      banned: () => new Set(),
      now: () => clock,
      attestGraceSeconds: 100,
      ...over,
    });
    /** A commit with everything a feed item needs */
    const ready = (ms: number, umid: string) => {
      events.put({ _id: `umid:${ms},${umid}` });
      db.put({ _id: `${umid}:umid`, umid: { $umid: umid, $revs: {} }, streams: {} });
      events.put({ _id: `attest:${umid}`, node: "n", umid, outcome: "committed", revsOut: {}, umidDocHash: "d", sig: "s", nodes: {} });
    };
    /** A feed key whose documents never came */
    const dead = (ms: number, umid: string) => events.put({ _id: `umid:${ms},${umid}` });
    return { api, db, events, ready, dead };
  };

  it("returns every ready item of a page, in order, and stops at the limit", async () => {
    const { api, ready } = setup();
    for (const [i, u] of ["a", "b", "c"].entries()) ready(1000 + i, u);
    expect((await api.feedSince("", 10)).map((x) => x.item.umid)).to.deep.equal(["a", "b", "c"]);
    expect((await api.feedSince("", 2)).map((x) => x.item.umid)).to.deep.equal(["a", "b"]);
  });

  describe("a commit whose attestation has not arrived", () => {
    it("is waited for until its grace has passed, to the millisecond, and then stepped past", async () => {
      const { api, ready, dead } = setup();
      const ms = clock - 100_000;
      dead(ms, "late");
      ready(ms + 1, "next");
      // Exactly at the grace: still waited for
      expect(await api.feedSince("", 10)).to.deep.equal([]);
      clock += 1;
      expect((await api.feedSince("", 10)).map((x) => x.item.umid)).to.deep.equal(["next"]);
    });

    it("is waited for when it is recent, whatever follows it", async () => {
      const { api, ready, dead } = setup();
      dead(clock - 10, "recent");
      ready(clock - 5, "next");
      expect(await api.feedSince("", 10)).to.deep.equal([]);
    });

    it("is stepped past at once when no grace is allowed", async () => {
      const { api, ready, dead } = setup({ attestGraceSeconds: 0 });
      dead(clock - 10, "recent");
      ready(clock - 5, "next");
      expect((await api.feedSince("", 10)).map((x) => x.item.umid)).to.deep.equal(["next"]);
    });
  });

  it("scans 20 pages of keys that will never have an item and then gives up for this call", async () => {
    const { api, events, dead, ready } = setup();
    for (let i = 0; i < 25; i++) dead(1000 + i, `d${String(i).padStart(2, "0")}`);
    ready(5000, "live");
    events.calls = 0;
    expect(await api.feedSince("", 1)).to.deep.equal([]);
    // Each page asks for the umid and fail keys
    expect(events.calls).to.equal(40);
    // The next call carries on from where this one got to and finds the item
    expect((await api.feedSince("", 1)).map((x) => x.item.umid)).to.deep.equal(["live"]);
  });
});
