import { expect } from "chai";
import "mocha";
import { reportedUpdatedStreams } from "../packages/network/src/network/updatedstreams";

describe("reportedUpdatedStreams", () => {
  it("lists the updated stream ids a node reported", () => {
    expect(reportedUpdatedStreams({ streams: { new: [], updated: [{ id: "a", prev: "p" }, { id: "b" }] } })).to.deep.equal(["a", "b"]);
  });

  it("says none when the node reported that it updated none", () => {
    expect(reportedUpdatedStreams({ streams: { new: [{ id: "n" }], updated: [] } })).to.deep.equal([]);
  });

  it("does not say none when the response has no streams and no commit: that is unknown", () => {
    expect(reportedUpdatedStreams({ vote: true, commit: false })).to.equal(undefined);
    expect(reportedUpdatedStreams({ vote: true })).to.equal(undefined);
    expect(reportedUpdatedStreams(undefined)).to.equal(undefined);
    expect(reportedUpdatedStreams({ streams: {} })).to.equal(undefined);
  });

  it("says none for a commit that completed without ever writing streams (a contract that writes nothing)", () => {
    expect(reportedUpdatedStreams({ vote: true, commit: true, return: { via: "x" } })).to.deep.equal([]);
  });
});
