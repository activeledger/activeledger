import { StreamResync } from "../packages/restore/src/modules/interagent/stream-resync";
import { Interagent } from "../packages/restore/src/modules/interagent/interagent";
import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { expect } from "chai";
import "mocha";

// The node3 / Varnir.CryptoTransfer incident: one node missed a single
// committed update to a contract stream during a disk-full event and was
// left permanently one revision behind (data 38-... vs the network's
// 39-..., meta 20-... vs 21-...). It then voted "Stream Position
// Incorrect" against every later transaction touching that stream, and
// nothing in the codebase ever brought it back.
//
// ActiveRestore saw the failure, tried to replay the missed transaction by
// umid, could not fetch that umid from any peer (only nodes that committed
// hold it), and discarded the error document. These cover the fallback
// that adopts the stream's agreed revision directly instead.
describe("StreamResync - streamIdsFromTransaction (Activerestore)", () => {
  const streamA =
    "088067b4445fe980865ae3c7fcf20564580abe0ca3f08bf123719c4a75611d1f";
  const streamB =
    "8547806c445fe980865ae3c7fcf20564580abe0ca3f08bf123719c4a75611d1f";

  it("collects ids from unlabelled inputs and outputs, with their meta documents", () => {
    const ids = StreamResync.streamIdsFromTransaction({
      $tx: { $i: { [streamB]: {} }, $o: { [streamA]: {} } },
    });

    expect(ids.sort()).to.deep.equal(
      [streamA, `${streamA}:stream`, streamB, `${streamB}:stream`].sort()
    );
  });

  it("resolves labelled entries through $stream", () => {
    const ids = StreamResync.streamIdsFromTransaction({
      $tx: { $i: { owner: { $stream: streamA } }, $o: {} },
    });

    expect(ids.sort()).to.deep.equal([streamA, `${streamA}:stream`].sort());
  });

  it("trims a namespace prefix down to the stream id", () => {
    const ids = StreamResync.streamIdsFromTransaction({
      $tx: { $i: { [`namespace:${streamA}`]: {} }, $o: {} },
    });

    expect(ids).to.include(streamA);
  });

  it("drops a label that carries no resolvable stream id", () => {
    // Nothing can be looked up from a bare label, and asking peers for
    // "owner" would only produce a not found that reads like disagreement
    expect(
      StreamResync.streamIdsFromTransaction({
        $tx: { $i: { owner: {} }, $o: {} },
      })
    ).to.deep.equal([]);
  });

  it("does not throw on an empty or malformed transaction", () => {
    expect(StreamResync.streamIdsFromTransaction(undefined)).to.deep.equal([]);
    expect(StreamResync.streamIdsFromTransaction({})).to.deep.equal([]);
    expect(
      StreamResync.streamIdsFromTransaction({ $tx: { $i: {}, $o: {} } })
    ).to.deep.equal([]);
  });
});

describe("StreamResync - winningDocuments (Activerestore)", () => {
  beforeEach(() => {
    // Four node network, 60% to reach consensus - so 3 of 4 agreeing wins
    (Provider as any).neighbourCount = 4;
    (Provider as any).consensusReachedAmount = 60;
  });

  const stale = { _id: "stream-a", _rev: "38-c54a2e1c" };
  const agreed = { _id: "stream-a", _rev: "39-246bc890" };

  it("picks the revision the majority holds, not the local one", () => {
    const winners = StreamResync.winningDocuments([
      [agreed],
      [agreed],
      [agreed],
      [stale],
    ]);

    expect(winners["stream-a"]).to.deep.equal(agreed);
  });

  it("returns nothing when no revision reaches consensus", () => {
    // A genuinely split network must not have its state picked for it
    const winners = StreamResync.winningDocuments([
      [agreed],
      [agreed],
      [stale],
      [stale],
    ]);

    expect(winners["stream-a"]).to.equal(undefined);
  });

  it("ignores nodes that failed to answer rather than counting them against", () => {
    const winners = StreamResync.winningDocuments([
      [agreed],
      [agreed],
      [agreed],
      { error: true, from: "node4" },
    ]);

    expect(winners["stream-a"]).to.deep.equal(agreed);
  });

  it("skips documents a node returned without an id or revision", () => {
    // A not found comes back as an object with neither, and must not vote
    const winners = StreamResync.winningDocuments([
      [agreed, {}],
      [agreed, {}],
      [agreed, {}],
    ]);

    expect(Object.keys(winners)).to.have.length(1);
    expect(winners["stream-a"]).to.deep.equal(agreed);
  });

  it("resolves the state document and its meta document together", () => {
    const meta = { _id: "stream-a:stream", _rev: "21-799d345c" };
    const winners = StreamResync.winningDocuments([
      [agreed, meta],
      [agreed, meta],
      [agreed, meta],
    ]);

    expect(winners["stream-a"]).to.deep.equal(agreed);
    expect(winners["stream-a:stream"]).to.deep.equal(meta);
  });
});

describe("StreamResync - adopting the agreed revision (Activerestore)", () => {
  let writes: { docs: any[]; options: any }[];
  let local: { [id: string]: any };

  beforeEach(() => {
    writes = [];
    local = {};

    (Provider as any).neighbourCount = 4;
    (Provider as any).consensusReachedAmount = 60;
    (Provider as any).database = {
      get: async (id: string) => {
        if (!local[id]) {
          throw { notFound: true };
        }
        return local[id];
      },
      bulkDocs: async (docs: any[], options: any) => {
        writes.push({ docs, options });
        return { ok: true };
      },
    };
    (Provider as any).network = {
      neighbourhood: {
        knockAll: async () => [
          [{ _id: "stream-a", _rev: "39-246bc890", state: "new" }],
          [{ _id: "stream-a", _rev: "39-246bc890", state: "new" }],
          [{ _id: "stream-a", _rev: "39-246bc890", state: "new" }],
        ],
      },
    };
  });

  const transaction = {
    $tx: {
      $i: {},
      $o: {
        "088067b4445fe980865ae3c7fcf20564580abe0ca3f08bf123719c4a75611d1f": {},
      },
    },
  };

  it("overwrites a present-but-stale document with new_edits + force_rev", async () => {
    // The whole point: new_edits:false throws Revision Mismatch in
    // levelme when the local revision differs, so a divergent document
    // could never be repaired by any restore path
    local["stream-a"] = { _id: "stream-a", _rev: "38-c54a2e1c" };

    const rewrote = await StreamResync.resync(transaction);

    expect(rewrote).to.equal(1);
    expect(writes).to.have.length(1);
    expect(writes[0].options).to.deep.equal({
      new_edits: true,
      force_rev: "39-246bc890",
    });
    expect(writes[0].docs[0]._rev).to.equal("39-246bc890");
  });

  it("creates a missing document with new_edits:false to keep the network revision", async () => {
    // new_edits:true on a create mints a fresh "1-<md5>", which would
    // leave this node claiming position 1 for a stream at position 39
    const rewrote = await StreamResync.resync(transaction);

    expect(rewrote).to.equal(1);
    expect(writes[0].options).to.deep.equal({ new_edits: false });
  });

  it("writes nothing when this node already holds the agreed revision", async () => {
    local["stream-a"] = { _id: "stream-a", _rev: "39-246bc890" };

    const rewrote = await StreamResync.resync(transaction);

    expect(rewrote).to.equal(0);
    expect(writes).to.have.length(0);
  });

  it("refuses to move a stream backwards", async () => {
    // Being AHEAD of the agreed revision is a different fault, and
    // discarding local state would make it unrecoverable
    local["stream-a"] = { _id: "stream-a", _rev: "40-aaaaaaaa" };

    const rewrote = await StreamResync.resync(transaction);

    expect(rewrote).to.equal(0);
    expect(writes).to.have.length(0);
  });

  it("writes nothing when the network does not agree", async () => {
    (Provider as any).network.neighbourhood.knockAll = async () => [
      [{ _id: "stream-a", _rev: "39-246bc890" }],
      [{ _id: "stream-a", _rev: "38-c54a2e1c" }],
    ];
    local["stream-a"] = { _id: "stream-a", _rev: "38-c54a2e1c" };

    const rewrote = await StreamResync.resync(transaction);

    expect(rewrote).to.equal(0);
    expect(writes).to.have.length(0);
  });

  it("does not knock the network when the transaction names no streams", async () => {
    let knocked = false;
    (Provider as any).network.neighbourhood.knockAll = async () => {
      knocked = true;
      return [];
    };

    const rewrote = await StreamResync.resync({ $tx: { $i: {}, $o: {} } });

    expect(rewrote).to.equal(0);
    expect(knocked).to.equal(false);
  });
});

describe("QuickRestore - adoptDocument (Activerestore)", () => {
  let writes: { docs: any[]; options: any }[];
  let local: { [id: string]: any };

  beforeEach(() => {
    writes = [];
    local = {};
    (Provider as any).database = {
      get: async (id: string) => {
        if (!local[id]) {
          throw { notFound: true };
        }
        return local[id];
      },
      bulkDocs: async (docs: any[], options: any) => {
        writes.push({ docs, options });
        return { ok: true };
      },
    };
  });

  const adopt = (doc: any) => (QuickRestore as any).adoptDocument(doc);

  it("creates a missing document with the network's revision", async () => {
    await adopt({ _id: "stream-a", _rev: "39-246bc890" });

    expect(writes).to.have.length(1);
    expect(writes[0].options).to.deep.equal({ new_edits: false });
  });

  it("repairs a divergent document instead of throwing Revision Mismatch", async () => {
    // A full restore used to send every document in one
    // bulkDocs(new_edits:false) call, which levelme aborts on the first
    // local revision that differs - so a stale node stayed stale
    local["stream-a"] = { _id: "stream-a", _rev: "38-c54a2e1c" };

    await adopt({ _id: "stream-a", _rev: "39-246bc890" });

    expect(writes).to.have.length(1);
    expect(writes[0].options).to.deep.equal({
      new_edits: true,
      force_rev: "39-246bc890",
    });
  });

  it("leaves a document that already matches alone", async () => {
    local["stream-a"] = { _id: "stream-a", _rev: "39-246bc890" };

    await adopt({ _id: "stream-a", _rev: "39-246bc890" });

    expect(writes).to.have.length(0);
  });
});

// The end of the road for the node3 case: restore raised an error
// document, could not fetch the missed transaction's umid from any peer
// ("UMID <x> not found #2"), and then marked the document processed and
// purged it - abandoning the stale stream for good. These assert it now
// falls back to repairing the stream itself.
describe("Interagent - falling back to a stream resync (Activerestore)", () => {
  const streamId =
    "088067b4445fe980865ae3c7fcf20564580abe0ca3f08bf123719c4a75611d1f";

  let processed: { archived: boolean }[];
  let writes: { docs: any[]; options: any }[];
  let local: { [id: string]: any };
  let knocked: string[];

  const errorDocument = {
    _id: "umid-abc:1788895703966",
    code: 950,
    umid: "umid-abc",
    processed: false,
    transaction: { $tx: { $i: {}, $o: { [streamId]: {} } } },
  };

  // Only what processDocument() itself reaches for - the interagent's
  // constructor starts its own polling timer, which has nothing to do
  // with the branch under test
  const context = () => ({
    hasErrorCode: (doc: any) => doc.code === 950,
    verifyUmidNotFound: async () => true,
    insertUmid: async () => {
      throw new Error("must not insert a umid no node holds");
    },
    setProcessed: async (_doc: any, archive: boolean) => {
      processed.push({ archived: !!archive });
    },
    resyncStreams: (Interagent.prototype as any).resyncStreams,
  });

  beforeEach(() => {
    processed = [];
    writes = [];
    knocked = [];
    local = {
      [streamId]: { _id: streamId, _rev: "38-c54a2e1c" },
      [`${streamId}:stream`]: { _id: `${streamId}:stream`, _rev: "20-d89395f3" },
    };

    (Provider as any).neighbourCount = 4;
    (Provider as any).consensusReachedAmount = 60;
    (Provider as any).database = {
      get: async (id: string) => {
        if (!local[id]) {
          throw { notFound: true };
        }
        return local[id];
      },
      bulkDocs: async (docs: any[], options: any) => {
        writes.push({ docs, options });
        return { ok: true };
      },
    };
    (Provider as any).network = {
      neighbourhood: {
        knockAll: async (endpoint: string) => {
          knocked.push(endpoint);

          // No node holds the umid - only nodes that committed do, and
          // this node is asking precisely because it did not
          if (endpoint.indexOf("umid/") === 0) {
            return [{}, {}, {}];
          }

          const agreed = [
            { _id: streamId, _rev: "39-246bc890" },
            { _id: `${streamId}:stream`, _rev: "21-799d345c" },
          ];
          return [agreed, agreed, agreed];
        },
      },
    };
  });

  it("adopts the agreed revision when the umid cannot be fetched", async () => {
    await (Interagent.prototype as any).processDocument.call(
      context(),
      errorDocument
    );

    expect(knocked[0]).to.equal("umid/umid-abc");
    expect(knocked).to.include("stream");

    // Both the state document and its meta document, forced onto the
    // network's revision
    expect(writes).to.have.length(2);
    const byId: { [id: string]: any } = {};
    writes.forEach((w) => (byId[w.docs[0]._id] = w));

    expect(byId[streamId].options).to.deep.equal({
      new_edits: true,
      force_rev: "39-246bc890",
    });
    expect(byId[`${streamId}:stream`].options).to.deep.equal({
      new_edits: true,
      force_rev: "21-799d345c",
    });

    // Archived rather than silently dropped - this one changed state
    expect(processed).to.deep.equal([{ archived: true }]);
  });

  it("still marks the document processed when nothing needed repairing", async () => {
    local[streamId]._rev = "39-246bc890";
    local[`${streamId}:stream`]._rev = "21-799d345c";

    await (Interagent.prototype as any).processDocument.call(
      context(),
      errorDocument
    );

    expect(writes).to.have.length(0);
    expect(processed).to.deep.equal([{ archived: false }]);
  });

  it("does not leave the error document unprocessed when the resync throws", async () => {
    (Provider as any).network.neighbourhood.knockAll = async (
      endpoint: string
    ) => {
      if (endpoint.indexOf("umid/") === 0) {
        return [{}];
      }
      throw new Error("network down");
    };

    await (Interagent.prototype as any).processDocument.call(
      context(),
      errorDocument
    );

    expect(writes).to.have.length(0);
    expect(processed).to.deep.equal([{ archived: false }]);
  });
});
