import { Host } from "../packages/network/src/network/host";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Locker } from "../packages/network/src/network/locker";
import { expect } from "chai";
import "mocha";

const STREAM =
  "5d1750a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";

// A broadcast contract update locks its output stream on every node. So
// when the origin's own vote fails on that stream and it runs SPI, every
// peer is holding the exact stream it needs to ask about, answers
// "locked", and the origin abstains on a sample its own transaction
// spoiled. A node that is the origin of the transaction it is behind on
// could therefore never heal - which is why one production laggard healed
// (its update was sent through an up-to-date node) and two did not.
//
// The exception that fixes it: a peer that has already voted AGAINST that
// transaction will never write those streams, so its copy is stable and
// can be read. Everything here is about keeping that exception exactly
// that narrow.
describe("Host.hasVotedAgainst (Activenetwork)", () => {
  const entry = (self: any): any => ({ $nodes: { me: self, other: {} } });

  it("is true once this node has voted no", () => {
    expect(Host.hasVotedAgainst(entry({ vote: false, commit: false }), "me")).to.equal(true);
  });

  it("is false while voting is still open", () => {
    // postVote() deletes `early` when the opinion becomes real. Until then
    // nothing is known, and a maybe must read as no.
    expect(
      Host.hasVotedAgainst(entry({ vote: false, commit: false, early: true }), "me")
    ).to.equal(false);
  });

  it("is false when this node voted yes, even before it commits", () => {
    // It may still write, and a write is what makes a read unsafe
    expect(Host.hasVotedAgainst(entry({ vote: true, commit: false }), "me")).to.equal(false);
  });

  it("is false when this node has already committed", () => {
    expect(Host.hasVotedAgainst(entry({ vote: true, commit: true }), "me")).to.equal(false);
  });

  it("is false for an unknown transaction or an absent record", () => {
    expect(Host.hasVotedAgainst(undefined, "me")).to.equal(false);
    expect(Host.hasVotedAgainst({ $nodes: {} } as any, "me")).to.equal(false);
  });
});

describe("Endpoints.streams - answering about a locked stream (Activenetwork)", () => {
  const doc = { _id: STREAM, _rev: "42-746224aa" };
  // The sample is one allDocs({keys}) rather than a get() per id, so that a
  // stream and its :stream meta cannot be read either side of a commit
  // batch. Answers in CouchDB's shape, which is what LevelMe returns too.
  const db: any = {
    allDocs: async ({ keys }: { keys: string[] }) => ({
      rows: keys.map((key) => ({ doc: key === STREAM ? doc : undefined })),
    }),
  };
  // Umid-aware, so a test can prove which transaction was actually asked
  // about rather than passing because the double says yes to everything.
  const votedAgainst = (...umids: string[]): any => ({
    willNotCommit: (umid: string) => umids.indexOf(umid) !== -1,
  });
  const hostThatVotedAgainst: any = votedAgainst("tx-under-way");
  const hostThatMayCommit: any = { willNotCommit: () => false };

  const ask = async (body: any, host?: any) =>
    ((await Endpoints.streams(db, body, host)) as any).content;

  afterEach(() => Locker.release(STREAM, "tx-under-way"));

  it("reports the real revision to the transaction that holds the lock, once it has been voted down", async () => {
    Locker.hold(STREAM, "tx-under-way");

    const content = await ask(
      { $streams: [STREAM], $umid: "tx-under-way" },
      hostThatVotedAgainst
    );

    expect(content).to.deep.equal([doc]);
  });

  it("still refuses while that node might yet commit", async () => {
    Locker.hold(STREAM, "tx-under-way");

    const content = await ask(
      { $streams: [STREAM], $umid: "tx-under-way" },
      hostThatMayCommit
    );

    expect(content).to.deep.equal([{ _id: STREAM, locked: true }]);
  });

  it("answers a DIFFERENT transaction, because the HOLDER is the one that was voted down", async () => {
    // This used to refuse: the rule demanded the lock be held by the
    // asker's own transaction. That condition never carried any safety -
    // whose round is asking says nothing about whether this node's copy is
    // about to move. What matters is that the HOLDER will never write it.
    Locker.hold(STREAM, "tx-under-way");

    const content = await ask(
      { $streams: [STREAM], $umid: "some-other-tx" },
      hostThatVotedAgainst
    );

    expect(content).to.deep.equal([doc]);
  });

  it("answers when no umid is offered at all, since the holder is looked up not guessed", async () => {
    // The asker no longer has to identify its round for this to work, so an
    // older node - or any caller that omits $umid - is served too.
    Locker.hold(STREAM, "tx-under-way");

    const content = await ask({ $streams: [STREAM] }, hostThatVotedAgainst);

    expect(content).to.deep.equal([doc]);
  });

  it("refuses when the node voted against a DIFFERENT transaction to the one holding the lock", async () => {
    // The safety property, stated the hard way: having voted something down
    // is only relevant if that something is what holds this stream. Here the
    // node rejected an unrelated round while the holder is still live.
    Locker.hold(STREAM, "tx-under-way");

    const content = await ask(
      { $streams: [STREAM], $umid: "tx-under-way" },
      votedAgainst("a-completely-different-tx")
    );

    expect(content).to.deep.equal([{ _id: STREAM, locked: true }]);
  });

  it("refuses when there is no host to ask", async () => {
    Locker.hold(STREAM, "tx-under-way");

    const content = await ask({ $streams: [STREAM], $umid: "tx-under-way" });

    expect(content).to.deep.equal([{ _id: STREAM, locked: true }]);
  });

  it("answers normally when nothing holds the stream", async () => {
    const content = await ask(
      { $streams: [STREAM], $umid: "tx-under-way" },
      hostThatMayCommit
    );

    expect(content).to.deep.equal([doc]);
  });
});
