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

  it("raises 1510 when a per document result carries an error", async () => {
    // CouchDB's shape
    const updater = build([{ id: "streamA", error: "conflict" }]);

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
