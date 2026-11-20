import { expect } from "chai";
import "mocha";
// By package name: the code under test reads build and chain through the built
// lib's ActiveOptions, a different module instance from ../packages/options/src
import { ActiveOptions, ActiveChain } from "@activeledger/activeoptions";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

/**
 * Chain stamping: the entry node says which chain a transaction belongs to
 * (like $origin, from its own configuration, never from the client), and every
 * node stamps the streams it writes with that one value. Off below the
 * stamping build, so a network moves to it together.
 */
describe("Chain stamping", () => {
  let originalBuild: any;
  let originalChain: any;
  let originalDirect: any;
  let captured: any;

  beforeEach(() => {
    originalBuild = ActiveOptions.get("build", 0);
    originalChain = ActiveOptions.get("chain", null);
    originalDirect = Endpoints.DirectInternalInitalise;
    captured = undefined;
    ActiveOptions.set("build", ActiveChain.STAMP_BUILD);
    ActiveOptions.set("chain", { id: 5 });
    (Endpoints as any).DirectInternalInitalise = (_host: any, tx: any) => {
      captured = tx;
      return new Promise(() => undefined);
    };
  });

  afterEach(() => {
    (Endpoints as any).DirectInternalInitalise = originalDirect;
    ActiveOptions.set("build", originalBuild);
    ActiveOptions.set("chain", originalChain);
  });

  describe("the entry node", () => {
    const db: any = { exists: async () => false, get: async () => { throw new Error("not found"); } };
    const host: any = { reference: "entry-node", resentAs: async () => undefined, mayBeStored: () => false, rememberResent: () => undefined };
    const body = (extra: any = {}) => ({
      $tx: { $namespace: "test", $contract: "c", $i: { a: { x: 1 } }, $expire: new Date(Date.now() + 60000).toISOString() },
      $sigs: { a: "sig" },
      ...extra,
    });
    const submit = async (b: any) => {
      Endpoints.ExternalInitalise(host, b, "1.2.3.4", db);
      for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setImmediate(r));
      expect(captured, "transaction reached consensus").to.not.equal(undefined);
      return captured;
    };

    it("sets $chain from its own configuration", async () => {
      expect((await submit(body())).$chain).to.equal(5);
    });

    it("ignores a $chain the client sent", async () => {
      expect((await submit(body({ $chain: 99 }))).$chain).to.equal(5);
    });

    it("drops a client $chain below the stamping build, and sets none", async () => {
      ActiveOptions.set("build", ActiveChain.STAMP_BUILD - 1);
      expect("$chain" in (await submit(body({ $chain: 99 })))).to.equal(false);
    });

    it("sets none when the node has no valid chain configured", async () => {
      ActiveOptions.set("chain", null);
      expect("$chain" in (await submit(body()))).to.equal(false);
    });
  });

  describe("the umid document", () => {
    const entry = (extra: any = {}): any => ({
      $umid: "u", $tx: { $namespace: "n" }, $sigs: {}, $revs: { $i: {}, $o: {} }, $selfsign: false,
      $datetime: "2026-10-23T00:00:00.000Z", $origin: "o", $remoteAddr: "r", ...extra,
    });
    const compact = (e: any) => (StreamUpdater.prototype as any).compactTxEntry.call({ entry: e });

    it("carries $chain, so a replay or a hybrid stamps the same value", () => {
      expect(compact(entry({ $chain: 5 })).$chain).to.equal(5);
    });

    it("is unchanged without $chain, and below the stamping build", () => {
      expect("$chain" in compact(entry())).to.equal(false);
      ActiveOptions.set("build", ActiveChain.STAMP_BUILD - 1);
      expect("$chain" in compact(entry({ $chain: 5 }))).to.equal(false);
    });
  });

  describe("the streams written", () => {
    const run = (entry: any, meta: any) => {
      const self: any = {
        entry: { $umid: "u1", ...entry },
        streams: [{ state: { _id: "s", _rev: "1-a" }, meta, volatile: { _id: "s:volatile", _rev: "1-a" } }],
        docs: [],
        collisions: [],
        refStreams: { updated: [], new: [] },
        shared: { filterPrefix: (id: string) => id, assumedVirtualPrefix: "" },
      };
      (StreamUpdater.prototype as any).buildReferenceStreams.call(self);
      return self.docs.find((d: any) => d._id === "s:stream");
    };
    const stored = (extra: any = {}) => ({ _id: "s:stream", _rev: "1-a", umid: "u0", ...extra });

    it("stamps the meta of a stream it updates", () => {
      expect(run({ $chain: 5 }, stored()).chain).to.equal(5);
    });

    it("stamps the meta of a stream it creates", () => {
      expect(run({ $chain: 5 }, { _id: "s:stream" }).chain).to.equal(5);
    });

    it("never overwrites a chain already there", () => {
      expect(run({ $chain: 5 }, stored({ chain: 7 })).chain).to.equal(7);
    });

    it("stamps nothing without $chain in the entry (an older entry, or below the build)", () => {
      expect("chain" in run({}, stored())).to.equal(false);
    });

    it("stamps nothing below the stamping build, even with $chain in the entry", () => {
      ActiveOptions.set("build", ActiveChain.STAMP_BUILD - 1);
      expect("chain" in run({ $chain: 5 }, stored())).to.equal(false);
    });
  });
});
