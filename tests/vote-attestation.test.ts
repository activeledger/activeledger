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
    ActiveOptions.set("hybrid", undefined);
  });

  it("does nothing below build 40300 or without a key", () => {
    const node: any = { vote: true, commit: false };
    Attestation.key = kp;
    ActiveOptions.set("build", 40299);
    Attestation.signVote("u1", revs, node);
    expect(node.sig).to.equal(undefined);

    Attestation.key = undefined;
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", { admission: "open" });
    Attestation.signVote("u1", revs, node);
    expect(node.sig).to.equal(undefined);
  });

  it("signs a yes vote over umid, vote and $revs", () => {
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", { admission: "open" });
    const node: any = { vote: true, commit: false };
    Attestation.signVote("u1", revs, node);
    const digest = ActiveCrypto.voteDigest("u1", true, revs);
    expect(ActiveCrypto.verifyDigest(pem, "rsa", digest, node.sig)).to.equal(true);
    expect(ActiveCrypto.verifyDigest(pem, "rsa", ActiveCrypto.voteDigest("u1", false, revs), node.sig)).to.equal(false);
  });

  it("signs a no vote, including one with no vote field yet", () => {
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", { admission: "open" });
    const node: any = { commit: false, error: "nope" };
    Attestation.signVote("u1", revs, node);
    expect(
      ActiveCrypto.verifyDigest(pem, "rsa", ActiveCrypto.voteDigest("u1", false, revs), node.sig)
    ).to.equal(true);
  });

  it("does not throw when signing fails", () => {
    Attestation.key = {} as any;
    ActiveOptions.set("build", 40300);
    ActiveOptions.set("hybrid", { admission: "open" });
    const node: any = { vote: true, commit: false };
    expect(() => Attestation.signVote("u1", revs, node)).to.not.throw();
    expect(node.sig).to.equal(undefined);
  });
});

describe("Attestations only while hybrids are enabled on the network", () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  kp.generate();
  const revs = { $i: {}, $o: {} };

  beforeEach(() => {
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
  });
  afterEach(() => {
    Attestation.key = undefined;
    ActiveOptions.set("build", 0);
    ActiveOptions.set("hybrid", undefined);
  });

  const signs = () => {
    const node: any = { vote: true };
    Attestation.signVote("u1", revs, node);
    return node.sig !== undefined;
  };

  it("signs nothing until the network asserts a hybrid section", () => {
    ActiveOptions.set("hybrid", undefined);
    expect(signs()).to.equal(false);
    ActiveOptions.set("hybrid", {});
    expect(signs()).to.equal(true);
    ActiveOptions.set("hybrid", { admission: "open" });
    expect(signs()).to.equal(true);
  });

  it("does not count the old URL list, which was never a section", () => {
    ActiveOptions.set("hybrid", ["https://example.test"]);
    expect(signs()).to.equal(false);
    ActiveOptions.set("hybrid", "yes");
    expect(signs()).to.equal(false);
  });

  it("records no commit facts without it, and reads nothing", async () => {
    let reads = 0;
    const db = { get: async () => (reads++, {}) };
    expect(await Attestation.facts(db, { $umid: "u1", $revs: revs, $nodes: {} } as any, [{ _id: "s1" }, { _id: "u1:umid" }])).to.equal(undefined);
    expect(reads).to.equal(0);
  });
});
