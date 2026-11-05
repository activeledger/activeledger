import { expect } from "chai";
import "mocha";
import { changedNodes, nodeSignature } from "../packages/network/src/network/nodedelta";

describe("nodedelta (what a worker has not been told yet)", () => {
  const early = { vote: false, commit: false, early: true };
  const voted = { vote: true, commit: false };
  const committed = { vote: true, commit: true, streams: { new: [], updated: [{ id: "s", prev: "p1" }] }, return: { v: 1 }, datetime: "2026-01-01T00:00:00.000Z" };

  it("passes everything the first time", () => {
    const sent = {};
    expect(changedNodes({ a: early, b: early }, sent)).to.deep.equal({ a: early, b: early });
  });

  it("passes nothing for an exact repeat", () => {
    const sent = {};
    changedNodes({ a: voted, b: voted }, sent);
    expect(changedNodes({ a: { ...voted }, b: { ...voted } }, sent)).to.equal(undefined);
  });

  it("passes only the responses that changed", () => {
    const sent = {};
    changedNodes({ a: early, b: voted }, sent);
    expect(changedNodes({ a: voted, b: { ...voted } }, sent)).to.deep.equal({ a: voted });
  });

  it("tells a placeholder, a vote and a commit apart", () => {
    const s = [early, voted, committed].map(nodeSignature);
    expect(new Set(s).size).to.equal(3);
  });

  it("sees a change anywhere in the commit data, even at the same length", () => {
    const sent = {};
    changedNodes({ a: committed }, sent);
    expect(changedNodes({ a: { ...committed, streams: { new: [], updated: [{ id: "s", prev: "p2" }] } } }, sent)).to.not.equal(undefined);
    expect(changedNodes({ a: { ...committed, return: { v: 2 } } }, sent)).to.not.equal(undefined);
    expect(changedNodes({ a: { ...committed, post: { x: 1 } } }, sent)).to.not.equal(undefined);
  });

  it("sees a vote turn into an error", () => {
    const sent = {};
    changedNodes({ a: voted }, sent);
    expect(changedNodes({ a: { vote: false, commit: false, error: "nope" } }, sent)).to.not.equal(undefined);
  });

  it("keeps separate memory per transaction (a fresh record starts empty)", () => {
    const one = {};
    const two = {};
    changedNodes({ a: voted }, one);
    expect(changedNodes({ a: voted }, two)).to.deep.equal({ a: voted });
  });
});
