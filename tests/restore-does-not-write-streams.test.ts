import { Interagent } from "../packages/restore/src/modules/interagent/interagent";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { expect } from "chai";
import "mocha";

// Restore adds documents this node is missing. It does not overwrite ones
// it has.
//
// That is not caution, it is a correctness requirement. This process talks
// to the store over HTTP and takes no part in the Locker protocol that
// serialises transactions against a stream, so a write from here can land
// on top of a transaction committing on this node at that moment - and
// force_rev checks nothing, so it would do so silently. Correcting a
// divergent stream belongs to SPI, in the network layer, which runs inside
// the transaction's own lifecycle and abstains when any node reports the
// stream locked.
//
// A previous version of this file's subject briefly did reconcile streams
// from here. It also ignored the "locked" markers SPI relies on, so it
// would have voted on a sample taken mid-transaction. These pin the rule.
describe("Interagent - restore never writes stream state (Activerestore)", () => {
  let streamWrites: any[];
  let processed: { archived: boolean }[];

  const context = () => ({
    hasErrorCode: (doc: any) => doc.code === 950,
    verifyUmidNotFound: async () => true,
    insertUmid: async () => undefined,
    setProcessed: async (_doc: any, archive: boolean) => {
      processed.push({ archived: !!archive });
    },
  });

  beforeEach(() => {
    streamWrites = [];
    processed = [];
    (Provider as any).database = {
      get: async () => ({ _id: "stream-a", _rev: "38-c54a2e1c" }),
      bulkDocs: async (docs: any[], options: any) => {
        streamWrites.push({ docs, options });
        return { ok: true };
      },
    };
    (Provider as any).network = {
      neighbourhood: {
        knockAll: async () => {
          throw new Error("restore must not poll peers for stream state");
        },
      },
    };
  });

  const run = (doc: any) =>
    (Interagent.prototype as any).processDocument.call(context(), doc);

  it("records a position error without touching the stream", async () => {
    await run({
      _id: "umid-xyz:1",
      code: 1200,
      umid: "umid-xyz",
      processed: false,
      transaction: { $tx: { $i: {}, $o: { "stream-a": {} } } },
    });

    // Kept, so an operator can see this node disagreed
    expect(processed).to.deep.equal([{ archived: true }]);
    // But nothing written, and no peers polled for a revision to write
    expect(streamWrites).to.have.length(0);
  });

  it("does not write a stream when a missing umid cannot be fetched", async () => {
    (Provider as any).network.neighbourhood.knockAll = async () => [{}, {}, {}];

    await run({
      _id: "umid-abc:1",
      code: 950,
      umid: "umid-abc",
      processed: false,
      transaction: { $tx: { $i: {}, $o: { "stream-a": {} } } },
    });

    expect(streamWrites).to.have.length(0);
  });
});
