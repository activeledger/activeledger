import { expect } from "chai";
import "mocha";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";

const KeyPair = ActiveCrypto.KeyPair;

/**
 * KeyPair, checked against material that did not come from KeyPair.
 *
 * tests/crypto.test.ts and tests/post-quantum-keys.test.ts round-trip the
 * class against itself, which proves it agrees with itself and nothing more -
 * most of them assert only that verify() returns "a boolean". Here the
 * expected values come from elsewhere: a secp256k1 key, public encodings and
 * signature produced by Python's `cryptography` package, the secp256k1
 * generator point and its double (the public keys of the private scalars 1
 * and 2, constants of the curve), and an ML-DSA-65 key and signature produced
 * by node's own native ML-DSA rather than the noble implementation KeyPair
 * uses. Every verify assertion is `equal(true)` or `equal(false)`, never "is
 * a boolean", and every negative case is paired with the positive one it was
 * derived from so it cannot pass just because verification always fails.
 */

const fixture = (name: string) =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
  );

const EC = fixture("keypair-secp256k1-vector.json");
const MLDSA = fixture("keypair-ml-dsa-65-node-vector.json");

// Curve constants. The public keys of the private scalars 1 and 2.
const G =
  "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const TWO_G =
  "04c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" +
  "1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a";
const ORDER =
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
const scalar = (n: number) => "00".repeat(31) + n.toString(16).padStart(2, "0");

// Flip one bit of a base64 value.
const flip = (b64: string, at: number) => {
  const buf = Buffer.from(b64, "base64");
  buf[at] ^= 0x01;
  return buf.toString("base64");
};

const EC_TYPES = ["secp256k1", "bitcoin", "ethereum"];

describe("KeyPair - secp256k1 against independent vectors", () => {
  for (const type of EC_TYPES) {
    it(`${type}: verifies a signature made by another implementation`, () => {
      for (const pub of [
        "0x" + EC.pubUncompressedHex,
        "0x" + EC.pubCompressedHex,
        EC.pubSpkiPem,
      ]) {
        expect(new KeyPair(type, pub).verify(EC.message, EC.signatureB64)).to.equal(
          true,
          pub.slice(0, 12)
        );
      }
    });
  }

  it("rejects that signature once the message or the signature changes", () => {
    const pub = new KeyPair("secp256k1", "0x" + EC.pubUncompressedHex);
    expect(pub.verify(EC.message, EC.signatureB64)).to.equal(true);
    expect(pub.verify(EC.message + " ", EC.signatureB64)).to.equal(false);
    expect(pub.verify("", EC.signatureB64)).to.equal(false);
    // A bit flipped in r, in s, a signature cut short, one padded out with
    // junk, nothing at all, and something that is not base64 DER at all.
    const len = Buffer.from(EC.signatureB64, "base64").length;
    expect(pub.verify(EC.message, flip(EC.signatureB64, 10))).to.equal(false);
    expect(pub.verify(EC.message, flip(EC.signatureB64, len - 3))).to.equal(false);
    const raw = Buffer.from(EC.signatureB64, "base64");
    expect(pub.verify(EC.message, raw.subarray(0, len - 1).toString("base64"))).to.equal(false);
    expect(
      pub.verify(EC.message, Buffer.concat([raw, Buffer.from([0])]).toString("base64"))
    ).to.equal(false);
    expect(pub.verify(EC.message, "")).to.equal(false);
    expect(pub.verify(EC.message, "!!!not base64!!!")).to.equal(false);
  });

  it("rejects the signature under a different key", () => {
    expect(new KeyPair("secp256k1", "0x" + TWO_G).verify(EC.message, EC.signatureB64)).to.equal(false);
    expect(new KeyPair("secp256k1", "0x" + G).verify(EC.message, EC.signatureB64)).to.equal(false);
  });

  it("signs so that an independent verifier accepts, from every private key form", () => {
    // Raw hex, an OpenSSL SEC1 PEM and an OpenSSL PKCS#8 PEM of the same key.
    const verifier = crypto.createPublicKey(EC.pubSpkiPem);
    for (const prv of ["0x" + EC.prvHex, EC.prvSec1Pem, EC.prvPkcs8Pem]) {
      const sig = new KeyPair("secp256k1", prv).sign(EC.message);
      expect(
        crypto.verify("sha256", Buffer.from(EC.message), verifier, Buffer.from(sig, "base64"))
      ).to.equal(true, prv.slice(0, 12));
    }
  });

  it("signs with the generator-point private key, and only that public key accepts it", () => {
    const sig = new KeyPair("secp256k1", "0x" + scalar(1)).sign("one");
    expect(new KeyPair("secp256k1", "0x" + G).verify("one", sig)).to.equal(true);
    expect(new KeyPair("secp256k1", "0x" + TWO_G).verify("one", sig)).to.equal(false);
    expect(new KeyPair("secp256k1", "0x" + G).verify("two", sig)).to.equal(false);
  });

  it("treats a private key whose leading zero byte was dropped as the same key", () => {
    // ECDH.getPrivateKey() used to hand these out (see the padding test in
    // crypto.test.ts), so keys exist in the wild at 31 bytes.
    const full = "00a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e9";
    const ecdh = crypto.createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(full, "hex"));
    const pub = "0x" + ecdh.getPublicKey("hex", "uncompressed");
    for (const prv of [full, full.slice(2)]) {
      const sig = new KeyPair("secp256k1", "0x" + prv).sign("padded");
      expect(new KeyPair("secp256k1", pub).verify("padded", sig)).to.equal(true, `${prv.length} chars`);
    }
  });

  it("accepts Buffer and object payloads exactly as the string they serialise to", () => {
    const prv = new KeyPair("secp256k1", "0x" + EC.prvHex);
    const pub = new KeyPair("secp256k1", "0x" + EC.pubUncompressedHex);
    const obj = { $tx: { n: 1 } };
    expect(pub.verify(obj, prv.sign(obj))).to.equal(true);
    expect(pub.verify(JSON.stringify(obj), prv.sign(obj))).to.equal(true);
    expect(pub.verify(Buffer.from(EC.message), prv.sign(Buffer.from(EC.message)))).to.equal(true);
    expect(pub.verify(EC.message, EC.signatureB64)).to.equal(true);
    expect(pub.verify({ $tx: { n: 2 } }, prv.sign(obj))).to.equal(false);
  });

  it("signs and verifies in other encodings", () => {
    const prv = new KeyPair("secp256k1", "0x" + EC.prvHex);
    const pub = new KeyPair("secp256k1", "0x" + EC.pubUncompressedHex);
    const hex = (prv.sign as any)(EC.message, "hex");
    expect(hex).to.match(/^30[0-9a-f]+$/);
    expect((pub.verify as any)(EC.message, hex, "hex")).to.equal(true);
    expect((pub.verify as any)(EC.message, hex.slice(0, -2) + "00", "hex")).to.equal(false);
  });

  it("generated keys verify in both encodings and in compressed form", () => {
    const gen = new KeyPair("secp256k1");
    const pemKeys = gen.generate(2048, true);
    expect(pemKeys.prv.pkcs8pem).to.match(/^-----BEGIN EC PRIVATE KEY-----/);
    expect(pemKeys.pub.pkcs8pem).to.match(/^-----BEGIN PUBLIC KEY-----/);
    expect(gen.verify("x", gen.sign("x"))).to.equal(true);
    expect(gen.verify("y", gen.sign("x"))).to.equal(false);

    const hexKeys = new KeyPair("secp256k1").generate(2048, false);
    expect(hexKeys.pub.pkcs8pem).to.match(/^0x04[0-9a-f]{128}$/);
    const compressed = new KeyPair("secp256k1").generate(2048, false, true);
    expect(compressed.pub.pkcs8pem).to.match(/^0x0[23][0-9a-f]{64}$/);

    for (const keys of [hexKeys, compressed]) {
      const sig = new KeyPair("secp256k1", keys.prv.pkcs8pem).sign("hex keys");
      expect(new KeyPair("secp256k1", keys.pub.pkcs8pem).verify("hex keys", sig)).to.equal(true);
    }
  });

  it("reports a hash of each key's text, lazily", () => {
    const keys = new KeyPair("secp256k1").generate(2048, true);
    for (const half of [keys.pub, keys.prv]) {
      expect(half.hash).to.equal(
        crypto.createHash("sha256").update(half.pkcs8pem).digest("hex")
      );
    }
    expect(keys.pub.hash).to.not.equal(keys.prv.hash);
  });

  it("verifies repeatedly after the parsed public key is cached", () => {
    const pub = new KeyPair("secp256k1", "0x" + EC.pubUncompressedHex);
    for (let i = 0; i < 3; i++) {
      expect(pub.verify(EC.message, EC.signatureB64)).to.equal(true);
      expect(pub.verify(EC.message + i, EC.signatureB64)).to.equal(false);
    }
  });
});

describe("KeyPair - the half of a pair that is missing", () => {
  it("will not sign with a public key, or verify with a private one", () => {
    for (const type of ["secp256k1", "rsa"]) {
      const keys = type === "rsa"
        ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } })
        : { publicKey: EC.pubSpkiPem, privateKey: EC.prvSec1Pem };
      expect(() => new KeyPair(type, keys.publicKey).sign("x"), type).to.throw(/Cannot sign with .* Public key/);
      expect(() => new KeyPair(type, keys.privateKey).verify("x", "AAAA"), type).to.throw(/Cannot verify with .* Private Key/);
    }
  });

  it("will not verify from a raw-hex private key", () => {
    const priv = new KeyPair("secp256k1", "0x" + EC.prvHex);
    expect(() => priv.verify(EC.message, EC.signatureB64)).to.throw(/Cannot verify/);
  });

  it("cannot sign or verify when constructed with no key at all", () => {
    expect(() => new KeyPair("secp256k1").sign("x")).to.throw();
    expect(() => new KeyPair("secp256k1").verify("x", "AAAA")).to.throw();
    expect(() => new KeyPair("rsa", "").sign("x")).to.throw();
  });

  it("refuses to build a key of a type it does not know, and to generate one", () => {
    expect(() => new KeyPair("dsa", "0x" + EC.prvHex)).to.throw();
    expect(() => new KeyPair("ed25519").generate()).to.throw(/Cannot generate ed25519/);
  });

  it("will not sign or verify with a type it has no algorithm for", () => {
    // Reachable only by the type changing after construction, which is what
    // the default branches are for.
    const kp: any = new KeyPair("secp256k1", EC.pubSpkiPem);
    kp.type = "dsa";
    expect(() => kp.verify("x", "AAAA")).to.throw(/Cannot verify with dsa/);
    const prv: any = new KeyPair("secp256k1", EC.prvSec1Pem);
    prv.type = "dsa";
    expect(() => prv.sign("x")).to.throw(/Cannot sign with dsa/);
  });
});

describe("KeyPair - malformed secp256k1 key material", () => {
  const verifies = (pem: string) =>
    new KeyPair("secp256k1", pem).verify(EC.message, EC.signatureB64);

  it("never accepts a public key that is not on the curve", () => {
    // (0, 1) satisfies no point equation on secp256k1, and neither does the
    // real key with a single bit of y changed.
    const off = "0x04" + "00".repeat(31) + "01" + "00".repeat(31) + "01";
    const real = Buffer.from(EC.pubUncompressedHex, "hex");
    real[64] ^= 0x01;
    expect(verifies("0x" + EC.pubUncompressedHex)).to.equal(true);
    for (const bad of [off, "0x" + real.toString("hex")]) {
      let result: boolean | string;
      try { result = verifies(bad); } catch (e: any) { result = "threw"; }
      expect(result, bad.slice(0, 12)).to.not.equal(true);
    }
  });

  it("never accepts a truncated or oversized public key", () => {
    for (const bad of [
      "0x" + EC.pubUncompressedHex.slice(0, 100),
      "0x" + EC.pubUncompressedHex.slice(0, 128),
      "0x" + EC.pubUncompressedHex + "00",
      "0x" + EC.pubCompressedHex.slice(0, 64),
      "0x05" + EC.pubUncompressedHex.slice(2),
    ]) {
      let result: boolean | string;
      try { result = verifies(bad); } catch { result = "threw"; }
      expect(result, bad.slice(0, 14) + "/" + bad.length).to.not.equal(true);
    }
  });

  it("never accepts a PEM that is not a key", () => {
    for (const bad of [
      "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
      EC.pubSpkiPem.replace("MFYw", "MFYx"),
      EC.pubSpkiPem.slice(0, EC.pubSpkiPem.length - 40),
      "not a key at all",
    ]) {
      let result: boolean | string;
      try { result = verifies(bad); } catch { result = "threw"; }
      expect(result, bad.slice(0, 24)).to.not.equal(true);
    }
    expect(() => new KeyPair("secp256k1", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----").sign("x")).to.throw();
    expect(() => new KeyPair("rsa", "garbage").verify("x", "AAAA")).to.throw();
  });
});

describe("KeyPair - RSA", () => {
  // Made by node directly, not by KeyPair.generate()
  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const prv = () => new KeyPair("rsa", pair.privateKey);
  const pub = () => new KeyPair("rsa", pair.publicKey);

  it("signs so that node verifies, and verifies what node signed", () => {
    const sig = prv().sign("rsa payload");
    expect(
      crypto.verify("RSA-SHA256", Buffer.from("rsa payload"), pair.publicKey, Buffer.from(sig, "base64"))
    ).to.equal(true);
    const theirs = crypto.sign("RSA-SHA256", Buffer.from("rsa payload"), pair.privateKey).toString("base64");
    expect(pub().verify("rsa payload", theirs)).to.equal(true);
    expect(pub().verify("rsa payload", sig)).to.equal(true);
  });

  it("rejects changed data, a damaged signature and another key's signature", () => {
    const sig = prv().sign("rsa payload");
    expect(pub().verify("rsa payloae", sig)).to.equal(false);
    expect(pub().verify("rsa payload", flip(sig, 5))).to.equal(false);
    expect(pub().verify("rsa payload", sig.slice(0, 40))).to.equal(false);
    expect(pub().verify("rsa payload", "")).to.equal(false);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    expect(new KeyPair("rsa", other.publicKey).verify("rsa payload", sig)).to.equal(false);
  });

  it("signs and verifies in hex", () => {
    const hex = (prv().sign as any)("hex rsa", "hex");
    expect(hex).to.match(/^[0-9a-f]{512}$/);
    expect((pub().verify as any)("hex rsa", hex, "hex")).to.equal(true);
  });

  it("generates a pair that round-trips", () => {
    const gen = new KeyPair("rsa");
    const keys = gen.generate(1024);
    expect(keys.pub.pkcs8pem).to.match(/^-----BEGIN PUBLIC KEY-----/);
    expect(crypto.createPublicKey(keys.pub.pkcs8pem).asymmetricKeyDetails?.modulusLength).to.equal(1024);
    expect(gen.verify("g", gen.sign("g"))).to.equal(true);
  });

  it("encrypts so that node decrypts, in as many chunks as the data needs", () => {
    const text = "x".repeat(250);
    const cipher = pub().encrypt(text);
    expect(cipher.split("|")).to.have.length(3);
    const plain = cipher
      .split("|")
      .map((c) => crypto.privateDecrypt(pair.privateKey, Buffer.from(c, "base64")).toString())
      .join("");
    expect(plain).to.equal(text);
    expect(prv().decrypt(cipher)).to.equal(text);
  });

  it("decrypts what node encrypted, and takes Buffer and object input", () => {
    const theirs = crypto.publicEncrypt(pair.publicKey, Buffer.from("from node")).toString("base64");
    expect(prv().decrypt(theirs)).to.equal("from node");
    expect(prv().decrypt(Buffer.from(theirs))).to.equal("from node");
    expect(prv().decrypt(pub().encrypt({ a: 1 }))).to.equal('{"a":1}');
    expect(prv().decrypt(pub().encrypt(Buffer.from("buf")))).to.equal("buf");
    expect(prv().decrypt(pub().encrypt(""))).to.equal("");
  });

  it("does not decrypt tampered, truncated or foreign ciphertext", () => {
    const cipher = pub().encrypt("secret");
    expect(() => prv().decrypt(flip(cipher, 20))).to.throw();
    expect(() => prv().decrypt(cipher.slice(0, -8))).to.throw();
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    expect(() => new KeyPair("rsa", other.privateKey).decrypt(cipher)).to.throw();
  });

  it("refuses to encrypt without a public key or decrypt without a private one", () => {
    expect(() => prv().encrypt("x")).to.throw(/Cannot encrypt without rsa Public Key/);
    expect(() => pub().decrypt("x")).to.throw(/Cannot decrypt without rsa Private Key/);
  });

  it("does not encrypt or decrypt with an EC key", () => {
    expect(() => new KeyPair("secp256k1", EC.pubSpkiPem).encrypt("x")).to.throw(/Cannot encrypt with secp256k1/);
    expect(() => new KeyPair("secp256k1", EC.prvSec1Pem).decrypt("x")).to.throw(/Cannot decrypt with secp256k1/);
  });
});

describe("KeyPair - ML-DSA-65 against node's native implementation", () => {
  const pub = () => new KeyPair("ml-dsa-65", MLDSA.publicKeyB64);

  it("verifies a signature made by node's ML-DSA, not by noble", () => {
    expect(Buffer.from(MLDSA.signatureB64, "base64")).to.have.length(3309);
    expect(pub().verify(MLDSA.message, MLDSA.signatureB64)).to.equal(true);
  });

  it("rejects it once the message, the signature or the key changes", () => {
    expect(pub().verify(MLDSA.message + "!", MLDSA.signatureB64)).to.equal(false);
    expect(pub().verify("", MLDSA.signatureB64)).to.equal(false);
    // Bits flipped at the start, middle and end of the signature
    for (const at of [0, 1654, 3308]) {
      expect(pub().verify(MLDSA.message, flip(MLDSA.signatureB64, at)), `byte ${at}`).to.equal(false);
    }
    expect(new KeyPair("ml-dsa-65", flip(MLDSA.publicKeyB64, 100)).verify(MLDSA.message, MLDSA.signatureB64)).to.equal(false);
  });

  it("returns false for signatures of the wrong length or no length", () => {
    const raw = Buffer.from(MLDSA.signatureB64, "base64");
    for (const bad of [
      "",
      raw.subarray(0, 3308).toString("base64"),
      raw.subarray(0, 1).toString("base64"),
      Buffer.concat([raw, Buffer.from([0])]).toString("base64"),
      Buffer.concat([raw, raw]).toString("base64"),
    ]) {
      expect(pub().verify(MLDSA.message, bad), `${bad.length} chars`).to.equal(false);
    }
  });

  it("returns false, rather than throwing, for a public key of the right length that is junk", () => {
    const junk = crypto.randomBytes(1952).toString("base64");
    expect(new KeyPair("ml-dsa-65", junk).verify(MLDSA.message, MLDSA.signatureB64)).to.equal(false);
  });
});

describe("KeyPair - post-quantum edge cases", () => {
  for (const type of ["ml-dsa-65", "falcon-512"]) {
    describe(type, () => {
      const kp = new KeyPair(type);
      const keys = kp.generate();
      const pub = () => new KeyPair(type, keys.pub.pkcs8pem);

      it("signs and verifies the empty message and a large one", () => {
        for (const msg of ["", "x".repeat(200000), "é漢😀"]) {
          expect(pub().verify(msg, kp.sign(msg)), `${msg.length} chars`).to.equal(true);
        }
      });

      it("will not sign from a public key, nor verify from a private one", () => {
        expect(() => new KeyPair(type, keys.pub.pkcs8pem).sign("x")).to.throw(/Cannot sign/);
        expect(() => new KeyPair(type, keys.prv.pkcs8pem).verify("x", "AAAA")).to.throw(/Cannot verify/);
      });

      it("rejects a signature with one bit flipped, anywhere, and a truncated one", () => {
        const sig = kp.sign("flip me");
        expect(pub().verify("flip me", sig)).to.equal(true);
        const len = Buffer.from(sig, "base64").length;
        for (const at of [0, 1, Math.floor(len / 2), len - 1]) {
          expect(pub().verify("flip me", flip(sig, at)), `byte ${at}`).to.equal(false);
        }
        expect(pub().verify("flip me", Buffer.from(sig, "base64").subarray(0, len - 1).toString("base64"))).to.equal(false);
        expect(pub().verify("flip me", "")).to.equal(false);
      });

      it("signs and verifies in hex", () => {
        const hex = (kp.sign as any)("hex pq", "hex");
        expect(hex).to.match(/^[0-9a-f]+$/);
        expect((pub().verify as any)("hex pq", hex, "hex")).to.equal(true);
      });

      it("refuses key material that is empty, or one byte off a valid size", () => {
        const pubRaw = Buffer.from(keys.pub.pkcs8pem, "base64");
        for (const bad of [
          pubRaw.subarray(0, pubRaw.length - 1),
          Buffer.concat([pubRaw, Buffer.from([0])]),
          Buffer.alloc(1),
        ]) {
          expect(() => new KeyPair(type, bad.toString("base64"))).to.throw(/expected/);
        }
      });
    });
  }

  it("refuses a post-quantum key under a classical type it cannot be", () => {
    const keys = new KeyPair("ml-dsa-65").generate();
    expect(() => new KeyPair("dsa", keys.pub.pkcs8pem)).to.throw();
  });
});
