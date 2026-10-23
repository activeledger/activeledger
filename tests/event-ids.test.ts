import { expect } from "chai";
import "mocha";
import { EventEngine } from "../packages/query/src";

describe("EventEngine ids", () => {
  const sink = () => {
    const posted: any[] = [];
    return { posted, db: { post: async (d: any) => (posted.push(d), {}) } };
  };

  it("uses the consensus stamp when given, so every node writes the same ids", () => {
    const a = sink();
    const b = sink();
    const ea = new EventEngine(a.db, "c", "u1", 5000);
    const eb = new EventEngine(b.db, "c", "u1", 5000);
    for (const e of [ea, eb]) {
      e.emit("x", { n: 1 });
      e.emit("y", { n: 2 });
    }
    expect(ea.getEvents().map((e) => e._id)).to.deep.equal(["event:5000-1,u1", "event:5000-2,u1"]);
    expect(ea.getEvents()).to.deep.equal(eb.getEvents());
  });

  it("stamps from the local clock without one", () => {
    const e = new EventEngine(sink().db, "c", "u1");
    e.emit("x", 1);
    expect(e.getEvents()[0]._id).to.match(/^event:\d{13}-1,u1$/);
  });
});
