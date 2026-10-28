import { Helper } from "../packages/restore/src/modules/helper/helper";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { expect } from "chai";
import "mocha";

const node = (reference: string, streams: [string, string][]) => ({
  reference,
  streams: streams.map(([id, rev]) => ({ id, rev })),
});

describe("Restore Helper - majority (Activerestore)", () => {
  it("carries the revision most nodes hold", () => {
    const won = Helper.majority(
      [
        node("a", [["s1", "3-aaa"]]),
        node("b", [["s1", "3-aaa"]]),
        node("c", [["s1", "2-bbb"]]),
      ],
      2
    );
    expect(won).to.deep.equal([{ stream: "s1", revision: "3-aaa" }]);
  });

  it("leaves a stream out when no revision reaches the threshold", () => {
    const won = Helper.majority(
      [node("a", [["s1", "3-aaa"]]), node("b", [["s1", "3-bbb"]]), node("c", [["s1", "3-ccc"]])],
      2
    );
    expect(won).to.deep.equal([]);
  });

  it("counts one vote per node per stream", () => {
    // One node listing a stream twice must not carry it on its own
    const won = Helper.majority(
      [node("a", [["s1", "3-aaa"], ["s1", "3-aaa"]]), node("b", [["s1", "3-bbb"]])],
      2
    );
    expect(won).to.deep.equal([]);
  });

  it("ignores entries without an id or revision", () => {
    const won = Helper.majority(
      [
        node("a", [["undefined", "1-x"], ["s1", ""]]),
        node("b", [["undefined", "1-x"], ["s1", ""]]),
      ],
      2
    );
    expect(won).to.deep.equal([]);
  });

  it("tolerates a node with no streams", () => {
    const won = Helper.majority(
      [{ reference: "a" } as any, node("b", [["s1", "1-a"]]), node("c", [["s1", "1-a"]])],
      2
    );
    expect(won).to.deep.equal([{ stream: "s1", revision: "1-a" }]);
  });

  it("never carries a revision when the threshold is unusable", () => {
    const won = Helper.majority([node("a", [["s1", "1-a"]]), node("b", [["s1", "1-a"]])], Infinity);
    expect(won).to.deep.equal([]);
  });

  it("votesNeeded is the calculation SPI makes: the percentage of all nodes, less this one, rounded up", () => {
    const was = [Provider.neighbourCount, Provider.consensusReachedAmount];
    try {
      Provider.neighbourCount = 4;
      Provider.consensusReachedAmount = 51;
      expect(Helper.votesNeeded()).to.equal(2);
      Provider.consensusReachedAmount = 60;
      expect(Helper.votesNeeded()).to.equal(2);
      // A network split 50/50 can still decide, which is what the "less one" is for
      Provider.consensusReachedAmount = 50;
      expect(Helper.votesNeeded()).to.equal(1);
      Provider.neighbourCount = 10;
      Provider.consensusReachedAmount = 51;
      expect(Helper.votesNeeded()).to.equal(5);
      Provider.neighbourCount = 4;
      // Missing settings must never read as "any single answer is a majority"
      Provider.consensusReachedAmount = undefined as any;
      expect(Helper.votesNeeded()).to.equal(Infinity);
      Provider.consensusReachedAmount = 51;
      Provider.neighbourCount = 0;
      expect(Helper.votesNeeded()).to.equal(Infinity);
    } finally {
      [Provider.neighbourCount, Provider.consensusReachedAmount] = was;
    }
  });
});
