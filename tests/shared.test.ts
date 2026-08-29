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
