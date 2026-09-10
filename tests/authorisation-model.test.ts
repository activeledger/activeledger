import { PermissionsChecker } from "../packages/protocol/src/protocol/permissionsChecker";
import { Shared } from "../packages/protocol/src/protocol/shared";
import { ActiveCrypto } from "../packages/crypto/src";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";

/**
 * The authorisation model, written down as executable fact.
 *
 * These properties decide who may write to a stream, and until now nothing
 * asserted any of them - they lived only in the source and in whoever had
 * last read it. That is expensive, because the model is not what most
 * people assume:
 *
 *   - Inputs are always signature-checked against the stream's own
 *     authorities.
 *   - OUTPUTS ARE NOT, unless security.signedOutputs is switched on, and
 *     it is absent from the shipped config, so it is off.
 *   - There is no engine-level gate on who may invoke a contract entry.
 *     Authorisation past this point is whatever the contract checks.
 *
 * That combination is load-bearing: a contract writing to an existing
 * stream it names in $o gets no authority check from the engine by
 * default, so the contract is the only thing standing between a caller and
 * someone else's stream. A refactor that changed any of this silently
 * would be a serious security regression, and these tests exist so it
 * cannot happen quietly.
 *
 * They deliberately do NOT assert that the current defaults are the right
 * ones - only that they are what they are. Changing them should be a
 * decision someone makes on purpose, and updating a test here is how that
 * decision gets recorded.
 */

const STREAM = "5c1f9d3a7b2e4c6d8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f506";

/** Real keys - a stubbed signature check would prove nothing here. */
function keys() {
  const kp = new ActiveCrypto.KeyPair("rsa");
  const generated = kp.generate();
  return { kp, pub: generated.pub.pkcs8pem };
}

const owner = keys();
const stranger = keys();

/** A stream whose only authority is `owner`. */
function streamDocs(rev = "1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
  return [
    { doc: { _id: STREAM, _rev: rev, balance: 10 } },
    {
      doc: {
        _id: `${STREAM}:stream`,
        _rev: rev,
        authorities: [{ public: owner.pub, type: "rsa", hash: "" }],
      },
    },
  ];
}

function makeChecker(entry: any, security: Partial<any> = {}, rows = streamDocs()) {
  const db: any = { allDocs: async () => ({ rows }) };
  const shared = new Shared(false, entry, db, null as any);
  const securityCache: any = {
    namespace: {},
    hardenedKeys: false,
    // Absent in the shipped config, so undefined is the honest default
    signedOutputs: undefined,
    ...security,
  };
  return new PermissionsChecker(entry, db, securityCache, shared);
}

/** A transaction touching STREAM, signed by whoever is given. */
function entryFor(signer: { kp: any }, io: "$i" | "$o") {
  const tx = {
    $namespace: "test",
    $contract: "transfer",
    $i: io === "$i" ? { [STREAM]: { amount: 1 } } : {},
    $o: io === "$o" ? { [STREAM]: { amount: 1 } } : {},
  };
  return {
    $umid: "umid-under-test",
    $tx: tx,
    $sigs: { [STREAM]: signer.kp.sign(tx) },
    $revs: { $i: {}, $o: {} },
    $nodes: {},
  } as any;
}

describe("Authorisation model (Activeprotocol)", () => {
  describe("inputs are always checked", () => {
    it("accepts a signature from one of the stream's authorities", async () => {
      const entry = entryFor(owner, "$i");
      const streams = await makeChecker(entry).process([STREAM], true);

      expect(streams).to.have.length(1);
      expect(streams[0].state._id).to.equal(STREAM);
    });

    it("rejects a signature from a key the stream does not authorise", async () => {
      const entry = entryFor(stranger, "$i");

      let rejection: any;
      try {
        await makeChecker(entry).process([STREAM], true);
      } catch (e) {
        rejection = e;
      }

      expect(rejection, "a stranger's signature must not pass").to.not.equal(undefined);
      expect(rejection.code).to.equal(1220);
      expect(rejection.reason).to.contain("Input Signature Incorrect");
    });

    it("rejects even when signedOutputs is on - inputs never depend on that flag", async () => {
      const entry = entryFor(stranger, "$i");

      let rejection: any;
      try {
        await makeChecker(entry, { signedOutputs: true }).process([STREAM], true);
      } catch (e) {
        rejection = e;
      }

      expect(rejection?.code).to.equal(1220);
    });
  });

  describe("outputs are NOT checked by default", () => {
    it("accepts a stranger's signature on an output stream", async () => {
      // This is the property most people get wrong, and the reason a
      // contract using $selfsign with an $o pointing at an existing stream
      // has no engine-level protection at all. It is asserted here so that
      // it is visible, not because it is desirable.
      const entry = entryFor(stranger, "$o");

      const streams = await makeChecker(entry).process([STREAM], false);

      expect(streams).to.have.length(1);
      expect(streams[0].state._id).to.equal(STREAM);
    });

    it("accepts an output with no signature at all", async () => {
      const entry = entryFor(owner, "$o");
      delete entry.$sigs[STREAM];

      const streams = await makeChecker(entry).process([STREAM], false);

      expect(streams).to.have.length(1);
    });

    it("but DOES check them once signedOutputs is switched on", async () => {
      // The systemic fix for the above. It is network-wide, and it will
      // start rejecting any existing contract that writes to an output it
      // holds no authority over - which is why it is not simply flipped.
      const entry = entryFor(stranger, "$o");

      let rejection: any;
      try {
        await makeChecker(entry, { signedOutputs: true }).process([STREAM], false);
      } catch (e) {
        rejection = e;
      }

      expect(rejection, "signedOutputs must actually gate this").to.not.equal(undefined);
      expect(rejection.code).to.equal(1220);
      expect(rejection.reason).to.contain("Output Signature Incorrect");
    });

    it("accepts the rightful owner on an output whether the flag is on or off", async () => {
      for (const signedOutputs of [undefined, true]) {
        const entry = entryFor(owner, "$o");
        const streams = await makeChecker(entry, { signedOutputs }).process([STREAM], false);
        expect(streams, `signedOutputs=${signedOutputs}`).to.have.length(1);
      }
    });
  });

  describe("the revision check is separate from the signature check", () => {
    it("rejects a stale input revision even with a valid signature", async () => {
      const entry = entryFor(owner, "$i");
      entry.$revs.$i[STREAM] = "9-somethingelse:9-somethingelse";

      let rejection: any;
      try {
        await makeChecker(entry).process([STREAM], true);
      } catch (e) {
        rejection = e;
      }

      expect(rejection?.code).to.equal(1200);
      expect(rejection.reason).to.contain("Position Incorrect");
    });

    it("rejects a stale OUTPUT revision, even though the signature is not checked", async () => {
      // Position is the one thing outputs are always held to. It is what
      // makes SPI's whole model work, and it is why a diverged node vetoes
      // every later transaction touching the stream.
      const entry = entryFor(stranger, "$o");
      entry.$revs.$o[STREAM] = "9-somethingelse:9-somethingelse";

      let rejection: any;
      try {
        await makeChecker(entry).process([STREAM], false);
      } catch (e) {
        rejection = e;
      }

      expect(rejection?.code).to.equal(1200);
      expect(rejection.reason).to.contain("Output Stream Position Incorrect");
    });

    it("records the revision when the transaction did not carry one", async () => {
      const entry = entryFor(owner, "$i");
      await makeChecker(entry).process([STREAM], true);

      expect(entry.$revs.$i[STREAM]).to.be.a("string");
      expect(entry.$revs.$i[STREAM]).to.contain("-");
    });
  });

  describe("the shipped defaults", () => {
    const defaults = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../packages/activeledger/src/default.config.json"),
        "utf8"
      )
    );

    it("does not enable signedOutputs", () => {
      // Not merely false - the key is absent, so nobody turns it on by
      // accident and nobody reading the file assumes it is handled.
      // If this test fails because someone added it, that is a real
      // decision and this expectation should be updated deliberately.
      expect(defaults.security).to.not.have.property("signedOutputs");
    });

    it("does not enable hardenedKeys", () => {
      expect(defaults.security.hardenedKeys).to.equal(false);
    });

    it("still has a security block at all", () => {
      // A missing block would make every flag undefined by accident rather
      // than by choice, which is a different thing to reason about.
      expect(defaults.security).to.be.an("object");
    });
  });
});
