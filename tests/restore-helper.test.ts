import { Helper } from "../packages/restore/src/modules/helper/helper";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { expect } from "chai";
import "mocha";

describe("Restore Helper - replayEvents (Activerestore)", () => {
  let posted: any[];

  beforeEach(() => {
    posted = [];
    (Provider as any).eventDatabase = {
      post: async (doc: any) => {
        posted.push(doc);
        return doc;
      },
    };
  });

  it("should replay every event attached to a restored umid document", async () => {
    const umidDoc = {
      _id: "abc123:umid",
      umid: { $umid: "abc123" },
      events: [
        { _id: "event:1,abc123", name: "one", data: {} },
        { _id: "event:2,abc123", name: "two", data: {} },
      ],
    };

    await Helper.replayEvents(umidDoc);

    // Events replay concurrently (each has its own unique _id and no
    // ordering dependency on the others) - assert both were posted, not
    // a specific arrival order.
    expect(posted).to.have.length(2);
    expect(posted.map((p) => p._id).sort()).to.deep.equal([
      "event:1,abc123",
      "event:2,abc123",
    ]);
  });

  it("should do nothing when the umid document has no events", async () => {
    await Helper.replayEvents({ _id: "abc123:umid", umid: { $umid: "abc123" } });
    expect(posted).to.have.length(0);
  });

  it("should do nothing when events is not an array", async () => {
    await Helper.replayEvents({
      _id: "abc123:umid",
      umid: { $umid: "abc123" },
      events: "not-an-array",
    });
    expect(posted).to.have.length(0);
  });

  it("should not throw when an individual event fails to post, and should continue replaying the rest", async () => {
    (Provider as any).eventDatabase = {
      post: async (doc: any) => {
        posted.push(doc);
        if (doc._id === "event:2,abc123") {
          throw new Error("simulated write failure");
        }
        return doc;
      },
    };

    const umidDoc = {
      _id: "abc123:umid",
      umid: { $umid: "abc123" },
      events: [
        { _id: "event:1,abc123", name: "one", data: {} },
        { _id: "event:2,abc123", name: "two", data: {} },
      ],
    };

    await Helper.replayEvents(umidDoc);

    expect(posted).to.have.length(2);
  });

  it("should do nothing when the umid document itself is undefined", async () => {
    await Helper.replayEvents(undefined);
    expect(posted).to.have.length(0);
  });
});
