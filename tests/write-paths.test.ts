import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";
import { QuickRestore } from "../packages/restore/src/modules/quick-restore/quick-restore";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { expect } from "chai";
import "mocha";

// The two places that write to a store outside the ordinary commit, and the
// commit's own guard that the write landed. All three were untested.
//
// They matter together because they are the same shape as the incidents
// this codebase keeps producing: a function that reports success without
// checking its effect. A failed write that reads as a commit leaves a node
// silently behind the network, which is the state every SPI and restore
// path exists to clean up afterwards.

// Retries keep their real attempt count but not their real pauses
let retryDelays: number[];
before(() => {
  retryDelays = (StreamUpdater as any).SAVE_RETRY_DELAYS_MS;
  (StreamUpdater as any).SAVE_RETRY_DELAYS_MS = [0, 0, 0];
});
after(() => {
  (StreamUpdater as any).SAVE_RETRY_DELAYS_MS = retryDelays;
});

describe("StreamUpdater.append - a failed write must not read as a commit", () => {
  let raised: { code: number; reason: any }[];
  let eventsWritten: any[];

  const build = (bulkDocsResult: any) => {
    raised = [];
    eventsWritten = [];

    const updater = Object.create(StreamUpdater.prototype);
    (updater as any).docs = [{ _id: "streamA", _rev: "1-abc" }];
    (updater as any).entry = {
      $umid: "umid-1",
      $datetime: new Date(),
      $territoriality: "",
    };
    (updater as any).nodeResponse = {};
    (updater as any).db = { bulkDocs: async () => bulkDocsResult };
    (updater as any).dbev = {
      post: async (doc: any) => {
        eventsWritten.push(doc);
      },
    };
    (updater as any).shared = {
      raiseLedgerError: (code: number, reason: any) => {
        raised.push({ code, reason });
      },
    };
    // Only reached once the write succeeds - append() carries on into the
    // response-building tail, which is not what these assert
    (updater as any).reference = "self";
    (updater as any).contractId = "contract";
    (updater as any).refStreams = { new: [], updated: [] };
    (updater as any).virtualMachine = {
      getReturnContractData: () => undefined,
      getNewContractData: () => undefined,
      postProcess: async () => undefined,
    };
    (updater as any).emitter = { emit: () => true };
    return updater;
  };

  it("raises 1510 when the store answers { ok: false }", async () => {
    // The self hosted store's shape for a failed batch write. It is a
    // truthy object, so a plain falsy check lets it through - which is
    // exactly what it used to do.
    const updater = build({ ok: false });

    await (updater as any).append();

    expect(raised.map((r) => r.code)).to.deep.equal([1510]);
  });

  it("raises 1510 when LevelMe answers false", async () => {
    // The other failure shape: LevelMe.bulkDocs catches its own batch
    // write error and returns false rather than throwing
    const updater = build(false);

    await (updater as any).append();

    expect(raised.map((r) => r.code)).to.deep.equal([1510]);
  });

  it("does not record the transaction in the event stream when the write failed", async () => {
    // The part that makes a silent failure durable: an event written for a
    // transaction whose streams never landed tells every subscriber the
    // change happened
    const updater = build({ ok: false });

    await (updater as any).append();

    expect(eventsWritten).to.have.length(0);
  });

  it("records the transaction when the write really succeeded", async () => {
    const updater = build({ ok: true });

    await (updater as any).append();

    expect(raised).to.have.length(0);
    expect(eventsWritten).to.have.length(1);
    expect(eventsWritten[0]._id).to.contain("umid-1");
  });
});

// A node that voted yes and then failed only to save leaves the network
// split - twice on a loaded 4 node testnet, 2-2, which SPI cannot resolve
// because neither side is a majority. The save is retried before 1510 is
// raised, so a moment of store pressure does not cost the node the round.
describe("StreamUpdater.append - a failed save is retried before 1510", () => {
  let raised: { code: number; reason: any }[];
  let eventsWritten: any[];
  let calls: any[][];

  // Each attempt takes the next answer in turn; an Error is thrown
  const build = (answers: any[]) => {
    raised = [];
    eventsWritten = [];
    calls = [];

    const updater = Object.create(StreamUpdater.prototype);
    (updater as any).docs = [
      { _id: "streamA", _rev: "1-abc" },
      { _id: "streamA:stream", _rev: "1-def" },
    ];
    (updater as any).entry = {
      $umid: "umid-1",
      $datetime: new Date(),
      $territoriality: "",
    };
    (updater as any).nodeResponse = {};
    (updater as any).db = {
      bulkDocs: async (docs: any[]) => {
        calls.push(docs.map((d) => d._id));
        const answer = answers[calls.length - 1];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    (updater as any).dbev = {
      post: async (doc: any) => {
        eventsWritten.push(doc);
      },
    };
    (updater as any).shared = {
      raiseLedgerError: (code: number, reason: any) => {
        raised.push({ code, reason });
      },
    };
    (updater as any).reference = "self";
    (updater as any).contractId = "contract";
    (updater as any).refStreams = { new: [], updated: [] };
    (updater as any).virtualMachine = {
      getReturnContractData: () => undefined,
      getNewContractData: () => undefined,
      postProcess: async () => undefined,
    };
    (updater as any).emitter = { emit: () => true };
    return updater;
  };

  it("commits when a failed batch write succeeds on retry", async () => {
    const updater = build([{ ok: false }, { ok: true }]);

    await (updater as any).append();

    expect(raised).to.have.length(0);
    expect(calls).to.have.length(2);
    expect(eventsWritten).to.have.length(1);
  });

  it("commits when a transport failure succeeds on retry", async () => {
    // ActiveRequest.send() reports a dead socket as a null body
    const updater = build([null, { ok: true }]);

    await (updater as any).append();

    expect(raised).to.have.length(0);
    expect(calls).to.have.length(2);
  });

  it("commits when a thrown store error succeeds on retry", async () => {
    const updater = build([new Error("ECONNRESET"), { ok: true }]);

    await (updater as any).append();

    expect(raised).to.have.length(0);
    expect(calls).to.have.length(2);
  });

  it("raises 1510 once every attempt has failed", async () => {
    const updater = build([{ ok: false }, false, null, {}]);

    await (updater as any).append();

    expect(calls).to.have.length(4);
    expect(raised.map((r) => r.code)).to.deep.equal([1510]);
    expect(eventsWritten).to.have.length(0);
  });

  it("does not take an exception inside the store for a save", async () => {
    // httpd answers a thrown Error as a 500 whose body is JSON.stringify
    // of it - {} - and ActiveRequest ignores the status, so {} is what
    // bulkDocs resolves. It used to read as a commit.
    const updater = build([{}, {}, {}, {}]);

    await (updater as any).append();

    expect(calls).to.have.length(4);
    expect(raised.map((r) => r.code)).to.deep.equal([1510]);
    expect(eventsWritten).to.have.length(0);
  });

  it("does not take an error answer for a save", async () => {
    const updater = build([{ error: "x", reason: "y" }, { ok: true }]);

    await (updater as any).append();

    expect(calls).to.have.length(2);
    expect(raised).to.have.length(0);
  });
});

// The only place besides SPI that repairs a divergent stream. Each branch
// picks a different write mode, and picking the wrong one does not fail -
// it writes the wrong revision.
describe("QuickRestore.adoptDocument - restoring a stream", () => {
  let writes: { docs: any[]; options: any }[];
  let local: { [id: string]: any };

  const adopt = (doc: any) => (QuickRestore as any).adoptDocument(doc);

  beforeEach(() => {
    writes = [];
    local = {};
    (Provider as any).database = {
      get: async (id: string) => {
        if (!local[id]) throw { notFound: true };
        return local[id];
      },
      bulkDocs: async (docs: any[], options: any) => {
        writes.push({ docs, options });
        return { ok: true };
      },
    };
  });

  it("creates a missing document with new_edits:false, keeping the network's revision", async () => {
    // new_edits:true here would mint a fresh 1-<md5> and leave this node
    // claiming position 1 for a stream the network holds at 39 - silently
    // re-diverging the thing the restore was fixing
    await adopt({ _id: "streamA", _rev: "39-network" });

    expect(writes).to.have.length(1);
    expect(writes[0].options).to.deep.equal({ new_edits: false });
    expect(writes[0].docs[0]._rev).to.equal("39-network");
  });

  it("overwrites a stale document with new_edits + force_rev", async () => {
    // new_edits:false against a differing local revision throws Revision
    // Mismatch, so this is the only combination that can repair
    local["streamA"] = { _id: "streamA", _rev: "38-stale" };

    await adopt({ _id: "streamA", _rev: "39-network" });

    expect(writes).to.have.length(1);
    expect(writes[0].options).to.deep.equal({
      new_edits: true,
      force_rev: "39-network",
    });
  });

  it("writes nothing when this node already agrees", async () => {
    local["streamA"] = { _id: "streamA", _rev: "39-network" };

    await adopt({ _id: "streamA", _rev: "39-network" });

    expect(writes).to.have.length(0);
  });
});
