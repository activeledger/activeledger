import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Attestation } from "../packages/protocol/src/protocol/attest";
import { nodeKeys } from "../packages/hybrid/src/verify";
import { ensureAttestKey, withAttestKey } from "../packages/activeledger/src/cli/identity";

describe("Attesting with an Ed25519 key (Activeprotocol)", () => {
  const rsa = new ActiveCrypto.KeyPair("rsa");
  const rsaPub = rsa.generate().pub.pkcs8pem;
  const ed = new ActiveCrypto.KeyPair("ed25519");
  const edKeys = ed.generate();
  const edPub = edKeys.pub.pkcs8pem;
  const revs = { $i: { s1: "1-a" }, $o: { s1: "1-a" } };
  const digest = ActiveCrypto.voteDigest("u1", true, revs);
  const listing = (public_: string = edPub) => [{ host: "h", port: 1, attest: { type: "ed25519", public: public_ } }];
  let savedNeighbourhood: any;

  beforeEach(() => {
    savedNeighbourhood = ActiveOptions.get("neighbourhood", undefined);
    Attestation.key = rsa;
    Attestation.attestKey = ed;
    Attestation.attestPublic = edPub;
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", { admission: "open" });
  });
  afterEach(() => {
    Attestation.key = undefined;
    Attestation.attestKey = undefined;
    Attestation.attestPublic = undefined;
    ActiveOptions.set("neighbourhood", savedNeighbourhood);
    ActiveOptions.set("build", 0);
    ActiveOptions.set("hybrid", undefined);
  });

  const signed = () => {
    const node: any = { vote: true, commit: false };
    Attestation.signVote("u1", revs, node);
    return node.sig as string;
  };

  it("signs with the identity key when the neighbourhood does not list the Ed25519 key", () => {
    ActiveOptions.set("neighbourhood", [{ host: "h", port: 1 }]);
    expect(ActiveCrypto.verifyDigest(rsaPub, "rsa", digest, signed())).to.equal(true);
  });

  it("signs with the identity key when there is no neighbourhood at all", () => {
    ActiveOptions.set("neighbourhood", undefined);
    expect(ActiveCrypto.verifyDigest(rsaPub, "rsa", digest, signed())).to.equal(true);
  });

  it("signs with the Ed25519 key once the neighbourhood lists it", () => {
    ActiveOptions.set("neighbourhood", listing());
    const sig = signed();
    expect(ActiveCrypto.verifyDigest(edPub, "ed25519", digest, sig)).to.equal(true);
    expect(ActiveCrypto.verifyDigest(rsaPub, "rsa", digest, sig)).to.equal(false);
  });

  it("ignores a listed key that is not this node's, or of another type", () => {
    const other = new ActiveCrypto.KeyPair("ed25519").generate().pub.pkcs8pem;
    ActiveOptions.set("neighbourhood", listing(other));
    expect(ActiveCrypto.verifyDigest(rsaPub, "rsa", digest, signed())).to.equal(true);
    ActiveOptions.set("neighbourhood", [{ attest: { type: "rsa", public: edPub } }]);
    expect(ActiveCrypto.verifyDigest(rsaPub, "rsa", digest, signed())).to.equal(true);
  });

  it("follows the neighbourhood when it changes", () => {
    ActiveOptions.set("neighbourhood", listing());
    expect(ActiveCrypto.verifyDigest(edPub, "ed25519", digest, signed())).to.equal(true);
    ActiveOptions.set("neighbourhood", [{ host: "h", port: 1 }]);
    expect(ActiveCrypto.verifyDigest(rsaPub, "rsa", digest, signed())).to.equal(true);
  });

  it("still does nothing below build 40300", () => {
    ActiveOptions.set("neighbourhood", listing());
    ActiveOptions.set("build", 40250);
    expect(signed()).to.equal(undefined);
  });

  describe("a hybrid choosing a supernode's key from the setup stream", () => {
    const setup = (entry: any) => ({ neighbourhood: [{ host: "h", port: 1, identity: { type: "rsa", public: rsaPub }, ...entry }] });
    it("uses the attestation key when one is listed", () => {
      const [key] = nodeKeys(setup({ attest: { type: "ed25519", public: edPub } }), "net").values();
      expect(key).to.deep.equal({ type: "ed25519", public: edPub });
    });
    it("uses the identity key otherwise", () => {
      const [key] = nodeKeys(setup({}), "net").values();
      expect(key).to.deep.equal({ type: "rsa", public: rsaPub });
    });
  });

  describe("the identity file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-id-"));
    const file = path.join(dir, ".identity");
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("gets an Ed25519 key added once, keeping the RSA key and the file's mode", () => {
      const rsaKeys = new ActiveCrypto.KeyPair("rsa").generate();
      fs.writeFileSync(file, JSON.stringify(rsaKeys), { mode: 0o600 });
      const first = ensureAttestKey(file)!;
      expect(first.created).to.equal(true);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(onDisk.prv.pkcs8pem).to.equal(rsaKeys.prv.pkcs8pem);
      expect(onDisk.attest.pub.pkcs8pem).to.equal(first.public);
      expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
      const pair = new ActiveCrypto.KeyPair("ed25519", onDisk.attest.prv.pkcs8pem);
      expect(new ActiveCrypto.KeyPair("ed25519", first.public).verify("x", pair.sign("x"))).to.equal(true);

      const second = ensureAttestKey(file)!;
      expect(second).to.deep.equal({ public: first.public, created: false });
      expect(fs.readdirSync(dir)).to.deep.equal([".identity"]);
    });

    it("is left alone when it cannot be read", () => {
      expect(ensureAttestKey(path.join(dir, "missing"))).to.equal(undefined);
    });

    it("withAttestKey adds to a new identity without touching it", () => {
      const keys = new ActiveCrypto.KeyPair("rsa").generate();
      const out = withAttestKey(keys);
      expect(out.prv.pkcs8pem).to.equal(keys.prv.pkcs8pem);
      expect(out.attest.type).to.equal("ed25519");
    });
  });
});
