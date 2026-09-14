import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";

/**
 * ML-DSA-65 (FIPS 204) and Falcon-512 (FN-DSA) as Activeledger key types.
 *
 * The point of these is that a post-quantum identity is an ordinary identity:
 * the type string is all that distinguishes it, and everything from the
 * onboard contract to permissionsChecker passes that string through without
 * inspecting it. So the contract worth pinning is KeyPair's, because KeyPair
 * is the only thing in the stack that has to understand the algorithm.
 */
const PQ_TYPES = ["ml-dsa-65", "falcon-512"];

// Sizes from the standards, asserted rather than assumed - a silent change
// here would alter what every identity stream stores for good.
// Falcon's signature length VARIES - 649 to 662 bytes over 300 samples,
// because its encoding compresses - so it is bounded rather than fixed.
// ML-DSA's is fixed. Anyone sizing storage or wire budgets needs to know
// which of those they are dealing with.
const SIZES: { [t: string]: { pub: number; sigMin: number; sigMax: number } } = {
  "ml-dsa-65": { pub: 1952, sigMin: 3309, sigMax: 3309 },
  "falcon-512": { pub: 897, sigMin: 600, sigMax: 700 },
};

describe("ActiveCrypto.KeyPair - post-quantum signatures", () => {
  for (const type of PQ_TYPES) {
    describe(type, () => {
      it("generates a usable pair", () => {
        const keys = new ActiveCrypto.KeyPair(type).generate();
        expect(Buffer.from(keys.pub.pkcs8pem, "base64").length).to.equal(SIZES[type].pub);
        expect(Buffer.from(keys.prv.pkcs8pem, "base64").length).to.be.greaterThan(0);
      });

      it("signs and verifies a transaction body", () => {
        const kp = new ActiveCrypto.KeyPair(type);
        const keys = kp.generate();
        const tx = { $namespace: "default", $contract: "transfer", $i: { alice: { amount: "100" } } };
        const sig = kp.sign(tx);
        const sigLen = Buffer.from(sig, "base64").length;
        expect(sigLen).to.be.at.least(SIZES[type].sigMin);
        expect(sigLen).to.be.at.most(SIZES[type].sigMax);
        // Verified through a SEPARATE instance built from the public key
        // alone - which is how a node does it, holding no private key.
        expect(new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem).verify(tx, sig)).to.equal(true);
      });

      it("rejects a signature over different data", () => {
        const kp = new ActiveCrypto.KeyPair(type);
        const keys = kp.generate();
        const sig = kp.sign({ amount: "100" });
        const pub = new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem);
        expect(pub.verify({ amount: "101" }, sig)).to.equal(false);
      });

      it("rejects another key's signature", () => {
        const mine = new ActiveCrypto.KeyPair(type);
        mine.generate();
        const theirs = new ActiveCrypto.KeyPair(type);
        const theirKeys = theirs.generate();
        const tx = { $i: { alice: {} } };
        expect(
          new ActiveCrypto.KeyPair(type, theirKeys.pub.pkcs8pem).verify(tx, mine.sign(tx))
        ).to.equal(false);
      });

      it("returns false rather than throwing on a malformed signature", () => {
        // shared.signatureCheck() treats a throw as a failed check anyway, so
        // raising here would only log an error for every junk signature.
        const keys = new ActiveCrypto.KeyPair(type).generate();
        const pub = new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem);
        expect(pub.verify({ a: 1 }, "not-a-signature")).to.equal(false);
        expect(pub.verify({ a: 1 }, Buffer.from("short").toString("base64"))).to.equal(false);
      });

      it("knows a public key from a private one by length alone", () => {
        const keys = new ActiveCrypto.KeyPair(type).generate();
        const asPublic = new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem);
        const asPrivate = new ActiveCrypto.KeyPair(type, keys.prv.pkcs8pem);
        expect(asPublic.handler.pub.pkcs8pem).to.equal(keys.pub.pkcs8pem);
        expect(asPublic.handler.prv.pkcs8pem).to.equal("");
        expect(asPrivate.handler.prv.pkcs8pem).to.equal(keys.prv.pkcs8pem);
        // A private-key-only instance cannot verify, and says so.
        expect(() => asPrivate.verify({ a: 1 }, "AAAA")).to.throw(/Private Key/);
      });

      it("rejects key material of the wrong size outright", () => {
        expect(() => new ActiveCrypto.KeyPair(type, Buffer.alloc(100).toString("base64")))
          .to.throw(/expected/);
      });
    });
  }

  it("falcon-512 signature length varies, ml-dsa-65's does not", () => {
    // Worth pinning: a fixed-size assumption about Falcon would hold for a
    // long time and then quietly not.
    const sizes: { [t: string]: Set<number> } = {};
    for (const type of PQ_TYPES) {
      const kp = new ActiveCrypto.KeyPair(type);
      kp.generate();
      sizes[type] = new Set();
      for (let i = 0; i < 40; i++) {
        sizes[type].add(Buffer.from(kp.sign({ n: i }), "base64").length);
      }
    }
    expect(sizes["ml-dsa-65"].size).to.equal(1);
    expect(sizes["falcon-512"].size).to.be.greaterThan(1);
  });

  it("signs even when the crypto global has been replaced", () => {
    // The contract VM gives contracts an Activeledger `crypto` object under
    // that name, and tests/contract.test.ts installs one process-wide. noble
    // reads globalThis.crypto.getRandomValues unless entropy is supplied, so
    // without that this fails with "crypto.getRandomValues must be defined"
    // - and only once another suite has run first, which is the kind of
    // failure that looks like flakiness rather than a missing dependency.
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: { notWebCrypto: true },
        configurable: true,
      });
      for (const type of PQ_TYPES) {
        const kp = new ActiveCrypto.KeyPair(type);
        const keys = kp.generate();
        const tx = { $i: { alice: {} } };
        const sig = kp.sign(tx);
        expect(
          new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem).verify(tx, sig)
        ).to.equal(true, `${type} signs without the crypto global`);
      }
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });

  it("leaves the existing types alone", () => {
    for (const type of ["rsa", "secp256k1"]) {
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = type === "rsa" ? kp.generate() : kp.generate(256, true);
      const tx = { $i: { alice: {} } };
      expect(new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem).verify(tx, kp.sign(tx)))
        .to.equal(true, `${type} still works`);
    }
  });
});

/**
 * Type confusion. The type string decides which algorithm verifies a
 * signature, and it travels with the transaction rather than being derived
 * from the key - so the interesting question is what happens when it does
 * not match the key material it arrives with.
 */
describe("ActiveCrypto.KeyPair - post-quantum type confusion", () => {
  it("will not verify one scheme's signature under the other", () => {
    const mldsa = new ActiveCrypto.KeyPair("ml-dsa-65");
    const mldsaKeys = mldsa.generate();
    const falcon = new ActiveCrypto.KeyPair("falcon-512");
    const falconKeys = falcon.generate();
    const tx = { $i: { alice: {} } };

    // Right key, wrong algorithm declared: the key material is the wrong
    // length for the declared scheme, so it is refused at construction.
    expect(() => new ActiveCrypto.KeyPair("falcon-512", mldsaKeys.pub.pkcs8pem))
      .to.throw(/expected/);
    expect(() => new ActiveCrypto.KeyPair("ml-dsa-65", falconKeys.pub.pkcs8pem))
      .to.throw(/expected/);

    // Right algorithm and a valid key, but a signature made by the other
    // scheme - a plain false, no throw.
    expect(
      new ActiveCrypto.KeyPair("ml-dsa-65", mldsaKeys.pub.pkcs8pem).verify(tx, falcon.sign(tx))
    ).to.equal(false);
    expect(
      new ActiveCrypto.KeyPair("falcon-512", falconKeys.pub.pkcs8pem).verify(tx, mldsa.sign(tx))
    ).to.equal(false);
  });

  it("will not verify a post-quantum signature as rsa", () => {
    const kp = new ActiveCrypto.KeyPair("ml-dsa-65");
    const keys = kp.generate();
    const tx = { $i: { alice: {} } };
    // An rsa KeyPair handed post-quantum key material: base64 that is not a
    // PEM. It must refuse rather than accept anything.
    let verified: boolean;
    try {
      verified = new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem).verify(tx, kp.sign(tx));
    } catch {
      verified = false; // throwing is a valid refusal
    }
    expect(verified).to.equal(false);
  });

  it("fails cleanly on a type nobody implements", () => {
    // A client can put anything in $i.identity.type. It must not crash the
    // process - shared.signatureCheck() turns a throw into a failed check,
    // but the throw has to be reachable rather than a TypeError somewhere.
    expect(() => new ActiveCrypto.KeyPair("dilithium-9000", "AAAA").verify({ a: 1 }, "AAAA"))
      .to.throw();
  });
});

describe("ActiveCrypto.KeyPair - post-quantum signing behaviour", () => {
  for (const type of PQ_TYPES) {
    it(`${type} produces a different signature each time, all valid`, () => {
      // Signing is hedged, so identical input gives different signatures.
      // Both must verify - a test that only checked one would pass against a
      // broken implementation that ignored the entropy.
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = kp.generate();
      const tx = { $i: { alice: { amount: "100" } } };
      const pub = new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem);
      const sigs = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const sig = kp.sign(tx);
        expect(pub.verify(tx, sig)).to.equal(true);
        sigs.add(sig);
      }
      expect(sigs.size).to.equal(5, "hedged signing should not repeat");
    });

    it(`${type} round-trips a payload with non-ASCII content`, () => {
      // sign() and verify() must agree on encoding. Both go through
      // Buffer.from(str, "utf8"); a mismatch would only show on bytes above
      // the ASCII range, which a plain transaction never contains.
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = kp.generate();
      const tx = { $i: { "café": { note: "日本語 — emoji 🔐", amount: "١٢٣" } } };
      expect(new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem).verify(tx, kp.sign(tx)))
        .to.equal(true);
    });

    it(`${type} handles a large payload`, () => {
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = kp.generate();
      const tx = { $i: { alice: { blob: "x".repeat(200_000) } } };
      expect(new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem).verify(tx, kp.sign(tx)))
        .to.equal(true);
    });

    it(`${type} survives being carried as a string and rebuilt`, () => {
      // How a node actually gets the key: read off a stream document, having
      // been JSON encoded and decoded on the way.
      const kp = new ActiveCrypto.KeyPair(type);
      const keys = kp.generate();
      const tx = { $i: { alice: {} } };
      const sig = kp.sign(tx);
      const carried = JSON.parse(JSON.stringify({ pub: keys.pub.pkcs8pem, sig }));
      expect(new ActiveCrypto.KeyPair(type, carried.pub).verify(tx, carried.sig))
        .to.equal(true);
    });

    it(`${type} rejects an empty signature`, () => {
      const keys = new ActiveCrypto.KeyPair(type).generate();
      const pub = new ActiveCrypto.KeyPair(type, keys.pub.pkcs8pem);
      expect(pub.verify({ a: 1 }, "")).to.equal(false);
    });
  }
});
