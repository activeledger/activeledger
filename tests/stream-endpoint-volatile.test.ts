import { expect } from "chai";
import "mocha";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * POST /a/stream refuses ":volatile" ids. The check reads inside a string, so
 * an id sent as an array slipped past it and the storage connector then turned
 * the array into the document id. Anything that is not a string is refused.
 */
describe("/a/stream and volatile data", () => {
  let asked: any[];
  const db: any = {
    get: async (id: any) => (asked.push(["get", id]), { _id: String(id), _rev: "1-x", secret: true }),
    allDocs: async (o: any) => (asked.push(["allDocs", o]), { rows: [] }),
  };
  const call = (body: any) =>
    (Endpoints as any).streams(db, body).then(
      (r: any) => ({ ok: true, r }),
      (e: any) => ({ ok: false, status: e?.statusCode })
    );

  beforeEach(() => {
    asked = [];
  });

  it("refuses a volatile id as a string", async () => {
    expect(await call({ $stream: "abc:volatile", $rev: "1-x" })).to.deep.include({ ok: false, status: 403 });
    expect(await call({ $streams: ["abc:volatile"] })).to.deep.include({ ok: false, status: 403 });
    expect(asked).to.have.length(0);
  });

  it("refuses an id sent as an array, and never asks the database", async () => {
    expect(await call({ $stream: ["abc:volatile"], $rev: "1-x" })).to.deep.include({ ok: false, status: 400 });
    expect(await call({ $streams: [["abc:volatile"]] })).to.deep.include({ ok: false, status: 400 });
    expect(await call({ $streams: "abc:volatile" })).to.deep.include({ ok: false, status: 400 });
    expect(asked).to.have.length(0);
  });

  it("refuses an id or revision that is an object or a number", async () => {
    expect(await call({ $stream: { a: 1 }, $rev: "1-x" })).to.deep.include({ ok: false, status: 400 });
    expect(await call({ $stream: "abc", $rev: ["1-x"] })).to.deep.include({ ok: false, status: 400 });
    expect(await call({ $streams: [1] })).to.deep.include({ ok: false, status: 400 });
    expect(asked).to.have.length(0);
  });

  it("still answers an ordinary request", async () => {
    const one = await call({ $stream: "abc", $rev: "1-x" });
    expect(one.ok).to.equal(true);
    expect(one.r.content._id).to.equal("abc");
    const many = await call({ $streams: ["abc", "abc:stream"] });
    expect(many.ok).to.equal(true);
  });
});
