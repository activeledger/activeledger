import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";

const {
  KeyPair,
  canonicalJson,
  keyHash,
  signRequest,
  verifyRequest,
  voteDigest,
  commitDigest,
  signDigest,
  verifyDigest,
} = ActiveCrypto;

const make = (type: string) => {
  const kp = new KeyPair(type);
  const pem = kp.generate(2048, true).pub.pkcs8pem;
  return { kp, pem, type };
};

for (const type of ["rsa", "secp256k1"]) {
  describe(`Signed requests and attestations (${type})`, () => {
    const a = make(type);
    const b = make(type);

    it("verifies a fresh signed request", () => {
      const req = signRequest(a.kp, keyHash(a.pem), 1000);
      expect(verifyRequest(a.pem, type, req, 60, 1000)).to.equal(true);
    });

    it("rejects a signature from another key", () => {
      const req = signRequest(b.kp, keyHash(a.pem), 1000);
      expect(verifyRequest(a.pem, type, req, 60, 1000)).to.equal(false);
    });

    it("rejects a stale or future timestamp and a tampered key id", () => {
      const req = signRequest(a.kp, keyHash(a.pem), 1000);
      expect(verifyRequest(a.pem, type, req, 60, 1000 + 61000)).to.equal(false);
      expect(verifyRequest(a.pem, type, req, 60, 1000 - 61000)).to.equal(false);
      expect(verifyRequest(a.pem, type, { ...req, key: "other" }, 60, 1000)).to.equal(false);
    });

    it("never throws on a malformed key or signature", () => {
      const req = signRequest(a.kp, "k", 1000);
      expect(verifyRequest("not a pem", type, req, 60, 1000)).to.equal(false);
      expect(verifyRequest(a.pem, type, { ...req, signature: "zz" }, 60, 1000)).to.equal(false);
    });

    it("signs and verifies a vote, and a changed vote or rev fails", () => {
      const revs = { s1: "1-a", s2: "4-b" };
      const sig = signDigest(a.kp, voteDigest("u1", true, revs));
      expect(verifyDigest(a.pem, type, voteDigest("u1", true, revs), sig)).to.equal(true);
      expect(verifyDigest(a.pem, type, voteDigest("u1", false, revs), sig)).to.equal(false);
      expect(verifyDigest(a.pem, type, voteDigest("u1", true, { ...revs, s2: "5-c" }), sig)).to.equal(false);
      expect(verifyDigest(b.pem, type, voteDigest("u1", true, revs), sig)).to.equal(false);
    });

    it("signs and verifies a commit attestation over every field", () => {
      const out = { s1: { rev: "2-a", sha256: "aa" } };
      const d = commitDigest("u1", "committed", { s1: "1-a" }, out, "dh");
      const sig = signDigest(a.kp, d);
      expect(verifyDigest(a.pem, type, d, sig)).to.equal(true);
      for (const changed of [
        commitDigest("u2", "committed", { s1: "1-a" }, out, "dh"),
        commitDigest("u1", "failed", { s1: "1-a" }, out, "dh"),
        commitDigest("u1", "committed", { s1: "9-a" }, out, "dh"),
        commitDigest("u1", "committed", { s1: "1-a" }, { s1: { rev: "2-a", sha256: "bb" } }, "dh"),
        commitDigest("u1", "committed", { s1: "1-a" }, out, "other"),
      ]) {
        expect(verifyDigest(a.pem, type, changed, sig)).to.equal(false);
      }
    });
  });
}

describe("canonicalJson", () => {
  it("is independent of key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).to.equal(
      canonicalJson({ a: { c: 2, d: 1 }, b: 1 })
    );
  });

  it("drops undefined properties and keeps array order", () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).to.equal('{"b":[2,1]}');
  });
});
