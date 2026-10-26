import { expect } from "chai";
import "mocha";
import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";

// What the neighbours answer for one stream: each node's document, or an empty
// array from a node that does not hold it (this one, in a restore), or an error.
describe("QuickRestore.handleNetworkData - the answers for one stream (Activerestore)", () => {
  const handle = (answers: unknown[]) =>
    (QuickRestore as any).prototype.handleNetworkData.call({}, answers) as Promise<{ documents: any[]; volatile: any[] }>;

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

  it("asks for a volatile placeholder for a state document only", async () => {
    expect((await handle([{ _id: "s1", _rev: "1-a" }])).volatile).to.deep.equal([{ _id: "s1:volatile" }]);
    expect((await handle([{ _id: "s1:stream", _rev: "1-a" }])).volatile).to.deep.equal([]);
  });
});
