import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";
import { Helper } from "../packages/restore/src/modules/helper/helper";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { LevelMe } from "../packages/storage/src/levelme";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Restore, exercised against a real store rather than a mock.
 *
 * What restore can and cannot do is easy to get wrong, and getting it
 * wrong is expensive in both directions. It CAN put back a document this
 * node lost entirely, and the umid of the transaction that produced it,
 * and replay the events that transaction raised - a node that never ran
 * the commit itself never saw those events, so without the replay its
 * event feed has a permanent hole where a real transaction should be.
 *
 * It also has to leave alone anything it should not touch. A restore that
 * quietly rewrote a healthy document would be far worse than one that did
 * nothing, and adoptDocument picks its write mode per document precisely
 * because the two cases need different ones - new_edits:false can only
 * ADD, and throws "Revision Mismatch" the moment it meets a divergent
 * local copy.
 */
describe("Restore recovers what a node lost (Activerestore)", () => {
  let tmpDir: string;
  let db: LevelMe;
  let events: any[];

  // adoptDocument is private; this is the unit under test regardless, and
  // reaching it directly avoids standing up the whole QuickRestore run.
  const adopt = (doc: any) => (QuickRestore as any).adoptDocument(doc);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-restore-test-"));
    db = new LevelMe(tmpDir + path.sep, "activeledger", "level");
    await db.open();

    events = [];
    (Provider as any).database = db;
    (Provider as any).eventDatabase = {
      post: async (doc: any) => {
        events.push(doc);
        return doc;
      },
    };
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const networkCopy = async (id: string) => {
    const doc: any = await db.get(id);
    return { ...doc };
  };

  describe("a document this node lost", () => {
    it("comes back at the network's revision, not a fresh one", async () => {
      // The revision has to survive the round trip. A restored document
      // that came back at 1-<something-new> would disagree with every
      // other node and be a divergence rather than a repair.
      await db.bulkDocs([{ _id: "streamA", value: "original" }], { new_edits: true });
      const fromNetwork = await networkCopy("streamA");

      await db.del("streamA");
      let gone = false;
      try {
        gone = !(await db.get("streamA"))?.value;
      } catch {
        gone = true;
      }
      expect(gone, "precondition: the document must actually be gone").to.equal(true);

      await adopt(fromNetwork);

      const restored: any = await db.get("streamA");
      expect(restored.value).to.equal("original");
      expect(restored._rev).to.equal(fromNetwork._rev);
    });

    it("comes back with its content intact, not just its id", async () => {
      await db.bulkDocs(
        [{ _id: "streamB", nested: { a: [1, 2, 3] }, flag: false, text: "ünïcødé" }],
        { new_edits: true }
      );
      const fromNetwork = await networkCopy("streamB");
      await db.del("streamB");

      await adopt(fromNetwork);

      const restored: any = await db.get("streamB");
      expect(restored.nested.a).to.deep.equal([1, 2, 3]);
      expect(restored.flag).to.equal(false);
      expect(restored.text).to.equal("ünïcødé");
    });

    it("restores a stream and its :stream meta as a matching pair", async () => {
      // Losing one and restoring the other would leave
      // meta._rev:state._rev mismatched, which SPI cannot repair.
      await db.bulkDocs(
        [
          { _id: "streamC", value: "state" },
          { _id: "streamC:stream", value: "meta" },
        ],
        { new_edits: true }
      );
      const state = await networkCopy("streamC");
      const meta = await networkCopy("streamC:stream");

      await db.del("streamC");
      await db.del("streamC:stream");

      await adopt(state);
      await adopt(meta);

      expect((await db.get("streamC"))._rev).to.equal(state._rev);
      expect((await db.get("streamC:stream"))._rev).to.equal(meta._rev);
    });
  });

  describe("what it must not touch", () => {
    it("leaves a document that already agrees exactly as it was", async () => {
      await db.bulkDocs([{ _id: "healthy", value: "same" }], { new_edits: true });
      const before: any = await db.get("healthy");

      await adopt({ ...before });

      const after: any = await db.get("healthy");
      expect(after._rev).to.equal(before._rev);
      expect(after.value).to.equal("same");
    });

    it("repairs a divergent copy rather than failing on it", async () => {
      // new_edits:false alone throws Revision Mismatch here, which is why
      // a node holding a present-but-stale copy was never repaired by a
      // full restore - it logged and moved on.
      await db.bulkDocs([{ _id: "stale", value: "old" }], { new_edits: true });
      await db.bulkDocs([{ _id: "stale", value: "newer" }], { new_edits: true });
      const network = await networkCopy("stale");

      // Roll the local copy back so it is present but behind
      await db.bulkDocs([{ _id: "stale", value: "old" }], {
        new_edits: true,
        force_rev: "1-0000000000000000000000000000aaaa",
      });
      expect((await db.get("stale"))._rev).to.equal("1-0000000000000000000000000000aaaa");

      await adopt(network);

      const repaired: any = await db.get("stale");
      expect(repaired._rev).to.equal(network._rev);
      expect(repaired.value).to.equal("newer");
    });
  });

  describe("the umid, and the events it raised", () => {
    const umidDoc = {
      _id: "tx-abc:umid",
      _rev: "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      umid: { $umid: "tx-abc", $datetime: "2026-01-01T00:00:00.000Z" },
      events: [
        { _id: "event:1,tx-abc", name: "Transfer", data: { amount: 5 } },
        { _id: "event:2,tx-abc", name: "Settled", data: { ok: true } },
      ],
    };

    it("restores the umid document that changed the stream", async () => {
      await adopt({ ...umidDoc });

      const stored: any = await db.get("tx-abc:umid");
      expect(stored.umid.$umid).to.equal("tx-abc");
      expect(stored._rev).to.equal(umidDoc._rev);
    });

    it("replays every event that umid carried", async () => {
      // This node never ran the transaction's commit(), so its event
      // database would otherwise never see these at all.
      await Helper.replayEvents(umidDoc);

      expect(events).to.have.length(2);
      expect(events.map((e) => e.name).sort()).to.deep.equal(["Settled", "Transfer"]);
    });

    it("replays them under their original ids, so a second restore is idempotent", async () => {
      // The id embeds the umid and a per-transaction counter. Reusing it
      // means a subscriber tracking Last-Event-ID sees the same identity a
      // node that ran the transaction itself would have produced.
      await Helper.replayEvents(umidDoc);
      await Helper.replayEvents(umidDoc);

      const ids = events.map((e) => e._id);
      expect(new Set(ids).size).to.equal(2);
      expect(ids.sort()).to.deep.equal([
        "event:1,tx-abc",
        "event:1,tx-abc",
        "event:2,tx-abc",
        "event:2,tx-abc",
      ]);
    });

    it("carries the event payload through unchanged", async () => {
      await Helper.replayEvents(umidDoc);

      const transfer = events.find((e) => e.name === "Transfer");
      expect(transfer.data).to.deep.equal({ amount: 5 });
    });

    it("does not fail the restore when one event cannot be written", async () => {
      // One bad event must not cost the others, or the umid itself.
      let attempts = 0;
      (Provider as any).eventDatabase = {
        post: async (doc: any) => {
          attempts++;
          if (doc._id === "event:1,tx-abc") throw new Error("event store full");
          events.push(doc);
          return doc;
        },
      };

      await Helper.replayEvents(umidDoc);

      expect(attempts).to.equal(2);
      expect(events.map((e) => e._id)).to.deep.equal(["event:2,tx-abc"]);
    });

    it("does nothing for a umid that raised no events", async () => {
      await Helper.replayEvents({ _id: "quiet:umid", umid: { $umid: "quiet" } });
      expect(events).to.have.length(0);
    });
  });

  describe("the whole loss, end to end", () => {
    it("puts back the stream, its meta, the umid, and the events together", async () => {
      // The shape of a real recovery: a node that missed one transaction
      // entirely is missing all four, and a repair that restores only the
      // stream leaves its history and its event feed wrong.
      await db.bulkDocs(
        [
          { _id: "sX", balance: 100 },
          { _id: "sX:stream", umid: "tx-xyz" },
        ],
        { new_edits: true }
      );
      const state = await networkCopy("sX");
      const meta = await networkCopy("sX:stream");
      const umid = {
        _id: "tx-xyz:umid",
        _rev: "1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        umid: { $umid: "tx-xyz" },
        events: [{ _id: "event:1,tx-xyz", name: "BalanceSet", data: { balance: 100 } }],
      };

      await db.del("sX");
      await db.del("sX:stream");

      for (const doc of [state, meta, umid]) {
        await adopt(doc);
        if (doc._id.indexOf(":umid") !== -1) await Helper.replayEvents(doc);
      }

      expect((await db.get("sX")).balance).to.equal(100);
      expect((await db.get("sX"))._rev).to.equal(state._rev);
      expect((await db.get("sX:stream"))._rev).to.equal(meta._rev);
      expect((await db.get("tx-xyz:umid")).umid.$umid).to.equal("tx-xyz");
      expect(events.map((e) => e.name)).to.deep.equal(["BalanceSet"]);
    });
  });
});
