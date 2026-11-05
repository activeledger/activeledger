import { expect } from "chai";
import "mocha";
import { voteOnlyRecord } from "../packages/network/src/network/voteonly";

describe("Vote only retention", () => {
  const full: any = {
    $umid: "u1",
    $broadcast: true,
    $tx: { $namespace: "n", $contract: "c", $i: { a: {} }, $o: {} },
    $sigs: { a: "sig" },
    $revs: { $i: { a: "1-x" }, $o: {} },
    $nodes: {
      me: { vote: true, commit: true, incomms: { k: 1 }, leader: true },
      other: { vote: false, commit: false, error: "no" },
    },
  };

  it("keeps this node's answer and nothing else of the transaction", () => {
    const rec = voteOnlyRecord("u1", full, "me");
    expect(rec.entry).to.deep.equal({
      $umid: "u1",
      $broadcast: true,
      $nodes: { me: { vote: true, commit: true, incomms: { k: 1 }, leader: true } },
    });
    expect(rec.entry.$tx).to.equal(undefined);
    expect(rec.entry.$sigs).to.equal(undefined);
    expect(rec.entry.$revs).to.equal(undefined);
    expect(rec.finished).to.equal(true);
    expect(rec.responded).to.equal(true);
    expect(rec.shutdown).to.equal(true);
    expect(rec.voteOnly).to.equal(true);
  });

  it("holds no answer when this node never gave one", () => {
    expect(voteOnlyRecord("u1", { ...full, $nodes: {} }, "me").entry.$nodes).to.deep.equal({});
    expect(voteOnlyRecord("u1", undefined, "me").entry.$nodes).to.deep.equal({});
  });

  it("does not hold on to the original entry through its callbacks", () => {
    const rec = voteOnlyRecord("u1", full, "me");
    expect(rec.resolve()).to.equal(undefined);
    expect(rec.reject()).to.equal(undefined);
    expect(rec.resolve.toString()).to.not.contain("full");
  });
});
