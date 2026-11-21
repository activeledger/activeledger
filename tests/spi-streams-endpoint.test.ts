import { expect } from "chai";
import "mocha";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { Locker } from "../packages/network/src/network/locker";

/**
 * The sampling endpoint itself - what a node hands back when another node
 * asks it to arbitrate a stream.
 *
 * Everything spiConsensus decides is decided from these answers, so the
 * shapes matter as much as the decisions. In particular a node that cannot
 * report has to say so: staying silent is indistinguishable from "I do not
 * have it", and a caller that treats absence as a non-answer will let a
 * minority revision - including its own stale one - carry the vote.
 */

const STREAM = "6f3d7e2a9b1c4d5e8f0a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70";
const OTHER = "aa3d7e2a9b1c4d5e8f0a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6faa";

const doc = { _id: STREAM, _rev: "42-746224aa" };
const otherDoc = { _id: OTHER, _rev: "7-9931aa20" };

/** Records how the store was asked, so N+1 reads cannot creep back in. */
function makeDb(docs: any[] = [doc, otherDoc]) {
  const calls = { allDocs: 0, get: 0, keys: [] as string[][] };
  return {
    calls,
    db: {
      allDocs: async ({ keys }: { keys: string[] }) => {
        calls.allDocs++;
        calls.keys.push(keys);
        return {
          rows: keys.map((key) => ({ doc: docs.find((d) => d._id === key) })),
        };
      },
      get: async (id: string) => {
        calls.get++;
        return docs.find((d) => d._id === id) || { error: "not found" };
      },
    } as any,
  };
}

const votedAgainst = (...umids: string[]): any => ({
  willNotCommit: (umid: string) => umids.indexOf(umid) !== -1,
});

const ask = async (db: any, body: any, host?: any) =>
  (await Endpoints.streams(db, body, host)) as any;

describe("Endpoints.streams - the sampling endpoint (Activenetwork)", () => {
  afterEach(() => {
    Locker.release(STREAM, "holder-tx");
    Locker.release(OTHER, "holder-tx");
    Locker.release(STREAM, "other-tx");
    Locker.release(OTHER, "other-tx");
  });

  describe("how the store is asked", () => {
    it("reads the whole sample in ONE call, not one per stream", async () => {
      // A get() per id is two independent round trips for a stream and its
      // meta, and a commit landing between them yields a mismatched pair
      // that cannot be repaired afterwards.
      const { db, calls } = makeDb();

      await ask(db, { $streams: [STREAM, `${STREAM}:stream`, OTHER] });

      expect(calls.allDocs).to.equal(1);
      expect(calls.get).to.equal(0);
      expect(calls.keys[0]).to.have.length(3);
    });

    it("does not ask about streams it already refused", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db, calls } = makeDb();

      await ask(db, { $streams: [STREAM, OTHER] }, votedAgainst());

      expect(calls.keys[0]).to.deep.equal([OTHER]);
    });

    it("asks for nothing at all when every stream is refused", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db, calls } = makeDb();

      const response = await ask(db, { $streams: [STREAM] }, votedAgainst());

      expect(calls.allDocs).to.equal(0);
      expect(response.content).to.deep.equal([{ _id: STREAM, locked: true }]);
    });
  });

  describe("what it answers", () => {
    it("mixes real documents and locked markers in one response", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db } = makeDb();

      const { content } = await ask(db, { $streams: [STREAM, OTHER] }, votedAgainst());

      expect(content).to.have.length(2);
      expect(content).to.deep.include({ _id: STREAM, locked: true });
      expect(content).to.deep.include(otherDoc);
    });

    it("gives the locked marker no revision, so an older node ignores it exactly as it ignored silence", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db } = makeDb();

      const { content } = await ask(db, { $streams: [STREAM] }, votedAgainst());

      expect(content[0]).to.not.have.property("_rev");
      expect(content[0].locked).to.equal(true);
    });

    it("omits a stream this node simply does not hold", async () => {
      // Absent is not the same as locked - the tally must be able to tell
      // "I do not have it" from "I cannot say".
      const { db } = makeDb([doc]);

      const { content } = await ask(db, { $streams: [STREAM, "never-seen"] });

      expect(content).to.have.length(1);
      expect(content[0]._id).to.equal(STREAM);
    });

    it("answers 200 with whatever it refused when the store read fails outright", async () => {
      Locker.hold(STREAM, "holder-tx");
      const db: any = {
        allDocs: async () => {
          throw new Error("store unreachable");
        },
      };

      const response = await ask(db, { $streams: [STREAM, OTHER] }, votedAgainst());

      expect(response.statusCode).to.equal(200);
      expect(response.content).to.deep.equal([{ _id: STREAM, locked: true }]);
    });
  });

  describe("volatile is never served", () => {
    it("refuses a :volatile request outright", async () => {
      // Volatile holds key material for some contracts. It is not part of
      // consensus and must never leave the node through this path.
      const { db } = makeDb();
      let rejected: any;
      try {
        await ask(db, { $streams: [`${STREAM}:volatile`] });
      } catch (e) {
        rejected = e;
      }

      expect(rejected).to.not.equal(undefined);
      expect(rejected.statusCode).to.equal(403);
    });

    it("refuses the whole request when a :volatile id is smuggled in alongside valid ones", async () => {
      const { db, calls } = makeDb();
      let rejected: any;
      try {
        await ask(db, { $streams: [STREAM, `${OTHER}:volatile`] });
      } catch (e) {
        rejected = e;
      }

      expect(rejected?.statusCode).to.equal(403);
      expect(calls.allDocs, "must not read anything on a rejected request").to.equal(0);
    });
  });

  describe("who may be answered about a locked stream", () => {
    it("answers when the holder has been voted down", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db } = makeDb();

      const { content } = await ask(
        db,
        { $streams: [STREAM], $umid: "anyone" },
        votedAgainst("holder-tx")
      );

      expect(content).to.deep.equal([doc]);
    });

    it("refuses when the holder may still commit", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db } = makeDb();

      const { content } = await ask(db, { $streams: [STREAM] }, votedAgainst("someone-else"));

      expect(content).to.deep.equal([{ _id: STREAM, locked: true }]);
    });

    it("refuses when there is no host to ask about the holder", async () => {
      Locker.hold(STREAM, "holder-tx");
      const { db } = makeDb();

      const { content } = await ask(db, { $streams: [STREAM] });

      expect(content).to.deep.equal([{ _id: STREAM, locked: true }]);
    });

    it("decides each stream on its own holder", async () => {
      // Two streams in one request, locked by different transactions, only
      // one of which this node rejected.
      Locker.hold(STREAM, "holder-tx");
      Locker.hold(OTHER, "other-tx");
      const { db } = makeDb();

      const { content } = await ask(db, { $streams: [STREAM, OTHER] }, votedAgainst("holder-tx"));

      expect(content).to.deep.include(doc);
      expect(content).to.deep.include({ _id: OTHER, locked: true });
    });

    it("treats a :stream meta as locked by its base stream's holder", async () => {
      // The lock is taken on the stream id; the meta document rides with
      // it. Answering about the meta while refusing the state would hand
      // back exactly the mismatched pair the lock exists to prevent.
      Locker.hold(STREAM, "holder-tx");
      const { db } = makeDb();

      const { content } = await ask(db, { $streams: [`${STREAM}:stream`] }, votedAgainst("someone-else"));

      expect(content).to.deep.equal([{ _id: `${STREAM}:stream`, locked: true }]);
    });
  });
});

describe("Locker.holder (Activenetwork)", () => {
  const A = STREAM;

  afterEach(() => {
    Locker.release(A, "tx-1");
    Locker.release(A, "tx-2");
  });

  it("is undefined for a stream nobody holds", () => {
    expect(Locker.holder(A)).to.equal(undefined);
  });

  it("names the transaction holding it", () => {
    Locker.hold(A, "tx-1");
    expect(Locker.holder(A)).to.equal("tx-1");
  });

  it("goes back to undefined once released", () => {
    Locker.hold(A, "tx-1");
    Locker.release(A, "tx-1");
    expect(Locker.holder(A)).to.equal(undefined);
  });

  it("still names the original holder after a competing hold is refused", () => {
    // hold() refuses rather than steals, so the answer must not change.
    Locker.hold(A, "tx-1");
    expect(Locker.hold(A, "tx-2")).to.equal(false);
    expect(Locker.holder(A)).to.equal("tx-1");
  });

  it("agrees with is() in both directions", () => {
    Locker.hold(A, "tx-1");
    const holder = Locker.holder(A) as string;

    expect(Locker.is(A, holder)).to.equal(true);
    expect(Locker.is(A, "tx-2")).to.equal(false);
    expect(Locker.has(A)).to.equal(true);
  });

  it("agrees with getLocks(), which is the slower way to the same answer", () => {
    Locker.hold(A, "tx-1");
    expect(Locker.holder(A)).to.equal(Locker.getLocks()[A]?.umid);
  });
});

describe("what the sampling endpoint really sends, counted by spiAnswersShort", () => {
  afterEach(() => {
    Locker.release(STREAM, "holder-tx");
    Locker.release(OTHER, "holder-tx");
  });

  /** One neighbour's real answer to a request for both streams */
  const answerOf = async (locked: string[]) => {
    for (const id of locked) Locker.hold(id, "holder-tx");
    try {
      return (await ask(makeDb().db, { $streams: [STREAM, OTHER] }, { willNotCommit: () => false })).content;
    } finally {
      for (const id of locked) Locker.release(id, "holder-tx");
    }
  };

  it("a node holding a stream under a transaction does not count for it, the others do", async () => {
    const busy = await answerOf([STREAM]);
    const free = await answerOf([]);
    expect(busy).to.deep.include({ _id: STREAM, locked: true });
    expect(Endpoints.spiAnswersShort([busy, free, free], 2)).to.equal(false);
    expect(Endpoints.spiAnswersShort([busy, busy, free], 2)).to.equal(true);
  });

  it("nodes busy on different streams still decide both", async () => {
    const onA = await answerOf([STREAM]);
    const onB = await answerOf([OTHER]);
    const free = await answerOf([]);
    expect(Endpoints.spiAnswersShort([onA, onB, free], 2)).to.equal(false);
  });

  it("a node that does not hold the stream is an answer, not a reason to ask again", async () => {
    const none = (await ask(makeDb([]).db, { $streams: [STREAM, OTHER] })).content;
    expect(none).to.deep.equal([]);
    expect(Endpoints.spiAnswersShort([none, none, none], 3)).to.equal(false);
  });

  it("a refused request (volatile) is not a list, so it is not an answer", async () => {
    const refused = await ask(makeDb().db, { $streams: [`${STREAM}:volatile`] }).then(
      () => "answered",
      (e: any) => e.content
    );
    expect(Endpoints.spiAnswersShort([refused, refused], 1)).to.equal(true);
  });
});
