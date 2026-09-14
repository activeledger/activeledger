import { Shared } from "../packages/protocol/src/protocol/shared";
import { ActiveCrypto } from "../packages/crypto/src";
// shared.ts imports this via the "@activeledger/activeoptions" alias,
// which only resolves from *within* a package's own node_modules (each
// package gets its own local symlink - e.g.
// packages/protocol/node_modules/@activeledger/activeoptions ->
// packages/options); there's no such symlink at the repo root where this
// test file lives, so the alias itself doesn't resolve here. Importing the
// exact same resolved file directly (packages/options/lib/index.js, the
// built output the alias points at) keeps this the same module instance -
// and therefore the same static ActiveCacheManager.caches registry -
// without needing the alias to resolve.
import { ActiveCacheManager } from "../packages/options/lib";
import { expect } from "chai";
import "mocha";

// Regression coverage for the hpe-14 fix (64d6f0f) that made the hpe-12
// KeyPair.verify() parsed-key cache actually reachable. Shared.signatureCheck()
// used to construct a fresh KeyPair on every call, so that cache never
// engaged; this now reuses a cached KeyPair instance per (type, publicKey).
describe("Shared.signatureCheck() - hpe-14 regression (64d6f0f)", () => {
  it("validates a correct signature against the matching public key", () => {
    const txBody = { $namespace: "default", $contract: "onboard", hello: "world" };
    const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);

    const kp = new ActiveCrypto.KeyPair("rsa");
    const keys = kp.generate();
    const sig = kp.sign(txBody);

    expect(shared.signatureCheck(keys.pub.pkcs8pem, sig, "rsa")).to.equal(true);
  });

  it("rejects a signature checked against the wrong public key", () => {
    const txBody = { $namespace: "default", $contract: "onboard", hello: "world" };
    const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);

    const kpA = new ActiveCrypto.KeyPair("rsa");
    const keysA = kpA.generate();
    const sigA = kpA.sign(txBody);

    const kpB = new ActiveCrypto.KeyPair("rsa");
    const keysB = kpB.generate();

    expect(shared.signatureCheck(keysB.pub.pkcs8pem, sigA, "rsa")).to.equal(false);
  });

  it("rejects a tampered signature", () => {
    const txBody = { $namespace: "default", $contract: "onboard", hello: "world" };
    const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);

    const kp = new ActiveCrypto.KeyPair("rsa");
    const keys = kp.generate();
    const sig = kp.sign(txBody);
    const tampered = sig.slice(0, -4) + (sig.slice(-4) === "abcd" ? "dcba" : "abcd");

    expect(shared.signatureCheck(keys.pub.pkcs8pem, tampered, "rsa")).to.equal(false);
  });

  it("still validates correctly across many repeated calls with the same key (cache reuse)", () => {
    const txBody = { $namespace: "default", $contract: "onboard", hello: "world" };
    const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);

    const kp = new ActiveCrypto.KeyPair("rsa");
    const keys = kp.generate();
    const sig = kp.sign(txBody);

    for (let i = 0; i < 20; i++) {
      expect(shared.signatureCheck(keys.pub.pkcs8pem, sig, "rsa")).to.equal(true);
    }
  });

  it("caches by the raw key material (type + public key), not by any caller-supplied identity", () => {
    // The whole point of this cache: signatureCheck() never receives a
    // streamId/identity at all, only (publicKey, signature, type) - see
    // permissionsChecker.ts's call sites. Two distinct keys used against
    // the same Shared instance must produce two distinct, independently
    // correct cache entries, never conflated.
    const txBody = { $namespace: "default", $contract: "onboard", hello: "world" };
    const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);

    const kpA = new ActiveCrypto.KeyPair("rsa");
    const keysA = kpA.generate();
    const sigA = kpA.sign(txBody);

    const kpB = new ActiveCrypto.KeyPair("rsa");
    const keysB = kpB.generate();
    const sigB = kpB.sign(txBody);

    expect(shared.signatureCheck(keysA.pub.pkcs8pem, sigA, "rsa")).to.equal(true);
    expect(shared.signatureCheck(keysB.pub.pkcs8pem, sigB, "rsa")).to.equal(true);
    // Cross-checking after both are cached still correctly fails.
    expect(shared.signatureCheck(keysA.pub.pkcs8pem, sigB, "rsa")).to.equal(false);
    expect(shared.signatureCheck(keysB.pub.pkcs8pem, sigA, "rsa")).to.equal(false);

    const cache = ActiveCacheManager.fetch("verifyKeys", 30000);
    expect(cache.size()).to.be.at.least(2);
  });
});

/**
 * The post-quantum types at the chokepoint the protocol actually calls.
 *
 * permissionsChecker and the $selfsign path both reach KeyPair only through
 * Shared.signatureCheck(publicKey, signature, type), so this is where a
 * post-quantum identity is either a first-class citizen or is not. The
 * KeyPair tests prove the algorithms; these prove the wiring, including the
 * per-type key cache that sits in between.
 */
describe("Shared.signatureCheck() - post-quantum types", () => {
  const PQ = ["ml-dsa-65", "falcon-512"];

  for (const type of PQ) {
    it(`accepts a valid ${type} signature`, () => {
      const txBody = { $namespace: "default", $contract: "transfer", $i: { alice: {} } };
      const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = kp.generate();
      expect(shared.signatureCheck(keys.pub.pkcs8pem, kp.sign(txBody), type)).to.equal(true);
    });

    it(`rejects another identity's ${type} signature`, () => {
      const txBody = { $i: { alice: {} } };
      const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);
      const a = new ActiveCrypto.KeyPair(type); a.generate();
      const b = new ActiveCrypto.KeyPair(type); const keysB = b.generate();
      expect(shared.signatureCheck(keysB.pub.pkcs8pem, a.sign(txBody), type)).to.equal(false);
    });

    it(`rejects a ${type} signature over a different transaction`, () => {
      const signed = { $i: { alice: { amount: "100" } } };
      const checked = { $i: { alice: { amount: "999" } } };
      const shared = new Shared(false, { $tx: checked } as any, {} as any, {} as any);
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = kp.generate();
      expect(shared.signatureCheck(keys.pub.pkcs8pem, kp.sign(signed), type)).to.equal(false);
    });

    it(`returns false rather than throwing on junk ${type} input`, () => {
      // A client controls both the signature and the declared type, so this
      // path has to absorb anything without taking the process down.
      const shared = new Shared(false, { $tx: { a: 1 } } as any, {} as any, {} as any);
      expect(shared.signatureCheck("not-base64!!", "also-junk", type)).to.equal(false);
      expect(shared.signatureCheck("", "", type)).to.equal(false);
    });
  }

  it("does not let the key cache confuse one type for another", () => {
    // signatureCheck() caches KeyPair instances. The cache key includes the
    // type, and this fails loudly if that ever stops being true: the same
    // base64 string is a valid public key for neither of the other schemes,
    // so a cache hit across types would surface as a wrong answer here.
    const txBody = { $i: { alice: {} } };
    const shared = new Shared(false, { $tx: txBody } as any, {} as any, {} as any);

    const mldsa = new ActiveCrypto.KeyPair("ml-dsa-65");
    const mldsaKeys = mldsa.generate();
    const falcon = new ActiveCrypto.KeyPair("falcon-512");
    const falconKeys = falcon.generate();

    expect(shared.signatureCheck(mldsaKeys.pub.pkcs8pem, mldsa.sign(txBody), "ml-dsa-65")).to.equal(true);
    expect(shared.signatureCheck(falconKeys.pub.pkcs8pem, falcon.sign(txBody), "falcon-512")).to.equal(true);
    // Same key material, wrong type declared - must not be served from cache
    // as the type it was first seen under.
    expect(shared.signatureCheck(mldsaKeys.pub.pkcs8pem, mldsa.sign(txBody), "falcon-512")).to.equal(false);
    expect(shared.signatureCheck(falconKeys.pub.pkcs8pem, falcon.sign(txBody), "ml-dsa-65")).to.equal(false);
    // And the originals still verify afterwards.
    expect(shared.signatureCheck(mldsaKeys.pub.pkcs8pem, mldsa.sign(txBody), "ml-dsa-65")).to.equal(true);
  });

  it("rejects an unimplemented type without taking the process down", () => {
    const shared = new Shared(false, { $tx: { a: 1 } } as any, {} as any, {} as any);
    expect(shared.signatureCheck("AAAA", "AAAA", "kyber-1024")).to.equal(false);
  });
});
