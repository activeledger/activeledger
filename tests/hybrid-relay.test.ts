import { expect } from "chai";
import "mocha";
// By package name: endpoints and streamUpdater read build through the built
// lib's ActiveOptions, a different module instance from ../packages/options/src
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "../packages/crypto/src";
import { Endpoints } from "../packages/network/src/network/endpoints";
import { StreamUpdater } from "../packages/protocol/src/protocol/streamUpdater";

// A hybrid forwards a user's transaction with $relay: {key, sig}, sig being
// its signature over $umid. The entry supernode keeps $relay out of the umid
// hash, verifies it against the registry, and keeps or drops it before the
// transaction goes anywhere else.
describe("Relayed transactions ($relay)", () => {
  const kp = new ActiveCrypto.KeyPair("secp256k1");
  const pem = kp.generate(2048, true).pub.pkcs8pem;
  const registryId = ActiveCrypto.hybridStreamId(pem);
  const originUmid = "e".repeat(64);

  let docs: { [id: string]: any };
  let captured: any;
  let originalDirect: any;
  let originalBuild: any;

  // Just enough of a datastore for ExternalInitalise and verifyRelay
  const db: any = {
    exists: async (id: string) => !!docs[id],
    get: async (id: string) => {
      if (!docs[id]) throw new Error("not found");
      return docs[id];
    },
  };
  const host: any = { reference: "entry-node" };

  const register = (state: any = {}, contract = "hybrid") => {
    docs[registryId] = {
      _id: registryId,
      type: "default.activeledger.hybrid",
      key: pem,
      keyType: "secp256k1",
      endpoints: [{ transport: "p2p", host: "h.example", port: 5270 }],
      ...state,
    };
    docs[`${registryId}:stream`] = { _id: `${registryId}:stream`, origin: originUmid };
    docs[`${originUmid}:umid`] = {
      umid: { $tx: { $namespace: "default", $contract: contract } },
    };
  };

  beforeEach(() => {
    docs = {};
    captured = undefined;
    originalBuild = ActiveOptions.get("build", 0);
    ActiveOptions.set("build", 40300);
    // Stop at the hand-off to consensus and keep what would be sent
    originalDirect = Endpoints.DirectInternalInitalise;
    (Endpoints as any).DirectInternalInitalise = (_host: any, tx: any) => {
      captured = tx;
      return new Promise(() => undefined);
    };
  });

  afterEach(() => {
    (Endpoints as any).DirectInternalInitalise = originalDirect;
    ActiveOptions.set("build", originalBuild);
  });

  const body = () => ({
    $tx: {
      $namespace: "test",
      $contract: "c",
      $i: { a: { x: 1 } },
      $expire: new Date(Date.now() + 60000).toISOString(),
    },
    $sigs: { a: "sig" },
  });

  // What a hybrid computes before forwarding: the hash of the body it got
  const umidOf = (b: any) => ActiveCrypto.Hash.getHash(JSON.stringify(b));

  const submit = async (b: any) => {
    Endpoints.ExternalInitalise(host, b, "1.2.3.4", db);
    for (let i = 0; i < 50 && !captured; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(captured, "transaction reached consensus").to.not.equal(undefined);
    const tx = captured;
    captured = undefined;
    return tx;
  };

  const relayed = (b: any, sig?: string) => ({
    ...b,
    $relay: { key: pem, sig: sig ?? kp.sign(umidOf(b)) },
  });

  it("keeps $relay out of $umid: same umid with or without it ($expire set)", async () => {
    register();
    const b = body();
    const plain = await submit(JSON.parse(JSON.stringify(b)));
    const viaHybrid = await submit(relayed(JSON.parse(JSON.stringify(b))));
    expect(viaHybrid.$umid).to.equal(plain.$umid);
    // ...and it is what the hybrid computed and signed before forwarding
    expect(plain.$umid).to.equal(umidOf(b));
  });

  it("re-attaches a valid $relay beside $origin and $remoteAddr", async () => {
    register();
    const b = body();
    const tx = await submit(relayed(b));
    expect(tx.$relay).to.deep.equal({ key: pem, sig: tx.$relay.sig });
    expect(tx.$origin).to.equal("entry-node");
    expect(tx.$remoteAddr).to.equal("1.2.3.4");
  });

  it("keeps only key and sig", async () => {
    register();
    const b = body();
    const r: any = relayed(b);
    r.$relay.extra = "x";
    const tx = await submit(r);
    expect(Object.keys(tx.$relay)).to.deep.equal(["key", "sig"]);
  });

  it("drops $relay silently when the signature is not over $umid", async () => {
    register();
    const tx = await submit(relayed(body(), kp.sign("something else")));
    expect("$relay" in tx).to.equal(false);
  });

  it("drops $relay for an unregistered key", async () => {
    const tx = await submit(relayed(body()));
    expect("$relay" in tx).to.equal(false);
  });

  it("drops $relay for a retired hybrid", async () => {
    register({ retired: true });
    const tx = await submit(relayed(body()));
    expect("$relay" in tx).to.equal(false);
  });

  it("drops $relay when the registry stream was not made by default/hybrid", async () => {
    register({}, "squatter");
    const tx = await submit(relayed(body()));
    expect("$relay" in tx).to.equal(false);
  });

  it("drops $relay for a malformed claim", async () => {
    register();
    for (const $relay of [null, "x", { key: pem }, { key: 1, sig: "s" }]) {
      const tx = await submit({ ...body(), $relay });
      expect("$relay" in tx).to.equal(false);
    }
  });

  it("drops $relay below build 40300, umid unchanged", async () => {
    register();
    ActiveOptions.set("build", 40200);
    const b = body();
    const tx = await submit(relayed(b));
    expect("$relay" in tx).to.equal(false);
    expect(tx.$umid).to.equal(umidOf(b));
  });

  describe("compactTxEntry (the :umid doc)", () => {
    const entry = (extra: any = {}) => ({
      $umid: "u",
      $tx: { $namespace: "n" },
      $sigs: {},
      $revs: { $i: {}, $o: {} },
      $selfsign: false,
      $datetime: "2026-10-23T00:00:00.000Z",
      $nodes: { other: { vote: true } },
      $origin: "o",
      $remoteAddr: "r",
      ...extra,
    });
    const compact = (e: any) =>
      (StreamUpdater.prototype as any).compactTxEntry.call({ entry: e });

    it("is byte-identical to before when there is no $relay", () => {
      const doc = compact(entry());
      expect(JSON.stringify(doc)).to.equal(
        JSON.stringify({
          $umid: "u",
          $tx: { $namespace: "n" },
          $sigs: {},
          $revs: { $i: {}, $o: {} },
          $selfsign: false,
          $datetime: "2026-10-23T00:00:00.000Z",
          $origin: "o",
          $remoteAddr: "r",
        })
      );
      expect("$relay" in doc).to.equal(false);
    });

    it("carries $relay next to $origin and $remoteAddr", () => {
      const doc = compact(entry({ $relay: { key: "k", sig: "s" } }));
      expect(doc.$relay).to.deep.equal({ key: "k", sig: "s" });
      expect(Object.keys(doc).slice(-3)).to.deep.equal([
        "$origin",
        "$remoteAddr",
        "$relay",
      ]);
    });

    it("leaves $relay out below build 40300", () => {
      ActiveOptions.set("build", 40200);
      const doc = compact(entry({ $relay: { key: "k", sig: "s" } }));
      expect("$relay" in doc).to.equal(false);
    });
  });
});
