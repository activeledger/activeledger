import { expect } from "chai";
import "mocha";
import { ActiveCacheManager, ActiveOptions } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Home } from "../packages/network/src/network/home";

const E: any = Endpoints;

/**
 * Edges a mutation pass over the non-origin side of SPI (a node that took
 * part in a transaction it did not originate, found itself behind, and asks
 * the network for the winning documents).
 */
describe("Endpoints - non-origin SPI repair, edges the tests did not pin (Activenetwork)", function () {
  this.timeout(10000);
  const realRef = Home.reference;
  const realBackfill = E.backfillUmid;
  const realRepair = E.repairHistoryInBackground;
  const SPI = "Stream Position Incorrect";
  let n = 0;

  let hadConsensus = false;
  let heldConsensus: any;
  beforeEach(() => {
    const held: any = ActiveOptions.fetch(false);
    hadConsensus = "consensus" in held;
    heldConsensus = held.consensus;
    Home.reference = "me";
    ActiveOptions.set("consensus", { reached: 66 });
    E.backfillUmid = async () => true;
    E.repairHistoryInBackground = () => undefined;
  });
  afterEach(() => {
    Home.reference = realRef;
    const held: any = ActiveOptions.fetch(false);
    if (hadConsensus) held.consensus = heldConsensus;
    else delete held.consensus;
    E.backfillUmid = realBackfill;
    E.repairHistoryInBackground = realRepair;
  });

  /**
   * One transaction this node voted on and found itself behind for. `answers`
   * is what the other nodes say the streams are; `held` the revision this
   * node has.
   */
  const run = async (
    answers: (ids: { state: string; meta: string }) => any[],
    before?: (ids: { state: string; meta: string }) => void,
    read?: (id: string) => any
  ) => {
    const state = `${++n}`.padStart(64, "e");
    const ids = { state, meta: `${state}:stream` };
    before?.(ids);
    const umid = `umid-${n}`;
    const written: any[] = [];
    const posted: any[] = [];
    const host: any = {
      pending: async () => ({
        status: 200,
        data: {
          $umid: umid,
          $tx: { $contract: "c".repeat(64), $i: { [state]: {} }, $o: {} },
          $nodes: {
            me: { vote: false, commit: false, error: SPI },
            b: { vote: true, commit: true },
          },
        },
      }),
      release: () => undefined,
      neighbourhood: { count: () => 4, knockAll: async () => answers(ids) },
      dbConnection: {
        get: async (id: string) => (read ? read(id) : { _id: id, _rev: "1-stale" }),
        put: async () => ({ ok: true }),
        bulkDocs: async (docs: any[]) => (written.push(...docs), { ok: true }),
      },
      dbErrorConnection: { post: async (d: any) => posted.push(d) },
    };
    Endpoints.InternalInitalise(host, { $umid: umid, $tx: { $contract: "c".repeat(64), $i: { [state]: {} }, $o: {} } } as any, "9.9.9.9");
    await new Promise((r) => setTimeout(r, 900));
    return { written, posted, umid };
  };

  const win = (id: string) => ({ _id: id, _rev: "2-winner" });

  it("repairs when exactly as many nodes answer as consensus needs", async () => {
    const r = await run(({ state }) => [[win(state)], [win(state)]]);
    expect(r.written.map((d) => d._id)).to.have.length(1);
  });

  it("does nothing when fewer answer than consensus needs", async () => {
    const r = await run(({ state }) => [[win(state)]]);
    expect(r.written).to.deep.equal([]);
    expect(r.posted).to.deep.equal([]);
  });

  it("repairs every winning document, even when another one was already rewritten", async () => {
    for (const skip of ["state", "meta"] as const) {
      const r = await run(
        (ids) => [[win(ids.state), win(ids.meta)], [win(ids.state), win(ids.meta)]],
        (ids) => ActiveCacheManager.fetch("rewrote", 500).set(ids[skip], "2-winner", 5000)
      );
      const other = skip === "state" ? "meta" : "state";
      expect(r.written.map((d) => d._id.endsWith(":stream")), `skipping ${skip}`).to.deep.equal([other === "meta"]);
    }
  });

  it("leaves a 950 record that asks for the umid, as a broadcast, once it has repaired", async () => {
    const r = await run(({ state }) => [[win(state)], [win(state)]]);
    expect(r.posted).to.have.length(1);
    expect(r.posted[0].code).to.equal(950);
    expect(r.posted[0].umid).to.equal(r.umid);
    expect(r.posted[0].processed).to.equal(false);
    expect(r.posted[0].transaction.$broadcast).to.equal(true);
  });

  it("leaves a winning document alone, and carries on, when the data engine answered nothing", async () => {
    // the request helper resolves null when a call fails; that is not a missing document
    const r = await run(({ state }) => [[win(state)], [win(state)]], undefined, () => null);
    expect(r.written).to.deep.equal([]);
    // the umid is still asked for again, so the repair is retried
    expect(r.posted.map((d) => d.code)).to.deep.equal([950]);
  });
});
