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

// The SPI repair used to take its write on trust. Every layer under it
// reports failure by returning something rather than throwing, so a repair
// that never landed looked exactly like one that did - and the node
// carried on believing it had caught up.
describe("Endpoints.bulkWriteFailed (Activenetwork)", () => {
  it("treats LevelMe's false / self hosted { ok: false } as a failure", () => {
    // LevelMe.bulkDocs() returns false when its batch write throws (a full
    // disk, which is exactly how the node3 divergence started), and the
    // self hosted HTTP layer answers 200 with { ok: false }
    expect(Endpoints.bulkWriteFailed(false)).to.equal(true);
    expect(Endpoints.bulkWriteFailed({ ok: false })).to.equal(true);
  });

  it("treats an unreachable node as a failure", () => {
    // ActiveRequest.send() resolves { data: null } for every transport
    // fault, so a call that never arrived must not read as success
    expect(Endpoints.bulkWriteFailed(null)).to.equal(true);
    expect(Endpoints.bulkWriteFailed(undefined)).to.equal(true);
  });

  it("treats a CouchDB per document error as a failure", () => {
    expect(
      Endpoints.bulkWriteFailed([{ id: "stream-a", error: "conflict" }])
    ).to.equal(true);
  });

  it("accepts a successful write in either shape", () => {
    expect(Endpoints.bulkWriteFailed({ ok: true })).to.equal(false);
    expect(
      Endpoints.bulkWriteFailed([{ ok: true, id: "stream-a", rev: "39-abc" }])
    ).to.equal(false);
  });
});

// The tally SPI votes with. Observed live on a four node network: node3
// held the CryptoTransfer stream at 38-c54a2e1c while nodes 1/2/4 held
// 39-246bc890, and node3's own SPI logged
//
//   SPI 3 >= 2 for <deployer identity>@2-5559ccf9    <- 3 votes, idle stream
//   SPI 2 >= 2 for <CryptoTransfer>@38-c54a2e1c      <- picked its OWN stale rev
//
// The peers' 39s never reached the tally: Endpoints.streams() silently
// omitted the stream on any node holding a write lock for a live
// transfer, and a busy contract stream is locked most of the time. The
// winner then equalled what node3 already held, so nothing was rewritten,
// nothing was logged, and SPI reported success - permanently.
describe("Endpoints.spiConsensus (Activenetwork)", () => {
  const stale = { _id: "088067", _rev: "38-c54a2e1c" };
  const agreed = { _id: "088067", _rev: "39-246bc890" };
  const identity = { _id: "8e55d6", _rev: "2-5559ccf9" };

  it("picks the revision the majority reported", () => {
    const { winners } = Endpoints.spiConsensus(
      [[agreed], [agreed], [agreed], [stale]],
      2
    );

    expect(winners["088067"].rev).to.equal("39-246bc890");
    expect(winners["088067"].votes).to.equal(3);
  });

  it("abstains on a stream a node could not report, rather than voting on the rest", () => {
    // The node3 case: peers busy, so only the stale local answer counts
    const { winners, abstained } = Endpoints.spiConsensus(
      [
        [{ _id: "088067", locked: true }, identity],
        [{ _id: "088067", locked: true }, identity],
        [stale, identity],
      ],
      2
    );

    expect(winners["088067"]).to.equal(undefined);
    expect(abstained["088067"]).to.contain("sample incomplete");

    // and the stream nobody was busy with is still decided
    expect(winners["8e55d6"].rev).to.equal("2-5559ccf9");
  });

  it("never lets a stale minority carry a stream whose sample is short", () => {
    // Two stale answers meeting a threshold of 2 must not beat three
    // nodes that were unable to answer
    const { winners, abstained } = Endpoints.spiConsensus(
      [
        [stale],
        [stale],
        [{ _id: "088067", locked: true }],
        [{ _id: "088067", locked: true }],
      ],
      2
    );

    expect(winners["088067"]).to.equal(undefined);
    expect(abstained["088067"]).to.contain("2 node(s) could not report");
  });

  it("abstains when no revision reaches the threshold", () => {
    const { winners, abstained } = Endpoints.spiConsensus(
      [[agreed], [stale]],
      2
    );

    expect(winners["088067"]).to.equal(undefined);
    expect(abstained["088067"]).to.equal("no revision reached consensus");
  });

  it("prefers the later position when two revisions have equal support", () => {
    const { winners } = Endpoints.spiConsensus(
      [[agreed], [agreed], [stale], [stale]],
      2
    );

    expect(winners["088067"].rev).to.equal("39-246bc890");
  });

  it("ignores nodes that failed to answer at all", () => {
    const { winners } = Endpoints.spiConsensus(
      [[agreed], [agreed], { error: true, from: "node4" }, undefined],
      2
    );

    expect(winners["088067"].rev).to.equal("39-246bc890");
  });

  it("ignores a not found, which comes back with neither id nor revision", () => {
    const { winners } = Endpoints.spiConsensus(
      [
        [agreed, {}],
        [agreed, {}],
      ],
      2
    );

    expect(winners["088067"].rev).to.equal("39-246bc890");
    expect(Object.keys(winners)).to.have.length(1);
  });

  it("carries the winning document, not just its revision", () => {
    const full = { _id: "088067", _rev: "39-246bc890", state: { balance: 1 } };
    const { winners } = Endpoints.spiConsensus([[full], [full]], 2);

    expect(winners["088067"].doc).to.deep.equal(full);
  });
});
