import { expect } from "chai";
import "mocha";
import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";

// What the neighbours answer for one stream: each node's document, or an empty
// array from a node that does not hold it (this one, in a restore), or an error.
describe("QuickRestore.handleNetworkData - the answers for one stream (Activerestore)", () => {
  const handle = (answers: unknown[]) =>
    (QuickRestore as any).prototype.handleNetworkData.call({}, answers) as Promise<{ documents: any[]; contracts: any[] }>;

  it("takes the first usable answer and skips an empty one instead of failing the restore", async () => {
    const meta = { _id: "s1:stream", _rev: "1-a" };
    const { documents } = await handle([meta, [], undefined, null]);
    expect(documents).to.deep.equal([meta]);
    expect((await handle([[]])).documents).to.deep.equal([]);
  });

  it("skips an answer that is an error", async () => {
    const { documents } = await handle([{ _id: "s1:umid", _rev: "1-a" }, { _id: "s1:stream", error: "nope" }]);
    expect(documents.map((d: any) => d._id)).to.deep.equal(["s1:umid"]);
  });

  it("never asks for a volatile placeholder, the contract makes it again when it needs one", async () => {
    expect(await handle([{ _id: "s1", _rev: "1-a" }])).to.not.have.property("volatile");
  });

  it("returns contract streams for a later rebuild rather than rebuilding them as they arrive", async () => {
    const contract = { _id: "c1", namespace: "ns", contract: { "0.0.1": {} }, compiled: "x" };
    const result = await handle([contract]);
    expect(result.contracts).to.deep.equal([contract]);
    expect(result.documents).to.have.length(1);
  });
});

describe("Helper.majority - volatile (Activerestore)", () => {
  it("leaves volatile documents out of what is synced", () => {
    const { Helper } = require("../packages/restore/src/modules/helper/helper");
    const node = { reference: "n", streams: [{ id: "s1", rev: "1-a" }, { id: "s1:volatile", rev: "1-b" }] };
    const won = Helper.majority([node, node], 1).map((w: any) => w.stream);
    expect(won).to.deep.equal(["s1"]);
  });
});
