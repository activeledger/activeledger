import { Endpoints } from "../packages/network/src/network/endpoints";
import { expect } from "chai";
import "mocha";

// Regression coverage for the hpe-19 fix: Endpoints.shouldTriggerSpiLookup()
// used to be inline boolean logic in InternalInitalise() that decided
// whether the origin node should run the expensive SPI recovery lookup.
// With a small errors.length (1 or 2 - common when not every node's
// response has come back yet) Math.floor(length / 3) is 0, so
// "spiErrorCount >= 0" was trivially true for ANY error type, not just a
// real "Stream Position Incorrect" one - sending totally unrelated
// terminal errors (e.g. a real "Deterministic Stream Name Exists"
// collision, see [[project_hpe18_deterministic_stream_bug]]) through the
// lookup for an outcome already known, wasting real wall-clock time for
// nothing.
describe("Endpoints.shouldTriggerSpiLookup (Activenetwork) - hpe-19", () => {
  it("does not trigger for a single unrelated error (previously a false positive)", () => {
    expect(
      Endpoints.shouldTriggerSpiLookup(["Deterministic Stream Name Exists"])
    ).to.equal(false);
  });

  it("does not trigger for two unrelated errors (previously a false positive)", () => {
    expect(
      Endpoints.shouldTriggerSpiLookup([
        "Deterministic Stream Name Exists",
        "Deterministic Stream Name Exists",
      ])
    ).to.equal(false);
  });

  it("does not trigger when all nodes agree on the same unrelated error", () => {
    expect(
      Endpoints.shouldTriggerSpiLookup([
        "Deterministic Stream Name Exists",
        "Deterministic Stream Name Exists",
        "Deterministic Stream Name Exists",
        "Deterministic Stream Name Exists",
      ])
    ).to.equal(false);
  });

  it("triggers when a genuine Stream Position Incorrect error meets the majority threshold", () => {
    expect(
      Endpoints.shouldTriggerSpiLookup([
        "Stream Position Incorrect",
        "Stream Position Incorrect",
        "Stream Position Incorrect",
      ])
    ).to.equal(true);
  });

  it("does not trigger when only a minority of many errors are Stream Position Incorrect", () => {
    expect(
      Endpoints.shouldTriggerSpiLookup([
        "Stream Position Incorrect",
        "Some Other Error",
        "Some Other Error",
        "Some Other Error",
        "Some Other Error",
        "Some Other Error",
      ])
    ).to.equal(false);
  });

  it("triggers when this node's own error is Stream Position Incorrect, regardless of the others", () => {
    expect(
      Endpoints.shouldTriggerSpiLookup(
        ["Deterministic Stream Name Exists"],
        "Stream Position Incorrect"
      )
    ).to.equal(true);
  });

  it("does not trigger with no errors at all", () => {
    expect(Endpoints.shouldTriggerSpiLookup(undefined)).to.equal(false);
  });
});
