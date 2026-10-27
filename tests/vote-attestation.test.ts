import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Attestation } from "../packages/protocol/src/protocol/attest";

describe("Signed votes (Attestation.signVote)", () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  const pem = kp.generate().pub.pkcs8pem;
  const revs = { $i: { s1: "1-a" }, $o: { s1: "1-a", "c:data": "3-b" } };

  afterEach(() => {
    Attestation.key = undefined;
    ActiveOptions.set("build", 0);
  });

  it("does nothing below build 40300 or without a key", () => {
    const node: any = { vote: true, commit: false };
    Attestation.key = kp;
    ActiveOptions.set("build", 40299);
    Attestation.signVote("u1", revs, node);
    expect(node.sig).to.equal(undefined);

    Attestation.key = undefined;
    ActiveOptions.set("build", 40300);
    Attestation.signVote("u1", revs, node);
    expect(node.sig).to.equal(undefined);
  });

  it("signs a yes vote over umid, vote and $revs", () => {
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
    const node: any = { vote: true, commit: false };
    Attestation.signVote("u1", revs, node);
    const digest = ActiveCrypto.voteDigest("u1", true, revs);
    expect(ActiveCrypto.verifyDigest(pem, "rsa", digest, node.sig)).to.equal(true);
    expect(ActiveCrypto.verifyDigest(pem, "rsa", ActiveCrypto.voteDigest("u1", false, revs), node.sig)).to.equal(false);
  });

  it("signs a no vote, including one with no vote field yet", () => {
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
    const node: any = { commit: false, error: "nope" };
    Attestation.signVote("u1", revs, node);
    expect(
      ActiveCrypto.verifyDigest(pem, "rsa", ActiveCrypto.voteDigest("u1", false, revs), node.sig)
    ).to.equal(true);
  });

  it("does not throw when signing fails", () => {
    Attestation.key = {} as any;
    ActiveOptions.set("build", 40300);
    const node: any = { vote: true, commit: false };
    expect(() => Attestation.signVote("u1", revs, node)).to.not.throw();
    expect(node.sig).to.equal(undefined);
  });
});
