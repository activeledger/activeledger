import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "@activeledger/activecrypto";

describe("KeyPair - ed25519 (Activecrypto)", () => {
  const make = () => {
    const kp = new ActiveCrypto.KeyPair("ed25519");
    kp.generate();
    return kp;
  };

  it("signs and verifies, and the signature is 64 bytes", () => {
    const kp = make();
    const sig = kp.sign("hello");
    expect(Buffer.from(sig, "base64")).to.have.length(64);
    expect(kp.verify("hello", sig)).to.equal(true);
  });

  it("signs an object by its JSON, the same as the other types", () => {
    const kp = make();
    expect(kp.verify({ a: 1 }, kp.sign({ a: 1 }))).to.equal(true);
  });

  it("does not verify other data, another key's signature, or junk", () => {
    const a = make();
    const b = make();
    const sig = a.sign("hello");
    expect(a.verify("hellp", sig)).to.equal(false);
    expect(b.verify("hello", sig)).to.equal(false);
    expect(a.verify("hello", "not-a-signature")).to.equal(false);
    expect(a.verify("hello", "")).to.equal(false);
  });

  it("verifies from the public key alone, and signs from the private key alone", () => {
    const kp = make();
    const sig = new ActiveCrypto.KeyPair("ed25519", (kp as any).handler.prv.pkcs8pem).sign("x");
    const pub = new ActiveCrypto.KeyPair("ed25519", (kp as any).handler.pub.pkcs8pem);
    expect(pub.verify("x", sig)).to.equal(true);
    expect(() => pub.sign("x")).to.throw();
  });

  it("matches RFC 8032 test vector 1 (not produced by this class)", () => {
    const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const pub = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const sig =
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    const pem = (der: string, label: string) =>
      `-----BEGIN ${label}-----\n${Buffer.from(der, "hex").toString("base64")}\n-----END ${label}-----\n`;
    const prv = new ActiveCrypto.KeyPair("ed25519", pem("302e020100300506032b657004220420" + seed, "PRIVATE KEY"));
    const pubKp = new ActiveCrypto.KeyPair("ed25519", pem("302a300506032b6570032100" + pub, "PUBLIC KEY"));
    expect(Buffer.from(prv.sign(""), "base64").toString("hex")).to.equal(sig);
    expect(pubKp.verify("", Buffer.from(sig, "hex").toString("base64"))).to.equal(true);
  });

  it("refuses a key of another kind declared as ed25519", () => {
    const rsa = new ActiveCrypto.KeyPair("rsa");
    rsa.generate();
    const asEd = new ActiveCrypto.KeyPair("ed25519", (rsa as any).handler.pub.pkcs8pem);
    expect(asEd.verify("x", rsa.sign("x"))).to.equal(false);
  });

  it("cannot encrypt", () => {
    expect(() => make().encrypt("x")).to.throw();
  });
});
