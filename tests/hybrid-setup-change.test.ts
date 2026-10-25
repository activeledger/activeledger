import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import Setup from "../packages/activeledger/src/contracts/default/setup";
import { keyArgument } from "../packages/activeledger/src/cli/hybridChange";

// `default/setup` entry "hybrid" changes the on-ledger hybrid section by
// operation, so two operators cannot overwrite each other's list
describe("Setup hybrid change", () => {
  const apply = (current: any, change: any): { hybrid?: any; error?: string } =>
    (Setup as any).applyHybrid(current, change);

  const pem = (): string =>
    new ActiveCrypto.KeyPair("secp256k1").generate(2048, true).pub.pkcs8pem;
  const base = (admission: any = { allowlist: [] }): any => ({
    admission,
    required: [],
    window: { days: 7 },
    minVersion: "5.1.0",
  });

  it("allow adds a key once, by hash or key", () => {
    const key = pem();
    const hash = ActiveCrypto.keyHash(key);
    let r = apply(base(), { allow: [hash] });
    expect(r.hybrid.admission.allowlist).to.deep.equal([hash]);
    r = apply(r.hybrid, { allow: [key, hash] });
    expect(r.hybrid.admission.allowlist).to.deep.equal([hash]);
  });

  it("deny removes an entry held as a key or a hash, and leaves the rest", () => {
    const a = pem();
    const b = pem();
    const held = base({ allowlist: [a, ActiveCrypto.keyHash(b)] });
    const r = apply(held, { deny: [ActiveCrypto.keyHash(a), b] });
    expect(r.hybrid.admission.allowlist).to.deep.equal([]);
    expect(apply(held, { deny: ["f".repeat(64)] }).hybrid.admission.allowlist).to.have.length(2);
  });

  it("allow and deny refuse an open admission, which has no list", () => {
    expect(apply(base("open"), { allow: ["a"] }).error).to.match(/open/);
    expect(apply(base("open"), { deny: ["a"] }).error).to.match(/open/);
  });

  it("admission switches between open and an allowlist, keeping a list it had", () => {
    expect(apply(base(), { admission: "open" }).hybrid.admission).to.equal("open");
    expect(apply(base("open"), { admission: "allowlist" }).hybrid.admission).to.deep.equal({ allowlist: [] });
    const held = base({ allowlist: ["k"] });
    expect(apply(held, { admission: "allowlist" }).hybrid.admission).to.deep.equal({ allowlist: ["k"] });
    expect(apply(held, { admission: "closed" }).error).to.match(/admission/);
  });

  it("minVersion must be semver, and a change cannot touch anything else", () => {
    expect(apply(base(), { minVersion: "5.2.0" }).hybrid.minVersion).to.equal("5.2.0");
    expect(apply(base(), { minVersion: "latest" }).error).to.match(/semver/);
    expect(apply(base(), { window: { days: 1 } }).error).to.match(/Unknown/);
  });

  it("is refused on a network with no hybrid section, and does not alter its input", () => {
    expect(apply(undefined, { minVersion: "5.2.0" }).error).to.match(/no hybrid section/);
    const held = base({ allowlist: ["k"] });
    apply(held, { deny: ["k"] });
    expect(held.admission.allowlist).to.deep.equal(["k"]);
  });

  it("keyArgument accepts a hash or a PEM and refuses anything else", () => {
    const key = pem();
    const hash = ActiveCrypto.keyHash(key);
    expect(keyArgument(hash)).to.equal(hash);
    expect(keyArgument(key)).to.equal(hash);
    expect(() => keyArgument("not a key")).to.throw(/expected/);
  });
});

describe("Setup hybrid change authorisation", () => {
  const nodes = [0, 1, 2].map((i) => {
    const kp = new ActiveCrypto.KeyPair("secp256k1");
    const keys = kp.generate(2048, true);
    return { kp, host: "10.0.0." + i, port: 5260, identity: { type: "secp256k1", public: keys.pub.pkcs8pem } };
  });
  const tx = { $namespace: "default", $contract: "setup", $entry: "hybrid", $i: {}, $o: { abc: {} } };

  const vote = (sigs: any, outputs: any = tx.$o) => {
    const c: any = Object.create(Setup.prototype);
    c.transactions = { ...tx, $o: outputs };
    c.sigs = sigs;
    c.config = { network: "abc@1-x", neighbourhood: nodes.map(({ host, port, identity }) => ({ host, port, identity })) };
    return new Promise<boolean | string>((res) => c.hybridVote(() => res(true), (e: string) => res(e)));
  };
  const sign = (n: number, t: any = tx) => nodes[n].kp.sign(t);
  const name = (n: number) => `${nodes[n].host}:${nodes[n].port}`;

  it("accepts valid signatures from more than half of the nodes", async () => {
    expect(await vote({ suggester: "x", [name(0)]: sign(0), [name(1)]: sign(1) })).to.equal(true);
  });

  it("is not reached by padding $sigs with keys that are not nodes", async () => {
    expect(await vote({ suggester: "x", a: "1", b: "2", c: "3", [name(0)]: sign(0) })).to.match(/signature/);
  });

  it("does not count an invalid signature", async () => {
    expect(await vote({ suggester: "x", [name(0)]: sign(0), [name(1)]: "forged" })).to.match(/signature/);
  });

  it("refuses an output that is not the network setup stream", async () => {
    const other = { ...tx, $o: { other: {} } };
    const sigs = { suggester: "x", [name(0)]: sign(0, other), [name(1)]: sign(1, other) };
    expect(await vote(sigs, other.$o)).to.match(/setup stream/);
  });
});
