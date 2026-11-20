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

  it("copies the contract's data to plain JSON when it is emitted, so no toJSON or getter runs later", () => {
    const s = sink();
    const calls: string[] = [];
    const e = new EventEngine(s.db, "c", "u1", 1, (id) => calls.push(id));
    const data = {
      kept: 1,
      get later() { calls.push("getter"); return calls.length; },
      toJSON() { calls.push("toJSON"); return { kept: 1 }; },
    };
    e.emit("x", data);
    const afterEmit = calls.length;
    // What was stored is plain: reading or serialising it runs nothing more
    JSON.stringify(e.getEvents());
    JSON.stringify(s.posted);
    expect(calls.length).to.equal(afterEmit);
    expect(e.getEvents()[0].data).to.deep.equal({ kept: 1 });
    expect(Object.getOwnPropertyDescriptor(s.posted[0].data, "kept")?.value).to.equal(1);
  });

  it("drops an event whose data cannot be serialised, and says so, instead of writing it", () => {
    const s = sink();
    const failed: string[] = [];
    const e = new EventEngine(s.db, "c", "u1", 1, (id) => failed.push(id));
    const loop: any = {};
    loop.self = loop;
    e.emit("x", loop);
    expect(s.posted).to.have.length(0);
    expect(e.getEvents()).to.have.length(0);
    expect(failed).to.have.length(1);
  });
});
