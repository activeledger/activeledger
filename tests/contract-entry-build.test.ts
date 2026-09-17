import { expect } from "chai";
import "mocha";
import Contract from "../packages/activeledger/src/contracts/default/contract";

// The hash written into a contract stream has to be identical on every
// node that runs the same transaction, forever. Hashing the transpiled
// output instead of the source would make it depend on whichever
// TypeScript version a node happens to ship - two honest nodes would
// write different state for the same deploy, which is a divergence.
//
// It also has to survive base64 re-encoding. The same source encoded with
// and without line breaks is the same contract and must hash the same.
describe("Contract source hashing (Activeledger default contract)", () => {
  const source = "export default class Example {}\n";
  const base64 = Buffer.from(source).toString("base64");

  // A private static; reaching it directly is the unit under test and
  // avoids constructing a whole VM-backed contract to check a digest.
  const hash = (b64: string) => (Contract as any).hashContractSource(b64);

  it("hashes the decoded source, not the base64 envelope", () => {
    const crypto = require("crypto");
    const expected = crypto.createHash("sha256").update(source).digest("hex");
    expect(hash(base64)).to.equal(expected);
  });

  it("is stable across base64 line-break variants", () => {
    const wrapped = base64.replace(/(.{8})/g, "$1\n");
    expect(hash(wrapped)).to.equal(hash(base64));
  });

  it("produces a 64 character hex digest", () => {
    expect(hash(base64)).to.match(/^[0-9a-f]{64}$/);
  });

  it("gives different sources different hashes", () => {
    const other = Buffer.from("export default class Other {}\n").toString("base64");
    expect(hash(other)).to.not.equal(hash(base64));
  });
});
