import { expect } from "chai";
import "mocha";
import { isContractRef } from "../packages/definitions/src/definitions/document";

// A contract stream holds three shapes at once during migration:
//
//   "base64..."          legacy source, on a stream not updated since the
//                        upgrade - the entry IS the source
//   {umid, hash}         deployed after the upgrade - fetch and verify
//   {hash}               deployed before the upgrade, normalised by a later
//                        update - identity kept, bytes not recoverable
//
// Every consumer has to tell them apart the same way, so the discriminator
// lives here rather than being re-derived as an inline typeof in each one.
describe("Contract version entry shape (Activedefinitions)", () => {
  it("treats a base64 string as legacy", () => {
    expect(isContractRef("ZXhwb3J0IGRlZmF1bHQgY2xhc3Mge30=")).to.equal(false);
  });

  it("recognises a full umid reference", () => {
    expect(isContractRef({ umid: "a".repeat(64), hash: "b".repeat(64) })).to.equal(true);
  });

  // The historical seam. hash alone is a valid entry - it names a version
  // and proves its identity, it just cannot reproduce it.
  it("recognises a hash-only reference", () => {
    expect(isContractRef({ hash: "b".repeat(64) })).to.equal(true);
  });

  // hash is what every other shape check depends on, so an object without
  // one is malformed rather than merely historical.
  it("rejects an object with no hash", () => {
    expect(isContractRef({ umid: "a".repeat(64) })).to.equal(false);
    expect(isContractRef({})).to.equal(false);
  });

  it("rejects null, undefined and arrays", () => {
    expect(isContractRef(null)).to.equal(false);
    expect(isContractRef(undefined)).to.equal(false);
    expect(isContractRef([])).to.equal(false);
  });

  it("rejects non-string field types", () => {
    expect(isContractRef({ hash: 1 })).to.equal(false);
    expect(isContractRef({ hash: "b".repeat(64), umid: 1 })).to.equal(false);
  });
});
