import { expect } from "chai";
import "mocha";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * The SPI decision matrix.
 *
 * spiConsensus() decides whether a node rewrites its own copy of a stream,
 * and the rewrite is destructive - force_rev overwrites whatever is there,
 * in either direction, with no revision tree to fall back on. So the
 * interesting cases are not "does it pick the majority" but every shape
 * where it must REFUSE to pick one.
 *
 * These are drawn from real production incidents rather than invented:
 * the 3-1 lag that needed a hand repair, the ahead-minority contract
 * stream, the 218-per-hour NOWINNER on streams nothing disagreed about,
 * and the 2-2 split that has no automatic answer.
 *
 * Revisions are `<position>-md5(content)`, so two revisions at the same
 * position with different hashes are two different histories, and two at
 * different positions are the same history at different points. That
 * distinction is the whole basis of what is safe to do automatically.
 */

// Four-node network at the default 60% consensus: ceil(0.6 * 4 - 1) = 2
const THRESHOLD = 2;

const ID = "088067b4";
const at = (rev: string) => ({ _id: ID, _rev: rev });
const locked = { _id: ID, locked: true };

// Same history, different points
const pos38 = at("38-c54a2e1c");
const pos39 = at("39-246bc890");
// Same point, different history - a genuine fork
const pos39other = at("39-ffffffff");

const decide = (nodes: any[][], threshold = THRESHOLD) =>
  Endpoints.spiConsensus(nodes, threshold);

describe("SPI decision matrix - what a node will and will not rewrite to", () => {
  describe("clear majorities", () => {
    it("adopts a revision three of four nodes agree on", () => {
      const { winners, abstained } = decide([[pos39], [pos39], [pos39], [pos38]]);

      expect(abstained[ID]).to.equal(undefined);
      expect(winners[ID].rev).to.equal(pos39._rev);
      expect(winners[ID].votes).to.equal(3);
    });

    it("pulls an AHEAD minority back, because direction is not a tiebreak when votes differ", () => {
      // The live case: n1 alone at position 45, the other three at 44. A
      // revision one node holds never had consensus - three agreeing IS
      // the network's state - so the ahead copy is discarded. Position
      // only ever breaks a tie, and 3 vs 1 is not a tie.
      const ahead = at("45-90e6051d");
      const majority = at("44-b7ff64f1");

      const { winners } = decide([[ahead], [majority], [majority], [majority]]);

      expect(winners[ID].rev).to.equal(majority._rev);
      expect(winners[ID].votes).to.equal(3);
    });

    it("pulls a BEHIND minority forward, by the same rule", () => {
      const behind = at("41-9fb997cf");
      const majority = at("42-6ae23e97");

      const { winners } = decide([[behind], [majority], [majority], [majority]]);

      expect(winners[ID].rev).to.equal(majority._rev);
    });
  });

  describe("forks - the cases with no safe automatic answer", () => {
    it("refuses a 2-2 split at the same position", () => {
      // Each side committed something the other did not, at the same point
      // in the stream's history. Content addressing means there is nothing
      // to tell them apart on merit, and picking either destroys a real
      // transaction.
      const { winners, abstained } = decide([
        [pos39],
        [pos39],
        [pos39other],
        [pos39other],
      ]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("forked");
      expect(abstained[ID]).to.contain("needs a human");
    });

    it("still refuses a fork when one side is also silent", () => {
      const { winners, abstained } = decide([[pos39], [pos39], [pos39other], [pos39other], [locked]]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("forked");
    });

    it("does NOT call it a fork when the positions differ", () => {
      // Equal support, different positions: one side simply applied
      // something the other has not. Adopting the later one loses nothing,
      // because the lagging copy has no history of its own.
      const { winners, abstained } = decide([[pos38], [pos38], [pos39], [pos39]]);

      expect(abstained[ID]).to.equal(undefined);
      expect(winners[ID].rev).to.equal(pos39._rev);
    });
  });

  describe("silence does not vote, and does not veto", () => {
    it("decides when three agree and one is locked", () => {
      // The 218-per-hour case. All four nodes held this identically; one
      // was simply mid-transaction. Every round abstained and logged
      // NOWINNER about a copy nothing disagreed about.
      const { winners, abstained } = decide([[pos39], [pos39], [pos39], [locked]]);

      expect(abstained[ID]).to.equal(undefined);
      expect(winners[ID].rev).to.equal(pos39._rev);
      expect(winners[ID].votes).to.equal(3);
    });

    it("refuses when two agree and two are silent, because the unseen could overturn it", () => {
      // If both silent nodes disagreed the real picture would be 2-2,
      // which is a fork. A winner that silence could overturn is not one
      // worth a destructive write.
      const { winners, abstained } = decide([[pos39], [pos39], [locked], [locked]]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("inconclusive");
      expect(abstained[ID]).to.contain("2 node(s) could not report");
    });

    it("refuses when a lone answer cannot clear the threshold at all", () => {
      const { winners, abstained } = decide([[pos38], [locked], [locked], [locked]]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("no revision reached consensus");
    });

    it("refuses when every node is silent", () => {
      const { winners, abstained } = decide([[locked], [locked], [locked], [locked]]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("could not report");
    });

    it("never lets a stale minority win just because the rest went quiet", () => {
      // The failure this whole mechanism exists to avoid: the asking node's
      // own stale revision carrying its own vote, so the winner equals what
      // it already holds, nothing is rewritten, nothing is logged, and it
      // stays behind while SPI reports success.
      const { winners, abstained } = decide([[pos38], [pos38], [locked], [locked]]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("inconclusive");
    });
  });

  describe("counting - one vote per node", () => {
    it("counts a node that repeats a revision only once", () => {
      // A single node must not carry a stream by answering twice.
      const { winners, abstained } = decide([[pos38, pos38], [locked], [locked], [locked]]);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("no revision reached consensus");
    });

    it("counts a node that repeats a locked marker only once", () => {
      const { winners } = decide([[locked, locked], [pos39], [pos39]]);

      // Silence of 1 against 2 agreeing - decided. Double counting would
      // make it 2 against 2 and abstain.
      expect(winners[ID].votes).to.equal(2);
    });

    it("ignores a node that failed to answer at all", () => {
      const { winners } = decide([[pos39], [pos39], [pos39], [], null as any]);

      expect(winners[ID].rev).to.equal(pos39._rev);
    });

    it("ignores a not-found, which carries neither id nor revision", () => {
      const { winners } = decide([
        [pos39],
        [pos39],
        [pos39],
        [{ error: "not found" } as any],
      ]);

      expect(winners[ID].rev).to.equal(pos39._rev);
    });
  });

  describe("per stream, not per response", () => {
    it("decides an unlocked stream in the same response as a locked one", () => {
      // A response carrying one locked entry is the common case, not a
      // rarity - the streams SPI arbitrates are the ones the failing
      // transaction declared, so they are exactly the ones under lock. If
      // one locked entry stopped every stream in that response from being
      // decided, a node could abstain forever.
      const other = { _id: "8e55d6", _rev: "2-5559ccf9" };

      const { winners } = decide([
        [locked, other],
        [locked, other],
        [pos39, other],
        [pos39, other],
      ]);

      expect(winners["8e55d6"].rev).to.equal("2-5559ccf9");
    });
  });

  describe("thresholds other than the four-node default", () => {
    it("a three-node network decides on two against one silent", () => {
      const { winners } = decide([[pos39], [pos39], [locked]], 2);

      expect(winners[ID].votes).to.equal(2);
    });

    it("a higher threshold still governs, whatever the silence", () => {
      // Three agreeing does not clear a threshold of 4.
      const { winners, abstained } = decide([[pos39], [pos39], [pos39], [locked]], 4);

      expect(winners[ID]).to.equal(undefined);
      expect(abstained[ID]).to.contain("no revision reached consensus");
    });
  });
});
