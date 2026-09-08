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

// A node that misses one committed update to a stream is left permanently
// one revision behind it, and votes "Stream Position Incorrect" on every
// later transaction touching that stream. The SPI path in
// InternalInitalise() is what is meant to pull it back onto the network's
// revision; shouldSelfRepairPosition() is the gate on that.
//
// The gate used to read `error?.indexOf("Stream Position Incorrect") !== -1`
// per node, which is TRUE for a node reporting no error at all (undefined
// !== -1). Every healthy node was counted as disagreeing, and a healthy
// local node set the "it is me that is out of date" flag - so the decision
// no longer depended on what any node actually reported. Motivating case:
// the Varnir.CryptoTransfer / node3 divergence.
describe("Endpoints.shouldSelfRepairPosition (Activenetwork)", () => {
  const HOME = "node3";

  it("repairs when this node reported the position error", () => {
    expect(
      Endpoints.shouldSelfRepairPosition(
        {
          node1: { vote: true },
          node2: { vote: true },
          node3: { vote: false, error: "Output Stream Position Incorrect (a !== b - Local)" },
        },
        HOME,
        true,
        false
      )
    ).to.equal(true);
  });

  it("repairs when another node committed, so there is newer state to adopt", () => {
    expect(
      Endpoints.shouldSelfRepairPosition(
        {
          node1: { vote: true, commit: true },
          node3: { vote: false, error: "Something Else" },
        },
        HOME,
        true,
        false
      )
    ).to.equal(true);
  });

  it("does not repair when no node errored and no node committed", () => {
    // Previously true: undefined?.indexOf(...) !== -1 counted every clean
    // node, including this one, as position-incorrect
    expect(
      Endpoints.shouldSelfRepairPosition(
        { node1: { vote: true }, node2: { vote: true }, node3: { vote: true } },
        HOME,
        true,
        false
      )
    ).to.equal(false);
  });

  it("does not repair when only other nodes are out of position", () => {
    // Being the only node that is right is not a reason to overwrite
    // local state with someone else's
    expect(
      Endpoints.shouldSelfRepairPosition(
        {
          node1: { error: "Input Stream Position Incorrect (a !== b - Local)" },
          node2: { error: "Input Stream Position Incorrect (a !== b - Local)" },
          node3: { vote: true },
        },
        HOME,
        true,
        false
      )
    ).to.equal(false);
  });

  it("ignores a non-position error reported by this node", () => {
    expect(
      Endpoints.shouldSelfRepairPosition(
        { node3: { error: "Deterministic Stream Name Exists" } },
        HOME,
        true,
        false
      )
    ).to.equal(false);
  });

  it("falls back to the 404 flag when the error was not a position error", () => {
    expect(
      Endpoints.shouldSelfRepairPosition({ node3: {} }, HOME, false, true)
    ).to.equal(true);
    expect(
      Endpoints.shouldSelfRepairPosition({ node3: {} }, HOME, false, false)
    ).to.equal(false);
  });

  it("does not throw on missing or malformed node records", () => {
    expect(
      Endpoints.shouldSelfRepairPosition(undefined, HOME, true, false)
    ).to.equal(false);
    expect(
      Endpoints.shouldSelfRepairPosition(
        { node3: undefined, node1: { error: 42 } },
        HOME,
        true,
        false
      )
    ).to.equal(false);
  });
});

