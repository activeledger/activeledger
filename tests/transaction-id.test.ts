import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as path from "path";
import { ActiveCrypto } from "@activeledger/activecrypto";

const { TransactionId } = ActiveCrypto;
const BEFORE = TransactionId.BUILD - 1;
const sha = (s: string) => ActiveCrypto.Hash.getHash(s);

describe("Transaction id (Activecrypto)", () => {
  const $tx = { $namespace: "ns", $contract: "c", $i: { a: {} }, $o: { a: { n: 1 } }, $expire: "2999-01-01T00:00:00.000Z" };
  const entry = (over: any = {}): any => ({ $tx, $sigs: { a: "sig" }, ...over });

  describe("from its build level", () => {
    it("is the hash of $tx alone", () => {
      expect(TransactionId.of(entry(), TransactionId.BUILD)).to.equal(sha(JSON.stringify($tx)));
    });

    it("is the same however the entry is wrapped", () => {
      const id = TransactionId.of(entry(), TransactionId.BUILD);
      const wraps = [
        { $sigs: { a: "sig" }, $tx },
        entry({ extra: 1 }),
        entry({ $selfsign: true, $territoriality: "x" }),
        entry({ $sigs: { a: "another form of the signature", b: "and one for a key that is not an input" } }),
        entry({ $umid: "f".repeat(64), $spiRetry: true, $replaces: "e".repeat(64), $origin: "n", $nodes: {}, $revs: {}, $streams: {} }),
      ];
      for (const w of wraps) expect(TransactionId.of(w, TransactionId.BUILD + 5), JSON.stringify(w).slice(0, 60)).to.equal(id);
    });

    it("changes with anything the signature covers, including the order inside $tx", () => {
      const id = TransactionId.of(entry(), TransactionId.BUILD);
      expect(TransactionId.of(entry({ $tx: { ...$tx, $o: { a: { n: 2 } } } }), TransactionId.BUILD)).to.not.equal(id);
      expect(TransactionId.of(entry({ $tx: { ...$tx, $expire: "2999-01-02T00:00:00.000Z" } }), TransactionId.BUILD)).to.not.equal(id);
      const { $namespace, ...rest } = $tx;
      expect(TransactionId.of(entry({ $tx: { ...rest, $namespace } }), TransactionId.BUILD)).to.not.equal(id);
    });
  });

  describe("before it", () => {
    it("is the hash of the whole entry as it arrived", () => {
      const e = entry();
      expect(TransactionId.of(e, BEFORE)).to.equal(sha(JSON.stringify(e)));
    });

    it("ignores the fields only a node sets, so a client cannot add to the id with them", () => {
      const plain = TransactionId.of(entry(), BEFORE);
      for (const field of TransactionId.NODE_FIELDS) {
        expect(TransactionId.of(entry({ [field]: "x" }), BEFORE), field).to.equal(plain);
      }
    });

    it("does not change the entry it was given", () => {
      const e = entry({ $umid: "x", $spiRetry: true });
      TransactionId.of(e, BEFORE);
      expect(e.$umid).to.equal("x");
      expect(e.$spiRetry).to.equal(true);
    });
  });

  it("names the fields a node sets, and not the ones a client uses", () => {
    expect(TransactionId.NODE_FIELDS).to.include.members(["$umid", "$origin", "$nodes", "$revs", "$spiRetry", "$replaces", "$relay"]);
    for (const field of ["$tx", "$sigs", "$selfsign", "$territoriality", "$unanimous", "$broadcast"]) {
      expect((TransactionId.NODE_FIELDS as readonly string[]).includes(field), field).to.equal(false);
    }
  });

  it("is the build level a new node starts at", () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../packages/activeledger/src/default.config.json"), "utf8"));
    expect(config.build).to.equal(TransactionId.BUILD);
  });
});
