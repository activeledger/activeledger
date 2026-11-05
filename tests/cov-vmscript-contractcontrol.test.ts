import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// vmscript.ts exports a ContractControl singleton via module.exports
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cc = require("../packages/protocol/src/protocol/vmscript.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-vmscript-"));
const withSetEvent = path.join(dir, "full.js");
const bare = path.join(dir, "bare.js");

fs.writeFileSync(
  withSetEvent,
  `
global.__loads = (global.__loads || 0) + 1;
exports.default = class C {
  constructor(...args) {
    this.args = args;
    this.updatedContractData = false;
    this.throwTo = ["a", "b"];
    this.calls = [];
  }
  setEvent(e) { this.event = e; }
  getActivityStreams() { return { r: "stream" }; }
  exportContractData() { return { exported: true }; }
  setInterNodeComms(k, c) { this.comms = [k, c]; }
  getThisInterNodeComms() { return this.comms; }
  getClearInterNodeComms() { return "cleared"; }
  getReturnToRemote() { return "remote"; }
  getTimeout() { return "T"; }
  verify(s) { return s ? false : "v"; }
  vote() { return Promise.resolve("voted"); }
  commit(t) { return Promise.resolve("committed:" + t); }
  postProcess(t, w) { return Promise.resolve("pp:" + t + ":" + w); }
  reconcile() { return Promise.resolve("rec"); }
  shutdown() { global.__shutdown = (global.__shutdown || 0) + 1; }
  sysConfig(c) { this.cfg = c; }
  configReload() { return "reloaded"; }
  readMe() { return "read!"; }
  readFalsy() { return 0; }
};
`
);
fs.writeFileSync(
  bare,
  `exports.default = class B { constructor(...a) { this.args = a; } vote() { throw new Error("x"); } commit() { throw new Error("y"); } };`
);

const payload = (umid: string, loc = withSetEvent, extra: any = {}) => ({
  contractLocation: loc,
  umid,
  date: "d",
  remoteAddress: "ra",
  transaction: { t: 1 },
  inputs: { i: 1 },
  outputs: { o: 1 },
  readonly: { r: 1 },
  contractData: { data: { x: 1 } },
  signatures: { s: 1 },
  key: 7,
  ...extra,
});

const inst = (umid: string): any => cc.smartContracts[umid];

describe("vmscript ContractControl", () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("initialiseContract constructs with args in order, and calls setEvent", () => {
    const ev: any = { ev: 1 };
    const em: any = { em: 1 };
    (global as any).self = "SELF";
    cc.initialiseContract(payload("u1"), ev, em);
    const c = inst("u1");
    expect(c.args).to.deep.equal([
      "d", "ra", "u1", { t: 1 }, { i: 1 }, { o: 1 }, { r: 1 },
      { data: { x: 1 } }, { s: 1 }, 7, em, "SELF",
    ]);
    expect(c.event).to.equal(ev);
  });

  it("contract data without .data (or missing) becomes an empty object", () => {
    cc.initialiseContract(payload("u2", withSetEvent, { contractData: { nodata: 1 } }), {} as any, {} as any);
    expect(inst("u2").args[7]).to.deep.equal({});
    cc.initialiseContract(payload("u3", withSetEvent, { contractData: undefined }), {} as any, {} as any);
    expect(inst("u3").args[7]).to.deep.equal({});
  });

  it("contract module is required once per location (constructable cached)", () => {
    cc.initialiseContract(payload("u4"), {} as any, {} as any);
    expect((global as any).__loads).to.equal(1);
    expect(inst("u4")).to.not.equal(inst("u1"));
  });

  it("does not call setEvent when the contract has none", () => {
    cc.initialiseContract(payload("b1", bare), {} as any, {} as any);
    expect(inst("b1").event).to.equal(undefined);
    expect("setEvent" in inst("b1")).to.equal(false);
  });

  it("simple pass-through accessors", () => {
    expect(cc.getActivityStreams("u1")).to.deep.equal({ r: "stream" });
    cc.setInternodeComms("u1", { c: 1 }, 5);
    expect(cc.getInternodeComms("u1")).to.deep.equal([5, { c: 1 }]);
    expect(cc.clearInternodeComms("u1")).to.equal("cleared");
    expect(cc.returnContractData("u1")).to.equal("remote");
    expect(cc.throwFrom("u1")).to.deep.equal(["a", "b"]);
    expect(cc.getTimeout("u1")).to.equal("T");
    expect(cc.getTimeout("nope")).to.equal(null);
  });

  it("getContractData only exports when updated", () => {
    expect(cc.getContractData("u1")).to.equal(undefined);
    inst("u1").updatedContractData = true;
    expect(cc.getContractData("u1")).to.deep.equal({ exported: true });
  });

  it("runRead returns the method result, false when missing or falsy", async () => {
    expect(await cc.runRead("u1", "readMe")).to.equal("read!");
    expect(await cc.runRead("u1", "readFalsy")).to.equal(false);
    expect(await cc.runRead("u1", "missing")).to.equal(false);
  });

  it("runVerify passes sigless and defaults to true when verify absent or falsy", async () => {
    expect(await cc.runVerify("u1", false)).to.equal("v");
    expect(await cc.runVerify("u1", true)).to.equal(true); // verify returned false -> true
    expect(await cc.runVerify("b1", false)).to.equal(true);
  });

  it("runVote resolves the contract vote, false on a throw", async () => {
    expect(await cc.runVote("u1")).to.equal("voted");
    expect(await cc.runVote("b1")).to.equal(false);
  });

  it("runCommit passes territoriality, rejects with message on a throw", async () => {
    expect(await cc.runCommit("u1", true)).to.equal("committed:true");
    expect(await cc.runCommit("u1", false)).to.equal("committed:false");
    let err: any;
    try {
      await cc.runCommit("b1", false);
    } catch (e) {
      err = e;
    }
    expect(err).to.equal("Commit Try/Catch Failed");
  });

  it("postProcess and reconcile resolve undefined when contract lacks them", async () => {
    expect(await cc.postProcess("u1", true, "me")).to.equal("pp:true:me");
    expect(await cc.postProcess("b1", true, "me")).to.equal(undefined);
    expect(await cc.reconcile("u1")).to.equal("rec");
    expect(await cc.reconcile("b1")).to.equal(undefined);
  });

  it("sysConfig / reloadSysConfig only act when the contract supports them", () => {
    cc.setSysConfig("u1", { k: 1 });
    expect(inst("u1").cfg).to.deep.equal({ k: 1 });
    cc.setSysConfig("b1", { k: 1 });
    expect(inst("b1").cfg).to.equal(undefined);
    expect(cc.reloadSysConfig("u1")).to.equal("reloaded");
    expect(cc.reloadSysConfig("b1")).to.equal(false);
  });

  describe("destroy", () => {
    let realST: typeof setTimeout;
    let scheduled: Array<{ fn: () => void; ms: number }>;
    beforeEach(() => {
      realST = global.setTimeout;
      scheduled = [];
      (global as any).setTimeout = (fn: () => void, ms: number) => {
        scheduled.push({ fn, ms });
        return 0;
      };
    });
    afterEach(() => {
      global.setTimeout = realST;
    });

    it("calls shutdown now and deletes after 5000ms", () => {
      (global as any).__shutdown = 0;
      cc.destroy("u4");
      expect((global as any).__shutdown).to.equal(1);
      expect(scheduled).to.have.length(1);
      expect(scheduled[0].ms).to.equal(5000);
      expect(inst("u4")).to.not.equal(undefined);
      scheduled[0].fn();
      expect(inst("u4")).to.equal(undefined);
    });

    it("no shutdown when contract lacks it, and tolerates unknown umids", () => {
      (global as any).__shutdown = 0;
      cc.destroy("b1");
      cc.destroy("never-existed");
      expect((global as any).__shutdown).to.equal(0);
      expect(scheduled).to.have.length(2);
      scheduled[0].fn();
      expect(inst("b1")).to.equal(undefined);
    });

    it("swallows a throwing shutdown and schedules nothing", () => {
      inst("u2").shutdown = () => {
        throw new Error("boom");
      };
      expect(() => cc.destroy("u2")).to.not.throw();
      expect(scheduled).to.have.length(0);
    });
  });
});
