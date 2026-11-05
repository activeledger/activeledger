import { expect } from "chai";
import "mocha";
import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { Helper } from "../packages/restore/src/modules/helper/helper";

// A stopped restore skips what it already holds when it is run again, so the
// umid document must be written last: it is what says the transaction is done.
describe("QuickRestore.uploadData - a stopped restore can carry on (Activerestore)", () => {
  it("replays a umid's events before writing the umid document", async () => {
    const order: string[] = [];
    const database = Provider.database;
    const replay = Helper.replayEvents;
    (Provider as any).database = {
      get: async () => { throw new Error("missing"); },
      bulkDocs: async (docs: any[]) => (order.push(`write ${docs[0]._id}`), { ok: true }),
    };
    (Helper as any).replayEvents = async (doc: any) => void order.push(`events ${doc._id}`);
    try {
      await (QuickRestore as any).prototype.uploadData.call({}, { documents: [{ _id: "u1:umid", _rev: "1-a", events: [{ _id: "e" }] }] });
    } finally {
      (Provider as any).database = database;
      (Helper as any).replayEvents = replay;
    }
    expect(order).to.deep.equal(["events u1:umid", "write u1:umid"]);
  });
});

// The store reports a failed write as {ok:false} or {} instead of throwing.
describe("QuickRestore.uploadData - an unconfirmed write is a failure (Activerestore)", () => {
  for (const [name, answer] of [["{ok:false}", { ok: false }], ["{}", {}]] as const) {
    for (const present of [false, true]) {
      it(`rejects when bulkDocs answers ${name} for a ${present ? "diverged" : "missing"} document`, async () => {
        const database = Provider.database;
        (Provider as any).database = {
          get: async () => {
            if (present) return { _id: "s", _rev: "1-old" };
            throw new Error("missing");
          },
          bulkDocs: async () => answer,
        };
        let err: any;
        try {
          await (QuickRestore as any).prototype.uploadData.call({}, { documents: [{ _id: "s", _rev: "2-new" }] });
        } catch (e) {
          err = e;
        } finally {
          (Provider as any).database = database;
        }
        expect(err, "uploadData must reject").to.be.an("error");
        expect(err.message).to.contain("s");
      });
    }
  }
});
