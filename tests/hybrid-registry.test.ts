import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
// By package name: the contract reads build and hybrid through the built
// lib's ActiveOptions, a different module instance from ../packages/options/src
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "../packages/crypto/src";
import { Activity } from "../packages/contracts/src/stream";
import Hybrid from "../packages/activeledger/src/contracts/default/hybrid";

// default/hybrid is the supernode registry of hybrids. One stream per key,
// seeded by the keyhash, so the id can be derived from the key alone and no
// registration ever contends for a shared index stream.
describe("Hybrid registry contract (default/hybrid)", () => {
  const umid = "a".repeat(64);
  const kp = new ActiveCrypto.KeyPair("secp256k1");
  const pem = kp.generate(2048, true).pub.pkcs8pem;
  const endpoints = [
    { transport: "p2p", host: "hybrid.example.com", port: 5270 },
    { transport: "http", host: "10.0.0.7", port: 5260 },
  ];

  let originalBuild: any;
  let originalHybrid: any;

  beforeEach(() => {
    originalBuild = ActiveOptions.get("build", 0);
    originalHybrid = ActiveOptions.get("hybrid", undefined);
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", undefined);
  });

  afterEach(() => {
    ActiveOptions.set("build", originalBuild);
    ActiveOptions.set("hybrid", originalHybrid);
  });

  // A contract instance the way the VM builds one
  const contract = (
    $entry: string,
    $i: any,
    inputs: any[] = [],
    sigs: any = {}
  ): Hybrid =>
    new (Hybrid as any)(
      new Date(),
      "127.0.0.1",
      umid,
      { $namespace: "default", $contract: "hybrid", $entry, $i },
      inputs,
      [],
      {},
      {},
      sigs,
      0,
      new EventEmitter(),
      "127.0.0.1:5260"
    );

  const register = (input: any = {}) =>
    contract(
      "register",
      { hybrid: { type: "secp256k1", publicKey: pem, endpoints, ...input } },
      [],
      { hybrid: "sig" }
    );

  const run = async (c: Hybrid, selfsigned: boolean) => {
    await c.verify!(selfsigned);
    await c.vote();
    await c.commit();
    return c;
  };

  // The one registry stream a register writes
  const written = (c: Hybrid): Activity =>
    Object.values(c.getActivityStreams())[0] as Activity;

  // A committed registration, as the next transaction's input
  const registered = async () => {
    const activity = written(await run(register({ label: "edge-1" }), true));
    return {
      state: { ...(activity as any).state, _rev: "1-x" },
      meta: { ...(activity as any).meta, _rev: "1-y" },
    };
  };

  describe("stream id", () => {
    it("is derived from the key alone, and is what register creates", async () => {
      const keyhash = ActiveCrypto.keyHash(pem);
      const name = `activeledger.default.hybrid.${keyhash}`;
      expect(ActiveCrypto.hybridStreamName(pem)).to.equal(name);
      // sha256(seed + name), the Activity derivation, seeded by the keyhash
      expect(ActiveCrypto.hybridStreamId(pem)).to.equal(
        ActiveCrypto.Hash.getHash(keyhash + name, "sha256")
      );

      const activity = written(await run(register(), true));
      expect(activity.getId()).to.equal(ActiveCrypto.hybridStreamId(pem));
      expect((activity as any).meta.name).to.equal(name);
      // Seeded, so streamUpdater rejects a second register as a collision
      expect((activity as any).meta.deterministic).to.equal(true);
    });
  });

  describe("register", () => {
    it("stores the key, endpoints and label, owned and locked", async () => {
      const activity = written(await run(register({ label: "edge-1" }), true));
      const state: any = activity.getState();
      expect(state.type).to.equal(Hybrid.TYPE);
      expect(state.key).to.equal(pem);
      expect(state.keyType).to.equal("secp256k1");
      expect(state.endpoints).to.deep.equal(endpoints);
      expect(state.label).to.equal("edge-1");
      expect(state.retired).to.equal(undefined);

      const meta: any = (activity as any).meta;
      expect(meta.authorities[0].public).to.equal(pem);
      expect(meta.authorities[0].type).to.equal("secp256k1");
      expect(meta.contractlock).to.deep.equal(["hybrid"]);
      expect(meta.namespaceLock).to.deep.equal(["default"]);
    });

    it("leaves the label out when none is given", async () => {
      const state: any = written(await run(register(), true)).getState();
      expect("label" in state).to.equal(false);
    });

    it("must be self signed by the hybrid's key", async () => {
      let error: any;
      await register()
        .verify!(false)
        .catch((e) => (error = e));
      expect(error).to.equal("Must be self signed");
    });

    it("is refused below build 40300", async () => {
      ActiveOptions.set("build", 40200);
      let error: any;
      await register()
        .verify!(true)
        .catch((e) => (error = e));
      expect(error).to.equal("Hybrid registry not enabled");
    });

    const refused = async (c: Hybrid, selfsigned = true) => {
      let error: any;
      await c.verify!(selfsigned).catch((e) => (error = e));
      return error;
    };

    it("rejects bad input", async () => {
      const bad: any[] = [
        { endpoints: [] },
        { endpoints: "p2p://x:1" },
        { endpoints: [{ transport: "ws", host: "a.b", port: 1 }] },
        { endpoints: [{ transport: "p2p", host: "a.b", port: 0 }] },
        { endpoints: [{ transport: "p2p", host: "a.b", port: 65536 }] },
        { endpoints: [{ transport: "p2p", host: "a.b", port: "80" }] },
        { endpoints: [{ transport: "p2p", host: "a.b", port: 1.5 }] },
        { endpoints: [{ transport: "p2p", host: "", port: 1 }] },
        { endpoints: [{ transport: "p2p", host: "a b", port: 1 }] },
        { endpoints: [{ transport: "p2p", host: "-a.b", port: 1 }] },
        { endpoints: [{ transport: "p2p", host: "a.b", port: 1, extra: 1 }] },
        { endpoints: [endpoints[0], endpoints[0]] },
        { endpoints: new Array(9).fill(0).map((_, i) => ({ transport: "p2p", host: "a.b", port: i + 1 })) },
        { label: "" },
        { label: "x".repeat(65) },
        { label: "bad\nlabel" },
        { label: 7 },
        { type: "dsa" },
        { publicKey: "" },
        { publicKey: "-----BEGIN PRIVATE KEY-----" },
        { publicKey: "x".repeat(4097) },
        { unexpected: true },
      ];
      for (const input of bad) {
        expect(await refused(register(input)), JSON.stringify(input)).to.be.a("string");
      }
    });

    it("accepts an IPv6 host and a hostname", async () => {
      const ok = [
        { transport: "p2p", host: "::1", port: 5270 },
        { transport: "http", host: "fe80::1", port: 80 },
        { transport: "http", host: "localhost", port: 8080 },
      ];
      expect(Hybrid.validateEndpoints(ok)).to.equal(null);
    });

    it("wants exactly one input", async () => {
      const c = contract(
        "register",
        {
          a: { type: "secp256k1", publicKey: pem, endpoints },
          b: { type: "secp256k1", publicKey: pem, endpoints },
        },
        [],
        { a: "s", b: "s" }
      );
      expect(await refused(c)).to.equal("Expecting one input");
    });
  });

  describe("admission", () => {
    const vote = async () => {
      const c = register();
      await c.verify!(true);
      let error: any;
      await c.vote().catch((e) => (error = e));
      return error;
    };

    it("is open without a hybrid section", async () => {
      expect(await vote()).to.equal(undefined);
      // The legacy hybrid: [] URL list is not a section either
      ActiveOptions.set("hybrid", []);
      expect(await vote()).to.equal(undefined);
    });

    it("is open when admission is open", async () => {
      ActiveOptions.set("hybrid", { admission: "open" });
      expect(await vote()).to.equal(undefined);
    });

    it("admits a listed key, by key or by keyhash", async () => {
      ActiveOptions.set("hybrid", { admission: { allowlist: [pem] } });
      expect(await vote()).to.equal(undefined);
      ActiveOptions.set("hybrid", {
        admission: { allowlist: [ActiveCrypto.keyHash(pem)] },
      });
      expect(await vote()).to.equal(undefined);
    });

    it("refuses a key not on the allowlist", async () => {
      ActiveOptions.set("hybrid", { admission: { allowlist: ["someone else"] } });
      expect(await vote()).to.equal("Hybrid not admitted");
      ActiveOptions.set("hybrid", { admission: { allowlist: [] } });
      expect(await vote()).to.equal("Hybrid not admitted");
    });

    it("fails closed on an admission it does not understand", async () => {
      ActiveOptions.set("hybrid", { admission: "closed" });
      expect(await vote()).to.equal("Hybrid not admitted");
    });
  });

  describe("update and retire", () => {
    const id = () => ActiveCrypto.hybridStreamId(pem);

    it("update changes only the endpoints", async () => {
      const stream = await registered();
      const next = [{ transport: "p2p", host: "new.example.com", port: 6000 }];
      const c = contract("update", { [id()]: { endpoints: next } }, [stream], {
        [id()]: "sig",
      });
      await run(c, false);
      const state: any = c.getActivityStreams(id()).getState();
      expect(state.endpoints).to.deep.equal(next);
      expect(state.key).to.equal(pem);
      expect(state.label).to.equal("edge-1");
    });

    it("update validates the endpoints and wants the hybrid's signature", async () => {
      const stream = await registered();
      let error: any;
      await contract("update", { [id()]: { endpoints: [] } }, [stream])
        .verify!(false)
        .catch((e) => (error = e));
      expect(error).to.be.a("string");

      error = undefined;
      await contract("update", { [id()]: { endpoints } }, [stream])
        .verify!(true)
        .catch((e) => (error = e));
      expect(error).to.equal("Must be signed by the hybrid");
    });

    it("retire marks the registration retired, and it then stays retired", async () => {
      const stream = await registered();
      const c = contract("retire", { [id()]: {} }, [stream], { [id()]: "sig" });
      await run(c, false);
      const activity: any = c.getActivityStreams(id());
      expect(activity.getState().retired).to.equal(true);

      // Nothing more can be done with it
      const after = {
        state: { ...activity.state, _rev: "2-x" },
        meta: stream.meta,
      };
      const again = contract("update", { [id()]: { endpoints } }, [after], {
        [id()]: "sig",
      });
      await again.verify!(false);
      let error: any;
      await again.vote().catch((e) => (error = e));
      expect(error).to.equal("Hybrid retired");
    });

    it("refuses a stream that is not a registration", async () => {
      const other = {
        state: { _id: "b".repeat(64), _rev: "1-x", type: Hybrid.TYPE, key: pem },
        meta: { _id: "b".repeat(64) + ":stream", _rev: "1-y" },
      };
      const c = contract("retire", { ["b".repeat(64)]: {} }, [other], {
        ["b".repeat(64)]: "sig",
      });
      await c.verify!(false);
      let error: any;
      await c.vote().catch((e) => (error = e));
      expect(error).to.equal("Not a hybrid registration");
    });
  });
});
