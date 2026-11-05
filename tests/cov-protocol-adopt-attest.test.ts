import { checkAdopt } from "../packages/protocol/src/protocol/adopt";
import { Attestation } from "../packages/protocol/src/protocol/attest";
import { ActiveCrypto } from "../packages/crypto/src";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";

describe("checkAdopt declared-shape reasons (cov)", () => {
  const W = "a".repeat(64);
  const local = (extra: any = {}) => ({ _id: W, _rev: "2-l", owner: "alice", meta: { n: 1 }, status: "p", ...extra });
  const signed = (extra: any = {}) => ({ ...local(), _rev: "3-s", ...extra });
  const run = (shape: any, signedDoc: any, atomic = false) =>
    checkAdopt({
      umid: "u",
      signed: { [W]: signedDoc },
      local: { [W]: local() },
      declarations: [{ streams: [W], shape, atomic, candidates: false } as any],
      supernodeDependent: true,
    });

  it("reports a declared type nobody defined", () => {
    const v = run({ status: "bogus" }, signed({ status: "s" }));
    expect(v.ok).to.equal(false);
    expect(v.reasons).to.deep.equal([`${W}.status: unknown declared type "bogus"`]);
  });

  it("reports a declared nested object that is missing from the signed document", () => {
    const { meta, ...withoutMeta } = signed();
    const v = run({ meta: { n: "number" } }, withoutMeta);
    expect(v.ok).to.equal(false);
    expect(v.reasons).to.include(`${W}.meta: declared property is missing`);
  });

  it("reports a declared nested object that is not an object", () => {
    const v = run({ meta: { n: "number" } }, signed({ meta: 5 }));
    expect(v.reasons).to.include(`${W}.meta: is not object`);
  });

  it("reports a missing required property, but lets an optional one be absent", () => {
    const { status, ...noStatus } = signed();
    expect(run({ status: "string" }, noStatus).reasons).to.include(`${W}.status: declared property is missing`);
    expect(run({ status: "string?" }, noStatus).reasons).to.deep.equal([]);
  });

  it("reports a declared property of the wrong type", () => {
    const v = run({ status: "number" }, signed({ status: "s" }));
    expect(v.reasons).to.include(`${W}.status: is not number`);
  });

  it("checks nested declared properties and counts them for atomic declarations", () => {
    const shape = { meta: { n: "number" }, status: "string" };
    const both = run(shape, signed({ meta: { n: 2 }, status: "q" }), true);
    expect(both.ok).to.equal(true);
    const oneOnly = run(shape, signed({ meta: { n: 2 } }), true);
    expect(oneOnly.ok).to.equal(false);
    expect(oneOnly.reasons).to.deep.equal([
      `${W}: atomic declaration changed 1 of 2 properties (meta.n)`,
    ]);
  });
});

describe("Attestation.commit failure and shape (cov)", () => {
  const kp = new ActiveCrypto.KeyPair("rsa");
  const keys = kp.generate();
  let errors: any[][];
  let realError: any;

  beforeEach(() => {
    errors = [];
    realError = (ActiveLogger as any).error;
    (ActiveLogger as any).error = (...a: any[]) => errors.push(a);
    Attestation.key = kp;
    ActiveOptions.set("build", 40300);
  });
  afterEach(() => {
    (ActiveLogger as any).error = realError;
    Attestation.key = undefined;
    ActiveOptions.set("build", 0);
  });

  const entry: any = {
    $umid: "umid-x",
    $revs: { $i: {}, $o: {} },
    $nodes: {
      a: { vote: true, sig: "sig-a" },
      b: { vote: false },
      c: { vote: undefined },
      d: null,
    },
  };

  it("reads documents back, signs them and posts the attestation with the signed votes", async () => {
    const store: any = {
      s1: { _id: "s1", _rev: "1-a", v: 1 },
      "s1:stream": { _id: "s1:stream", _rev: "1-b" },
      "umid-x:umid": { _id: "umid-x:umid", _rev: "1-c" },
    };
    const posted: any[] = [];
    await Attestation.commit(
      { get: async (id: string) => store[id] },
      { post: async (d: any) => posted.push(d) },
      "node-ref",
      entry,
      [{ _id: "s1" }, { _id: "s1:stream" }, { _id: "s1:volatile" }, { _id: "umid-x:umid" }, {}]
    );
    expect(posted).to.have.length(1);
    const att = posted[0];
    expect(att._id).to.equal("attest:umid-x");
    expect(att.node).to.equal("node-ref");
    expect(att.outcome).to.equal("committed");
    expect(Object.keys(att.revsOut)).to.deep.equal(["s1", "s1:stream"]);
    expect(att.revsOut.s1.rev).to.equal("1-a");
    expect(att.revsOut.s1.sha256).to.equal(
      ActiveCrypto.Hash.getHash(ActiveCrypto.canonicalJson(store.s1))
    );
    expect(att.nodes).to.deep.equal({ a: { vote: true, sig: "sig-a" }, b: { vote: false } });
    const digest = ActiveCrypto.commitDigest("umid-x", "committed", entry.$revs, att.revsOut, att.umidDocHash);
    expect(ActiveCrypto.verifyDigest(keys.pub.pkcs8pem, "rsa", digest, att.sig)).to.equal(true);
    expect(errors).to.deep.equal([]);
  });

  it("never fails the commit: a read failure is logged and nothing is posted", async () => {
    const posted: any[] = [];
    await Attestation.commit(
      {
        get: async () => {
          throw new Error("store down");
        },
      },
      { post: async (d: any) => posted.push(d) },
      "node-ref",
      entry,
      [{ _id: "s1" }]
    );
    expect(posted).to.deep.equal([]);
    expect(errors).to.have.length(1);
    expect(errors[0][0]).to.be.instanceOf(Error);
    expect(errors[0][1]).to.equal("Commit attestation failed for umid-x");
  });

  it("does nothing at all when attestation is not enabled", async () => {
    Attestation.key = undefined;
    let touched = 0;
    await Attestation.commit(
      { get: async () => (touched++, {}) },
      { post: async () => (touched++, {}) },
      "r",
      entry,
      [{ _id: "s1" }]
    );
    expect(touched).to.equal(0);
  });
});
