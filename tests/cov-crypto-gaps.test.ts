import { expect } from "chai";
import "mocha";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import Module from "module";
import { ActiveCrypto } from "../packages/crypto/src";
import { AsnParser } from "../packages/crypto/src/crypto/asn";
import * as attest from "../packages/crypto/src/crypto/attest";

const { KeyPair, Hash, Secured, ADACType } = ActiveCrypto;
const EC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "keypair-secp256k1-vector.json"), "utf8"));

const fatalMsg = (fn: () => any): string => {
  try {
    fn();
  } catch (e: any) {
    return e.message;
  }
  throw new Error("expected a throw");
};

describe("Hash", () => {
  it("static and instance getHash agree with node for sha256 (default) and sha512", () => {
    const h = new Hash();
    expect(Hash.getHash("abc")).to.equal(crypto.createHash("sha256").update("abc").digest("hex"));
    expect(h.getHash("abc")).to.equal(Hash.getHash("abc"));
    expect(h.getHash("abc", "sha512")).to.equal(crypto.createHash("sha512").update("abc").digest("hex"));
    expect(h.getHash("abc")).to.not.equal(h.getHash("abd"));
    // well known test vector
    expect(h.getHash("abc")).to.equal("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("attest.verifyDigest", () => {
  it("is true for a good signature and false for a tampered digest", () => {
    const pair = new KeyPair("secp256k1").generate();
    const kp = new KeyPair("secp256k1", pair.prv.pkcs8pem);
    const digest = "d1";
    const sig = attest.signDigest(kp, digest);
    expect(attest.verifyDigest(pair.pub.pkcs8pem, "secp256k1", digest, sig)).to.equal(true);
    expect(attest.verifyDigest(pair.pub.pkcs8pem, "secp256k1", "d2", sig)).to.equal(false);
  });
  it("is false (not a throw) for an unparseable key or unknown type", () => {
    expect(attest.verifyDigest("not a key", "secp256k1", "d", "c2ln")).to.equal(false);
    expect(attest.verifyDigest("not a key", "no-such-type", "d", "c2ln")).to.equal(false);
  });
});

describe("AsnParser.decodeECPrivateKey without any key inside", () => {
  it("throws PPK not found for a sequence holding only a version", () => {
    // SEQUENCE { INTEGER 1 }
    const der = Buffer.from("3003020101", "hex");
    const pem = `-----BEGIN EC PRIVATE KEY-----\n${der.toString("base64")}\n-----END EC PRIVATE KEY-----`;
    expect(fatalMsg(() => AsnParser.decodeECPrivateKey(pem))).to.equal("PPK not found inside ASN");
  });
  it("decodes the bare key from a sequence of version + octet string", () => {
    const key = Buffer.alloc(32, 7);
    // SEQUENCE { INTEGER 1, OCTET STRING(32) }
    const der = Buffer.concat([Buffer.from("30250201010420", "hex"), key]);
    const pem = `-----BEGIN EC PRIVATE KEY-----\n${der.toString("base64")}\n-----END EC PRIVATE KEY-----`;
    expect(AsnParser.decodeECPrivateKey(pem)).to.equal(key.toString("hex"));
  });
});

describe("KeyPair - corners", () => {
  it("post-quantum verify returns false (does not throw) when the public key is the wrong size", () => {
    const keys = new KeyPair("ml-dsa-65").generate();
    const signer = new KeyPair("ml-dsa-65", keys.prv.pkcs8pem);
    const sig = signer.sign("hello");
    expect(new KeyPair("ml-dsa-65", keys.pub.pkcs8pem).verify("hello", sig)).to.equal(true);
    const verifier = new KeyPair("ml-dsa-65", keys.pub.pkcs8pem);
    // A truncated public key makes the underlying verify throw.
    (verifier as any).createHandler("", Buffer.from("short").toString("base64"));
    expect(verifier.verify("hello", sig)).to.equal(false);
  });

  it("signing with an unreadable secp256k1 PEM after compat conversion was already tried throws", () => {
    const legacy = `-----BEGIN PRIVATE-----\n${Buffer.from(EC.prvHex).toString("base64")}\n-----END PRIVATE-----`;
    const kp = new KeyPair("secp256k1", legacy);
    (kp as any).compatMode = true; // conversion already used up
    expect(fatalMsg(() => kp.sign("data"))).to.equal("Cannot sign with secp256k1 supplied PEM");
    // control: a fresh instance converts the same key and signs
    expect(new KeyPair("secp256k1", legacy).sign("data")).to.be.a("string");
  });

  it("generates RSA through the pure-JS fallback when the node keygen is not available", () => {
    const real = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }) as any;
    const calls: any[] = [];
    class FakeRSA {
      constructor(opts: any) {
        calls.push(opts);
      }
      exportKey(kind: string) {
        return Buffer.from(kind === "pkcs8-private-pem" ? real.privateKey : real.publicKey);
      }
    }
    const M: any = Module;
    const origLoad = M._load;
    M._load = function (request: string, ...rest: any[]) {
      if (request === "node-rsa") return FakeRSA;
      return origLoad.call(this, request, ...rest);
    };
    try {
      const kp = new KeyPair("rsa");
      (kp as any).isFullNodeEnv = () => false;
      const out = kp.generate(1024);
      expect(calls).to.deep.equal([{ b: 1024 }]);
      expect(out.pub.pkcs8pem).to.equal(real.publicKey);
      expect(out.prv.pkcs8pem).to.equal(real.privateKey);
    } finally {
      M._load = origLoad;
    }
  });
});

describe("KeyPair.generate for the EC aliases", () => {
  for (const type of ["secp256k1", "bitcoin", "ethereum"]) {
    it(`${type}: generates a pair that signs and verifies, and rejects a changed message`, () => {
      const g = new KeyPair(type).generate();
      const sig = new KeyPair(type, g.prv.pkcs8pem).sign("m");
      expect(new KeyPair(type, g.pub.pkcs8pem).verify("m", sig)).to.equal(true);
      expect(new KeyPair(type, g.pub.pkcs8pem).verify("n", sig)).to.equal(false);
    });
  }
});

describe("Secured - corners", () => {
  const rsa = () => {
    const g = new KeyPair("rsa").generate();
    return { pub: g.pub.pkcs8pem, prv: g.prv.pkcs8pem };
  };
  const own = rsa();
  const self = { reference: "node0", public: own.pub, private: own.prv };
  const db: any = { get: async () => ({}) };
  const rejection = async (p: Promise<any>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected rejection");
  };

  it("decrypt rejects an unknown $ADAC type", async () => {
    const s = new Secured(db, {}, self);
    const err = await rejection(s.decrypt({ $ADAC: [{ ref: "x", type: 99 as any, roles: "r" }], data: {} } as any));
    expect(err).to.equal("Unknown $ADAC type");
  });

  it("decrypt rejects when the role keys for this node are not readable JSON", async () => {
    const s = new Secured(db, {}, self);
    const notJson = new KeyPair("rsa", own.pub).encrypt("this is not json");
    const err: any = await rejection(
      s.decrypt({ $ADAC: [{ ref: "node0", type: ADACType.Node, roles: notJson }], data: {} } as any)
    );
    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.equal("Secured: cannot read role keys for node0");
  });

  it("decrypt ignores node entries addressed to a different node and stream/pubkey entries", async () => {
    const s = new Secured(db, {}, self);
    const data = { a: 1 };
    const out: any = await s.decrypt({
      $ADAC: [
        { ref: "other", type: ADACType.Node, roles: "zzz" },
        { ref: "s", type: ADACType.Stream, roles: "zzz" },
        { ref: "p", type: ADACType.PubKey, roles: "zzz" },
      ],
      data,
    } as any);
    expect(out.data).to.deep.equal({ a: 1 });
  });
});
