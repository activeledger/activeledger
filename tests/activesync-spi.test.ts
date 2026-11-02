import { expect } from "chai";
import "mocha";
import {
  spiConsensus,
  previousUmidFor,
  revPosition,
  bulkWriteFailed,
  shouldTriggerSpiLookup,
} from "../packages/activesync/src/spi";

// The pure decision helpers in @activeledger/activesync, tested directly
// rather than through the Endpoints wrappers. The decision matrix in
// spi-consensus-matrix.test.ts covers the named production incidents; this
// file covers what the answer must not depend on (the order nodes
// happened to reply in) and the malformed or boundary input a peer can send.

const ID = "088067b4";
const at = (rev: string) => ({ _id: ID, _rev: rev });
const locked = { _id: ID, locked: true };
const THRESHOLD = 2;

describe("spiConsensus - the answer must not depend on reply order (Activesync)", () => {
  const pos39a = at("39-aaaaaaaa");
  const pos39b = at("39-bbbbbbbb");
  const pos40 = at("40-cccccccc");
  const pos41 = at("41-eeeeeeee");

  const outcome = (nodes: any[][]) => {
    const { winners, abstained } = spiConsensus(nodes, THRESHOLD);
    return { winner: winners[ID]?.rev, abstained: abstained[ID] };
  };

  it("keeps a fork at a lower position when an equally supported revision is at a later one, in every order", () => {
    // 39-a and 39-b are a fork with two votes each, and 40-c has two as
    // well. 40 descends from at most one of the 39s, so rewriting to it
    // would silently overwrite the other branch: abstain, whatever the
    // order the nodes happened to answer in.
    const answers = [[pos39a], [pos39a], [pos39b], [pos39b], [pos40], [pos40]];
    const permute = <T>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permute([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
          );

    const orders = permute(answers);
    expect(orders).to.have.length(720);
    for (const order of orders) {
      const { winner, abstained } = outcome(order);
      expect(winner).to.equal(undefined);
      expect(abstained).to.contain("forked");
      expect(abstained).to.contain("needs a human");
    }
  });

  it("still lets a later position break a tie when there is no fork", () => {
    const nodes = [[pos39a], [pos39a], [pos40], [pos40]];
    for (const order of [nodes, [...nodes].reverse()]) {
      expect(outcome(order).winner).to.equal("40-cccccccc");
    }
  });

  it("does not let a fork between smaller groups veto a revision with more votes", () => {
    // Two groups of two forked at position 39, but three nodes agree on
    // 41. Three is the network's state; the fork among the twos is not
    // what is being decided.
    const nodes = [[pos39a], [pos39a], [pos39b], [pos39b], [pos41], [pos41], [pos41]];
    const forward = outcome(nodes);
    const reversed = outcome([...nodes].reverse());

    expect(forward.winner).to.equal("41-eeeeeeee");
    expect(forward.abstained).to.equal(undefined);
    expect(reversed).to.deep.equal(forward);
  });

  it("still reports a fork at the leading support and position in either order", () => {
    const nodes = [[pos39a], [pos39a], [pos39b], [pos39b], [pos41]];
    for (const order of [nodes, [...nodes].reverse()]) {
      const { winner, abstained } = outcome(order);
      expect(winner).to.equal(undefined);
      expect(abstained).to.contain("forked");
    }
  });
});

describe("spiConsensus - malformed peer answers (Activesync)", () => {
  it("returns nothing for no answers at all", () => {
    expect(spiConsensus([], THRESHOLD)).to.deep.equal({
      winners: {},
      abstained: {},
      forks: {},
    });
  });

  it("skips null, empty and non-array answers and entries without an id", () => {
    const good = at("39-aaaaaaaa");
    const { winners, abstained } = spiConsensus(
      [
        null,
        undefined,
        [],
        { error: true },
        [null, undefined, { _rev: "39-aaaaaaaa" }, good],
        [good],
      ] as any[],
      THRESHOLD
    );

    expect(abstained).to.deep.equal({});
    expect(winners[ID].rev).to.equal("39-aaaaaaaa");
    expect(winners[ID].votes).to.equal(2);
  });

  it("treats an entry with an id but no revision as no vote, not as a vote for undefined", () => {
    const { winners, abstained } = spiConsensus(
      [[{ _id: ID }], [{ _id: ID }], [{ _id: ID }]],
      THRESHOLD
    );

    expect(winners).to.deep.equal({});
    expect(abstained).to.deep.equal({});
  });

  it("lets the locked marker win over a revision carried on the same entry", () => {
    // A locked node must stay silent even if it also sent a revision
    const stale = { _id: ID, _rev: "38-stale", locked: true };
    const rev = at("39-aaaaaaaa");
    const { winners, abstained } = spiConsensus(
      [[stale], [stale], [rev], [rev]],
      THRESHOLD
    );

    // Two real votes, two silent: not enough to outnumber the silent
    expect(winners[ID]).to.equal(undefined);
    expect(abstained[ID]).to.contain("inconclusive");
    expect(abstained[ID]).to.contain("2 node(s) could not report");
  });

  it("keeps ids from one answer apart when a node reports several streams", () => {
    const other = { _id: "other", _rev: "7-aaaaaaaa" };
    const mine = at("39-aaaaaaaa");
    const { winners } = spiConsensus(
      [[mine, other], [mine, other], [other]],
      THRESHOLD
    );

    expect(winners[ID].votes).to.equal(2);
    expect(winners["other"].votes).to.equal(3);
  });

  it("returns the document of the winning revision, not of a losing one", () => {
    const win = { _id: ID, _rev: "39-aaaaaaaa", data: "winner" };
    const lose = { _id: ID, _rev: "38-bbbbbbbb", data: "loser" };
    const { winners } = spiConsensus([[win], [win], [win], [lose]], THRESHOLD);

    expect(winners[ID].doc.data).to.equal("winner");
  });

  it("explains an unreachable threshold differently when nothing was silent", () => {
    const { abstained } = spiConsensus([[at("39-aaaaaaaa")]], THRESHOLD);

    expect(abstained[ID]).to.equal("no revision reached consensus");
  });

  it("names a locked-only stream as one nobody could report on", () => {
    const { abstained } = spiConsensus([[locked], [locked]], THRESHOLD);

    expect(abstained[ID]).to.equal(
      "no revision reached consensus, 2 node(s) could not report"
    );
  });
});

describe("revPosition (Activesync)", () => {
  it("reads the position off a revision", () => {
    expect(revPosition("39-246bc890")).to.equal(39);
    expect(revPosition("0-abc")).to.equal(0);
  });

  it("is 0 for anything that has no leading position", () => {
    expect(revPosition("")).to.equal(0);
    expect(revPosition(undefined as any)).to.equal(0);
    expect(revPosition(null as any)).to.equal(0);
    expect(revPosition("-abc")).to.equal(0);
    expect(revPosition("abc-39")).to.equal(0);
  });

  it("orders positions numerically, not as text", () => {
    expect(revPosition("100-a")).to.be.greaterThan(revPosition("99-a"));
  });
});

describe("bulkWriteFailed (Activesync)", () => {
  it("counts only an explicit ok: true as a write", () => {
    expect(bulkWriteFailed({ ok: true })).to.equal(false);
  });

  it("treats every other shape a failed layer can report as a failure", () => {
    for (const response of [
      undefined,
      null,
      false,
      true,
      {},
      { ok: false },
      { ok: "true" },
      { ok: 1 },
      { data: null },
      [],
    ]) {
      expect(bulkWriteFailed(response), JSON.stringify(response)).to.equal(true);
    }
  });
});

describe("shouldTriggerSpiLookup - boundaries (Activesync)", () => {
  const spi = "Stream Position Incorrect";
  const other = "Deterministic Stream Name Exists";

  it("triggers on a single position error out of three, the smallest that clears the floor", () => {
    expect(shouldTriggerSpiLookup([spi, other, other])).to.equal(true);
  });

  it("matches the position error inside a longer message", () => {
    expect(shouldTriggerSpiLookup([`${spi}: 38 expected 39`])).to.equal(true);
  });

  it("does not trigger on an empty list", () => {
    expect(shouldTriggerSpiLookup([])).to.equal(false);
  });

  it("does not trigger on an empty list when this node's own error is something else", () => {
    expect(shouldTriggerSpiLookup([], other)).to.equal(false);
    expect(shouldTriggerSpiLookup([], "")).to.equal(false);
  });

  it("triggers on this node's own position error even with no network errors", () => {
    expect(shouldTriggerSpiLookup(undefined, spi)).to.equal(true);
    expect(shouldTriggerSpiLookup([], spi)).to.equal(true);
  });

  it("does not trigger when this node has no error and the others report something unrelated", () => {
    expect(shouldTriggerSpiLookup([other, other, other], undefined)).to.equal(false);
  });
});

describe("previousUmidFor (Activesync)", () => {
  const S = "s".repeat(64);

  it("returns the umid a stream's update replaced", () => {
    const doc = { streams: { updated: [{ id: S, prev: "U1" }] } };
    expect(previousUmidFor(doc, S)).to.equal("U1");
  });

  it("picks the entry for the asked stream out of several", () => {
    const doc = {
      streams: {
        updated: [
          { id: "other", prev: "WRONG" },
          { id: S, prev: "U1" },
        ],
      },
    };
    expect(previousUmidFor(doc, S)).to.equal("U1");
  });

  it("is undefined at the start of a stream, where there is no prev", () => {
    const doc = { streams: { updated: [{ id: S }] } };
    expect(previousUmidFor(doc, S)).to.equal(undefined);
    expect(previousUmidFor({ streams: { updated: [{ id: S, prev: "" }] } }, S)).to.equal(undefined);
  });

  it("is undefined for a creation, which lives under new and not updated", () => {
    expect(previousUmidFor({ streams: { new: [{ id: S }] } }, S)).to.equal(undefined);
  });

  it("is undefined for a document with no usable streams section", () => {
    for (const doc of [
      undefined,
      null,
      {},
      { streams: null },
      { streams: {} },
      { streams: { updated: "nope" } },
      { streams: { updated: {} } },
    ]) {
      expect(previousUmidFor(doc, S), JSON.stringify(doc)).to.equal(undefined);
    }
  });

  it("skips null entries in the updated list", () => {
    const doc = { streams: { updated: [null, undefined, { id: S, prev: "U1" }] } };
    expect(previousUmidFor(doc, S)).to.equal("U1");
  });

  it("matches an id that carries a virtual prefix on either side", () => {
    expect(previousUmidFor({ streams: { updated: [{ id: `v:${S}`, prev: "U1" }] } }, S)).to.equal("U1");
    expect(previousUmidFor({ streams: { updated: [{ id: S, prev: "U1" }] } }, `v:${S}`)).to.equal("U1");
  });

  it("does not take an entry with no id for the stream asked about", () => {
    // Every string ends with "", so an entry missing its id used to be
    // read as matching whatever stream was asked for, and the walk would
    // follow that entry's prev down another stream's history.
    const doc = {
      streams: {
        updated: [{ prev: "WRONG" }, { id: "", prev: "WRONG" }, { id: S, prev: "U1" }],
      },
    };
    expect(previousUmidFor(doc, S)).to.equal("U1");
    expect(previousUmidFor({ streams: { updated: [{ prev: "WRONG" }] } }, S)).to.equal(undefined);
  });
});
