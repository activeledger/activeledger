import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "../packages/crypto/src";
import { Submitter, SubmitterOptions } from "../packages/hybrid/src/submit";

const kp = new ActiveCrypto.KeyPair("secp256k1");
const pem = kp.generate(2048, true).pub.pkcs8pem;
const future = () => new Date(Date.now() + 60000).toISOString();
const tx = () => ({
  $tx: { $namespace: "test", $contract: "c", $i: { s1: { x: 1 } }, $o: { s2: {} }, $expire: future() },
  $sigs: { s1: "sig" },
});
const yes = () => ({ umid: "", vote: true, committed: true, documents: {}, volatile: {}, events: [], supernodeDependent: false, dependence: [], adopt: [] });

describe("Hybrid Submitter, an upstream that throws instead of rejecting (cov)", () => {
  const make = (supernodes: any[], over: Partial<SubmitterOptions> = {}) =>
    new Submitter({
      config: { refuseOnboard: true },
      state: { version: "5.1.0", ready: true, cursor: "", headConfirmedAt: Date.now(), upstreams: [] } as any,
      sources: { supernodes, peers: [] },
      lookup: { ensure: async () => ({ missing: [] }), refreshToTip: async () => ({ missing: [] }) },
      identity: { pair: kp, publicPem: pem },
      dryRun: async () => yes() as any,
      ...over,
    });

  it("moves on to the next upstream when the throw says nothing was delivered", async () => {
    const asked: string[] = [];
    const broken: any = {
      id: "a",
      submit: () => {
        asked.push("a");
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    };
    const fine: any = { id: "b", submit: async () => (asked.push("b"), { $umid: "ok" }) };
    const r = await make([broken, fine]).submit(tx());
    expect(asked).to.deep.equal(["a", "b"]);
    expect(r.status).to.equal(200);
    expect(r.body).to.deep.equal({ $umid: "ok" });
  });
  it("does not retry when the throw leaves delivery unknown", async () => {
    const asked: string[] = [];
    const broken: any = {
      id: "a",
      submit: () => {
        asked.push("a");
        throw new Error("something odd");
      },
    };
    const never: any = { id: "b", submit: async () => (asked.push("b"), {}) };
    const r = await make([broken, never]).submit(tx());
    expect(asked).to.deep.equal(["a"]);
    expect(r.status).to.equal(504);
    expect(r.body.$hybrid).to.equal("unanswered");
    expect(typeof r.body.$umid).to.equal("string");
  });
});

describe("Hybrid Submitter, default dry run (cov)", () => {
  it("is run by the protocol, and a contract that cannot start refuses the transaction", async () => {
    const db: any = {};
    const s = new Submitter({
      config: { refuseOnboard: true },
      state: { version: "5.1.0", ready: true, cursor: "", headConfirmedAt: Date.now(), upstreams: [] } as any,
      sources: { supernodes: [{ id: "x", submit: async () => ({}) } as any], peers: [] },
      lookup: { ensure: async () => ({ missing: [] }), refreshToTip: async () => ({ missing: [] }) },
      identity: { pair: kp, publicPem: pem },
      db,
    });
    const r = await s.submit(tx());
    expect(r.status).to.equal(422);
    expect(r.body.$hybrid).to.equal("refused");
    expect(r.body.error).to.contain("Init Contract Error");
  });
});
