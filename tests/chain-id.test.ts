import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveChain } from "../packages/options/src/chain";

describe("ActiveChain", () => {
  describe("fromConfig", () => {
    it("accepts a whole number from 1", () => {
      expect(ActiveChain.fromConfig({ chain: { id: 1 } })).to.equal(1);
      expect(ActiveChain.fromConfig({ chain: { id: 42 } })).to.equal(42);
      expect(ActiveChain.fromConfig({ chain: { id: ActiveChain.MAX } })).to.equal(ActiveChain.MAX);
    });

    it("says what to add when it is missing", () => {
      for (const cfg of [{}, null, undefined, { chain: {} }, { chain: { id: null } }]) {
        expect(() => ActiveChain.fromConfig(cfg)).to.throw(/chain\.id is required.*"chain": \{ "id": 1 \}/);
      }
    });

    it("refuses anything that is not a positive whole number", () => {
      for (const id of [0, -1, 1.5, "1", true, [], {}, NaN, Infinity, ActiveChain.MAX + 1]) {
        expect(() => ActiveChain.fromConfig({ chain: { id } })).to.throw(/must be a whole number/);
      }
    });
  });

  describe("of", () => {
    it("treats a meta without a chain as the local chain", () => {
      expect(ActiveChain.of({}, 7)).to.equal(7);
      expect(ActiveChain.of(null, 7)).to.equal(7);
      expect(ActiveChain.of(undefined, 7)).to.equal(7);
      expect(ActiveChain.of({ chain: undefined }, 7)).to.equal(7);
    });

    it("uses the chain a meta carries", () => {
      expect(ActiveChain.of({ chain: 3 }, 7)).to.equal(3);
    });

    it("does not read a non-number as a chain", () => {
      expect(ActiveChain.of({ chain: "3" as any }, 7)).to.equal(7);
    });
  });

  describe("pin", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-pin-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("records the id on first use and accepts it again", () => {
      const file = path.join(dir, ".chain");
      ActiveChain.pin(file, 5);
      expect(fs.readFileSync(file, "utf8").trim()).to.equal("5");
      expect(() => ActiveChain.pin(file, 5)).to.not.throw();
    });

    it("refuses a changed id and leaves the record alone", () => {
      const file = path.join(dir, ".chain");
      ActiveChain.pin(file, 5);
      expect(() => ActiveChain.pin(file, 6)).to.throw(/chain\.id is 6 but this node was started as chain 5/);
      expect(fs.readFileSync(file, "utf8").trim()).to.equal("5");
    });

    it("treats an unreadable record as new", () => {
      const file = path.join(dir, ".chain");
      fs.writeFileSync(file, "garbage");
      ActiveChain.pin(file, 2);
      expect(fs.readFileSync(file, "utf8").trim()).to.equal("2");
    });
  });

  describe("warning", () => {
    it("says nothing for a real chain", () => {
      expect(ActiveChain.warning(9, [{ host: "10.0.0.5:5260" }])).to.equal(undefined);
    });

    it("says nothing for a test chain on this machine", () => {
      expect(ActiveChain.warning(1, [{ host: "127.0.0.1:5260" }, { host: "localhost:5261" }, { host: "[::1]:5262" }])).to.equal(undefined);
      expect(ActiveChain.warning(1, [])).to.equal(undefined);
    });

    it("warns for a test chain with a peer elsewhere", () => {
      expect(ActiveChain.warning(1, [{ host: "127.0.0.1:5260" }, { host: "203.0.113.4:5260" }])).to.match(/peers outside this machine/);
      expect(ActiveChain.warning(1, [{ host: "node2.example.com:5260" }])).to.match(/set its own chain\.id/);
    });
  });
});

describe("ActiveChain pairing helpers", () => {
  it("reads the configured id without throwing", () => {
    expect(ActiveChain.idOf({ id: 4 })).to.equal(4);
    expect(ActiveChain.idOf(null)).to.equal(undefined);
    expect(ActiveChain.idOf({ id: 0 })).to.equal(undefined);
  });

  it("builds the header line only when the id is valid", () => {
    expect(ActiveChain.idHeader({ id: 4 })).to.deep.equal(["X-Activeledger-Chain:4"]);
    expect(ActiveChain.idHeader(undefined)).to.deep.equal([]);
  });

  it("reports a different chain, and nothing for the same, missing or unreadable one", () => {
    expect(ActiveChain.mismatch(1, "5")).to.equal(5);
    expect(ActiveChain.mismatch(5, "5")).to.equal(undefined);
    expect(ActiveChain.mismatch(1, undefined)).to.equal(undefined);
    expect(ActiveChain.mismatch(1, "")).to.equal(undefined);
    expect(ActiveChain.mismatch(1, "abc")).to.equal(undefined);
    expect(ActiveChain.mismatch(undefined, "5")).to.equal(undefined);
  });
});
