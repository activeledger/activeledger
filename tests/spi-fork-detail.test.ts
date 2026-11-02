import { expect } from "chai";
import "mocha";
import {
  spiConsensus,
  describeFork,
  SPI_FORK_TAG,
} from "../packages/activesync/src/spi";

const ID = "088067b4";
const at = (rev: string) => ({ _id: ID, _rev: rev });
const A = at("39-aaaa");
const B = at("39-bbbb");
const locked = { _id: ID, locked: true };

describe("spiConsensus - fork detail", () => {
  it("reports each competing revision with position, votes and the nodes that held it", () => {
    // node indexes: 0=A 1=B 2=A 3=B
    const r = spiConsensus([[A], [B], [A], [B]], 2);

    expect(r.abstained[ID]).to.equal(
      "forked - two revisions at the same position, needs a human"
    );
    expect(r.winners).to.deep.equal({});
    expect(r.forks[ID]).to.deep.equal({
      revisions: [
        { rev: "39-aaaa", position: 39, votes: 2, nodes: [0, 2] },
        { rev: "39-bbbb", position: 39, votes: 2, nodes: [1, 3] },
      ],
      silent: 0,
      consensusReached: 2,
    });
  });

  it("counts silent nodes in the fork", () => {
    const r = spiConsensus([[A], [B], [locked]], 1);
    expect(r.forks[ID].silent).to.equal(1);
    expect(r.forks[ID].revisions.map((x) => x.nodes)).to.deep.equal([[0], [1]]);
  });

  it("has no fork for a clear winner", () => {
    const r = spiConsensus([[A], [A], [A], [B]], 2);
    expect(r.winners[ID].rev).to.equal("39-aaaa");
    expect(r.forks).to.deep.equal({});
  });

  it("has no fork for other abstentions", () => {
    // different positions: lag, not a fork
    const lag = spiConsensus([[at("38-x")], [A], [A], [at("38-x")]], 2);
    expect(lag.forks).to.deep.equal({});
    // inconclusive: 2 agree, 2 silent
    const inconclusive = spiConsensus([[A], [A], [locked], [locked]], 2);
    expect(inconclusive.abstained[ID]).to.contain("inconclusive");
    expect(inconclusive.forks).to.deep.equal({});
    // nobody reaches the threshold
    const none = spiConsensus([[A], [B], [at("39-cccc")]], 2);
    expect(none.abstained[ID]).to.equal("no revision reached consensus");
    expect(none.forks).to.deep.equal({});
    // only silent nodes
    const silent = spiConsensus([[locked], [locked]], 1);
    expect(silent.abstained[ID]).to.contain("could not report");
    expect(silent.forks).to.deep.equal({});
  });
});

describe("describeFork", () => {
  const fork = spiConsensus([[A], [B], [A], [B], [locked]], 2).forks[ID];
  const text = describeFork(ID, fork, { umid: "umid-123" });

  it("names the stream and the transaction that exposed it", () => {
    expect(text.split("\n")[0]).to.contain(ID);
    expect(text).to.contain("umid-123");
  });

  it("lists every revision with position, votes and nodes", () => {
    expect(text).to.contain("39-aaaa  position 39  2 vote(s)  nodes: #0, #2");
    expect(text).to.contain("39-bbbb  position 39  2 vote(s)  nodes: #1, #3");
  });

  it("says node numbers are indexes when no names are available", () => {
    expect(text).to.contain("no name mapping was available");
  });

  it("uses node names when a mapping is given", () => {
    const named = describeFork(ID, fork, {
      umid: "u",
      nodeNames: (i) => `node-${i}.example`,
    });
    expect(named).to.contain("node-0.example (#0), node-2.example (#2)");
    expect(named).to.not.contain("no name mapping");
  });

  it("states the silent node count and that no action was taken", () => {
    expect(text).to.contain(
      "Silent nodes (could not report, stream locked or unreachable): 1"
    );
    expect(text).to.contain("took NO action");
    expect(text).to.contain("rewrote nothing");
  });

  it("gives next steps naming only real tooling", () => {
    expect(text).to.contain("POST /a/stream");
    expect(text).to.contain(`"$streams":["${ID}"]`);
    expect(text).to.contain("Decide which revision is correct");
    expect(text).to.contain("activerestore");
    expect(text).to.contain("docs/guide/operate/restore.md");
  });

  it("ends with one greppable compact JSON line carrying the same facts", () => {
    const lines = text.split("\n");
    const last = lines[lines.length - 1].trim();
    expect(last.startsWith(SPI_FORK_TAG + " {")).to.equal(true);
    const json = JSON.parse(last.slice(SPI_FORK_TAG.length + 1));
    expect(json).to.deep.equal({
      stream: ID,
      umid: "umid-123",
      seen: 1,
      revisions: fork.revisions,
      silent: 1,
      consensusReached: 2,
      action: "none",
    });
    expect(text.split(SPI_FORK_TAG).length).to.equal(2);
  });

  it("adds a repeat count only when seen more than once", () => {
    expect(text).to.not.contain("times since first logged");
    const again = describeFork(ID, fork, {
      umid: "u",
      seen: 5,
      firstSeen: "T0",
    });
    expect(again).to.contain("Seen 5 times since first logged at T0");
  });
});
