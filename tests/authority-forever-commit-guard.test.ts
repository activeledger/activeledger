import { expect } from "chai";
import "mocha";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

// The setter guards in stream.ts can be walked around: getAuthorities()
// returns the live array and setState() sets updatedMeta, so a contract
// can mutate an authority in place and have it harvested and committed
// without any setter running. This is the check that sees the final
// state whatever route it took.
describe("Commit guard: every stream keeps a permanent authority (Activeprotocol)", () => {
  const FUTURE = "2099-01-01T00:00:00.000Z";

  const build = (authorities: any) => {
    const raised: any[] = [];
    const written: any[] = [];

    const updater: any = Object.create(StreamUpdater.prototype);
    updater.entry = { $umid: "u".repeat(64), $datetime: "2026-06-01T12:00:00.000Z", $tx: {} };
    // _rev present so buildReferenceStreams takes the "updated stream"
    // branch rather than the new-stream one, which expects a fuller
    // fixture. The guard runs before either, so this only matters for
    // the cases that are expected to PASS the guard and carry on.
    const meta: any = { _id: "streamA:stream", _rev: "1-a", umid: "prev" };
    if (authorities !== null) meta.authorities = authorities;

    updater.streams = [
      { state: { _id: "streamA", _rev: "1-a" }, meta, volatile: { _id: "streamA:volatile", _rev: "1-a" } },
    ];
    updater.docs = [];
    updater.refStreams = { new: [], updated: [] };
    updater.shared = {
      raiseLedgerError: (code: number, error: Error) => raised.push({ code, message: error.message }),
      filterPrefix: (id: string) => id,
      assumedVirtualPrefix: "",
    };
    updater.virtualMachine = { getEvents: () => [] };
    updater.detectCollisions = async () => undefined;

    return { updater, raised, written };
  };

  it("permits a stream with a permanent authority", async () => {
    const { updater, raised } = build([{ public: "p", type: "rsa", stake: 100, hash: "h" }]);
    await updater.processStreams();
    expect(raised).to.have.length(0);
  });

  it("rejects when every authority carries an expire", async () => {
    const { updater, raised } = build([
      { public: "p", type: "rsa", stake: 100, hash: "h", expire: FUTURE },
    ]);
    await updater.processStreams();
    expect(raised).to.have.length(1);
    expect(raised[0].code).to.equal(1236);
  });

  it("writes nothing when it rejects", async () => {
    const { updater, raised } = build([
      { public: "p", type: "rsa", stake: 100, hash: "h", expire: FUTURE },
    ]);
    await updater.processStreams();
    expect(raised).to.have.length(1);
    expect(updater.docs).to.have.length(0);
  });

  // The path the setter guards cannot see.
  it("catches an in-place mutation that bypassed the setters", async () => {
    const { updater, raised } = build([{ public: "p", type: "rsa", stake: 100, hash: "h" }]);
    updater.streams[0].meta.authorities[0].expire = FUTURE;
    await updater.processStreams();
    expect(raised[0].code).to.equal(1236);
  });

  // Must not fire on the many streams that have no authorities at all.
  it("permits a stream with no authorities field", async () => {
    const { updater, raised } = build(null);
    await updater.processStreams();
    expect(raised).to.have.length(0);
  });

  it("permits a stream with an empty authorities array", async () => {
    const { updater, raised } = build([]);
    await updater.processStreams();
    expect(raised).to.have.length(0);
  });
});
