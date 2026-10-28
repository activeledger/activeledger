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
      bulkDocs: async (docs: any[]) => void order.push(`write ${docs[0]._id}`),
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
