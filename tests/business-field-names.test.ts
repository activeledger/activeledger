import { expect } from "chai";
import "mocha";
import { spiConsensus } from "@activeledger/activesync";
import { Catchup, CatchupDeps } from "../packages/network/src/network/catchup";

/**
 * A stream's state is whatever its contract wrote, so the engine must read a
 * peer's copy by what it is (an _id and a _rev) and never by a field name
 * that business data is free to use. `locked` was read as "this node could not
 * report" and left a contract's streams unrepairable. These run the repair
 * paths with data that uses the names the engine itself is likely to use.
 */
const NAMES = [
  "locked", "error", "ok", "vote", "commit", "status", "state", "reason",
  "conflict", "deleted", "new_edits", "docs", "umid", "early", "leader",
  "name", "data", "id", "rev", "type", "$umid", "$nodes", "constructor",
];
const VALUES: [string, unknown][] = [
  ["true", true], ["false", false], ["0", 0], ["a big number", 26400000],
  ["the string 0", "0"], ["an empty string", ""], ["text", "yes"],
  ["null", null], ["an array", [1, 2]], ["an object", { a: 1 }],
];

describe("Stream data may use any field name (SPI and catch-up)", () => {
  const ID = "ab".repeat(32);
  const doc = (rev: string, extra: any = {}) => ({ _id: ID, _rev: rev, ...extra });

  describe("spiConsensus", () => {
    for (const name of NAMES) {
      for (const [label, value] of VALUES) {
        it(`counts a copy with ${name} = ${label} as a vote`, () => {
          const same = doc("5-aaaa", { [name]: value });
          const behind = doc("4-bbbb");
          const { winners, abstained } = spiConsensus([[same], [same], [behind], [same]], 2);
          expect(winners[ID]?.rev).to.equal("5-aaaa");
          expect(winners[ID].votes).to.equal(3);
          expect(abstained[ID]).to.equal(undefined);
        });
      }
    }

    it("still reads a bare {_id, locked: true} as a node that could not report", () => {
      const rev = doc("5-aaaa", { locked: 100 });
      const { winners } = spiConsensus([[rev], [rev], [rev], [{ _id: ID, locked: true }]], 2);
      expect(winners[ID].votes).to.equal(3);
    });

    it("lets a copy carry a _rev and the engine marker's name without being silenced", () => {
      const rev = doc("5-aaaa", { locked: true });
      const { winners } = spiConsensus([[rev], [rev], [rev], [rev]], 2);
      expect(winners[ID].votes).to.equal(4);
    });
  });

  describe("catch-up", () => {
    for (const name of NAMES) {
      it(`brings a stream whose state has a field called ${name} to the network's revision`, async () => {
        const networkDocs: { [id: string]: any } = {
          s1: { _id: "s1", _rev: "4-aaa", [name]: 26400000 },
          "s1:stream": { _id: "s1:stream", _rev: "4-aaa" },
        };
        const local: { [id: string]: any } = {
          s1: { _id: "s1", _rev: "1-old" },
          "s1:stream": { _id: "s1:stream", _rev: "1-old" },
        };
        const rewrites: any[] = [];
        const deps: CatchupDeps = {
          umidsSince: async () => ({ rows: [{ umid: "u1", timestamp: "10000" }], more: false }),
          holds: async () => false,
          adopt: async () => ["s1"],
          networkStreams: async (ids) =>
            Array.from({ length: 3 }, () => ids.map((id) => networkDocs[id]).filter(Boolean).map((d) => ({ ...d }))),
          consensusNeeded: () => 2,
          local: async (id) => local[id],
          rewrite: async (d) => (rewrites.push(d), (local[d._id] = d), true),
          lock: () => true,
          unlock: () => undefined,
          repairHistory: async () => undefined,
          sleep: async () => undefined,
        };
        const result = (await new Catchup(deps, { margin: 1000, cap: 50, pageSize: 3, concurrency: 2 }).run(10000))!;
        expect(result.rewritten).to.equal(1);
        expect(rewrites.map((d) => d._id)).to.deep.equal(["s1", "s1:stream"]);
        expect(rewrites[0][name]).to.equal(26400000);
      });
    }
  });
});
