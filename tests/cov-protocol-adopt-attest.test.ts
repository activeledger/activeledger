import { checkAdopt } from "../packages/protocol/src/protocol/adopt";
import { Attestation } from "../packages/protocol/src/protocol/attest";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";

describe("checkAdopt declared-shape reasons (cov)", () => {
  const W = "a".repeat(64);
  const local = (extra: any = {}) => ({ _id: W, _rev: "2-l", owner: "alice", meta: { n: 1 }, status: "p", ...extra });
  const signed = (extra: any = {}) => ({ ...local(), _rev: "3-s", ...extra });
  const run = (shape: any, signedDoc: any, atomic = false) =>
    checkAdopt({
      umid: "u",
      signed: { [W]: signedDoc },
      local: { [W]: local() },
      declarations: [{ streams: [W], shape, atomic, candidates: false } as any],
      supernodeDependent: true,
    });

  it("reports a declared type nobody defined", () => {
    const v = run({ status: "bogus" }, signed({ status: "s" }));
    expect(v.ok).to.equal(false);
    expect(v.reasons).to.deep.equal([`${W}.status: unknown declared type "bogus"`]);
  });

  it("reports a declared nested object that is missing from the signed document", () => {
    const { meta, ...withoutMeta } = signed();
    const v = run({ meta: { n: "number" } }, withoutMeta);
    expect(v.ok).to.equal(false);
    expect(v.reasons).to.include(`${W}.meta: declared property is missing`);
  });

  it("reports a declared nested object that is not an object", () => {
    const v = run({ meta: { n: "number" } }, signed({ meta: 5 }));
    expect(v.reasons).to.include(`${W}.meta: is not object`);
  });

  it("reports a missing required property, but lets an optional one be absent", () => {
    const { status, ...noStatus } = signed();
    expect(run({ status: "string" }, noStatus).reasons).to.include(`${W}.status: declared property is missing`);
    expect(run({ status: "string?" }, noStatus).reasons).to.deep.equal([]);
  });

  it("reports a declared property of the wrong type", () => {
    const v = run({ status: "number" }, signed({ status: "s" }));
    expect(v.reasons).to.include(`${W}.status: is not number`);
  });

  it("checks nested declared properties and counts them for atomic declarations", () => {
    const shape = { meta: { n: "number" }, status: "string" };
    const both = run(shape, signed({ meta: { n: 2 }, status: "q" }), true);
    expect(both.ok).to.equal(true);
    const oneOnly = run(shape, signed({ meta: { n: 2 } }), true);
    expect(oneOnly.ok).to.equal(false);
    expect(oneOnly.reasons).to.deep.equal([
      `${W}: atomic declaration changed 1 of 2 properties (meta.n)`,
    ]);
  });
});

