import { expect } from "chai";
import "mocha";
import * as crypto from "crypto";
import { AsnParser } from "../packages/crypto/src/crypto/asn";
import { ActiveGZip } from "../packages/utilities/src/gzip";

describe("AsnParser EC key PEM round trip (secp256k1)", () => {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  const prv = ecdh.getPrivateKey();
  const pub = ecdh.getPublicKey();

  it("encodes a public key as a PEM that decodes back to the same bytes", () => {
    const pem = AsnParser.encodeECPublicKey(pub);
    expect(pem).to.match(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(pem.trim()).to.match(/-----END PUBLIC KEY-----$/);
    expect(AsnParser.decodeECPublicKey(pem)).to.equal(pub.toString("hex"));
  });

  it("encodes a private key as a PEM that decodes back to the same bytes", () => {
    const pem = AsnParser.encodeECPrivateKey(prv, pub);
    expect(pem).to.match(/^-----BEGIN EC PRIVATE KEY-----\n/);
    expect(AsnParser.decodeECPrivateKey(pem)).to.equal(prv.toString("hex"));
  });

  it("honours a custom label on both sides", () => {
    const pem = AsnParser.encodeECPublicKey(pub, "CUSTOM");
    expect(pem).to.contain("-----BEGIN CUSTOM-----");
    expect(AsnParser.decodeECPublicKey(pem, "CUSTOM")).to.equal(pub.toString("hex"));
  });

  it("produces a public key PEM that node's crypto accepts as secp256k1", () => {
    const pem = AsnParser.encodeECPublicKey(pub);
    const key = crypto.createPublicKey(pem);
    expect(key.asymmetricKeyType).to.equal("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).to.equal("secp256k1");
  });

  it("decodes a private key PEM exported by OpenSSL via node (nested format)", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "secp256k1",
    });
    const sec1 = privateKey.export({ type: "sec1", format: "pem" }) as string;
    const jwk = privateKey.export({ format: "jwk" }) as any;
    const expected = Buffer.from(jwk.d, "base64url").toString("hex");
    expect(AsnParser.decodeECPrivateKey(sec1)).to.equal(expected);
  });

  it("throws on a PEM with the wrong label", () => {
    const pem = AsnParser.encodeECPublicKey(pub);
    expect(() => AsnParser.decodeECPublicKey(pem, "OTHER")).to.throw();
  });

  it("throws on garbage input", () => {
    expect(() =>
      AsnParser.decodeECPublicKey("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")
    ).to.throw();
  });
});

describe("ActiveGZip", () => {
  it("round trips a string", async () => {
    const out = await ActiveGZip.ungzip(await ActiveGZip.gzip("hello world"));
    expect(out.toString()).to.equal("hello world");
  });

  it("round trips a buffer and produces gzip magic bytes", async () => {
    const input = Buffer.from([0, 1, 2, 255, 254]);
    const zipped = await ActiveGZip.gzip(input);
    expect(zipped[0]).to.equal(0x1f);
    expect(zipped[1]).to.equal(0x8b);
    expect(Buffer.compare(await ActiveGZip.ungzip(zipped), input)).to.equal(0);
  });

  it("compresses repetitive data", async () => {
    const zipped = await ActiveGZip.gzip("a".repeat(10000));
    expect(zipped.length).to.be.lessThan(200);
  });

  it("rejects data that is not gzip", async () => {
    let err: any;
    try {
      await ActiveGZip.ungzip(Buffer.from("not gzip"));
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
  });
});
