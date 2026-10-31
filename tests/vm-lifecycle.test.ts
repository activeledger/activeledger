import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { installSandbox } from "../packages/protocol/src/protocol/sandbox";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Drives the VirtualMachine through a real contract module on disk, the way
// the protocol does: initialise, then the phases, reading what the contract
// produced back out.
describe("VirtualMachine phases (Activeprotocol)", () => {
  // tx.$entry picks the behaviour: "fail:<phase>" throws an Error from inside
  // the contract file, "reject:<phase>" throws a plain string
  const source = `
class FakeContract {
  constructor(date, remote, umid, tx, inputs, outputs, readonly, contractData, sigs, key, emitter, selfHost) {
    this.ctor = { date, remote, umid, tx, inputs, outputs, readonly, contractData, sigs, key, emitter, selfHost };
    this.mode = tx.$entry || "";
    this.calls = [];
    this.throwTo = ["elsewhere"];
    this.comms = null;
  }
  gate(phase) {
    if (this.mode === "fail:" + phase) throw new Error("contract " + phase + " failed");
    if (this.mode === "reject:" + phase) throw "plain " + phase + " rejection";
  }
  verify(sigless) { this.gate("verify"); this.calls.push(["verify", sigless]); return this.mode === "falsy:verify" ? false : "verified"; }
  async vote() { this.gate("vote"); this.calls.push(["vote"]); if (this.mode === "hang:vote") return new Promise(() => {}); return this.mode === "leader" ? { leader: true } : true; }
  async commit(t) { this.gate("commit"); this.calls.push(["commit", t]); }
  reconcile() { this.gate("reconcile"); this.calls.push(["reconcile"]); return "reconciled"; }
  postProcess(t, who) { this.gate("post"); this.calls.push(["post", t, who]); return "posted"; }
  read() { this.gate("read"); return this.mode === "falsy:read" ? 0 : { read: true }; }
  getTimeout() { return this.timeoutRequest; }
  getActivityStreams() { return this.activities || {}; }
  getThisInterNodeComms() { return { some: "comms" }; }
  getClearInterNodeComms() { return true; }
  getReturnToRemote() { return { back: "to client" }; }
  setInterNodeComms(key, comms) { this.comms = { key, comms }; }
  exportContractData() { return { _id: "contract-data", data: 1 }; }
}
exports.default = FakeContract;
`;

  let dir: string;
  let location: string;
  let vm: VirtualMachine;
  let n = 0;
  const savedConfig: { [k: string]: any } = {};
  const setOption = (k: string, v: any) => {
    if (!(k in savedConfig)) savedConfig[k] = (ActiveOptions as any).config?.[k];
    ActiveOptions.set(k, v);
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-phases-"));
    location = path.join(dir, "fakecontract.js");
    fs.writeFileSync(location, source);
    installSandbox();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vm = new VirtualMachine("localhost:5259", {} as any, {} as any);
    VirtualMachine.registerIsolateBackend(null);
    setOption("contractCheckTimeout", 5000);
  });

  afterEach(() => {
    VirtualMachine.registerIsolateBackend(null);
    for (const k of Object.keys(savedConfig)) {
      if (savedConfig[k] === undefined) delete (ActiveOptions as any).config[k];
      else ActiveOptions.set(k, savedConfig[k]);
      delete savedConfig[k];
    }
  });

  const payload = (umid: string, entry = "", namespace = "ns", extra: any = {}) => ({
    contractLocation: location,
    umid,
    date: new Date("2024-01-02T03:04:05.000Z"),
    remoteAddress: "10.0.0.9",
    transaction: { $namespace: namespace, $contract: "c", $entry: entry, $i: {}, $o: {} } as any,
    signatures: { s: "sig" } as any,
    inputs: [{ _id: "in" }] as any,
    outputs: [{ _id: "out" }] as any,
    readonly: { ro: 1 } as any,
    key: 4242,
    ...extra,
  });

  const start = async (entry = "", namespace = "ns", extra: any = {}) => {
    const umid = `umid-${n++}`;
    await vm.initialise(payload(umid, entry, namespace, extra), "fakecontract", extra.__execution);
    return { umid, contract: (vm as any).smartContracts[umid] };
  };

  describe("initialise", () => {
    it("constructs the contract with the transaction's context", async () => {
      const { umid, contract } = await start("", "ns", {
        contractData: { _id: "cd", data: { x: 1 } },
      });
      expect(contract.ctor.umid).to.equal(umid);
      expect(contract.ctor.remote).to.equal("10.0.0.9");
      expect(contract.ctor.key).to.equal(4242);
      expect(contract.ctor.selfHost).to.equal("localhost:5259");
      expect(contract.ctor.inputs).to.deep.equal([{ _id: "in" }]);
      expect(contract.ctor.outputs).to.deep.equal([{ _id: "out" }]);
      expect(contract.ctor.readonly).to.deep.equal({ ro: 1 });
      expect(contract.ctor.sigs).to.deep.equal({ s: "sig" });
      expect(contract.ctor.contractData).to.deep.equal({ _id: "cd", data: { x: 1 } });
      expect(vm.getInputs(umid)).to.deep.equal([{ _id: "in" }]);
    });

    it("hands the contract empty data when it has none stored", async () => {
      const { contract } = await start("", "ns", { contractData: { _id: "cd" } });
      expect(contract.ctor.contractData).to.deep.equal({});
    });

    it("tells a hybrid contract which mode it runs in", async () => {
      await start();
      const Ctor = (vm as any).contracts[location];
      const modes: boolean[] = [];
      Ctor.prototype.setHostMode = function (supernode: boolean) {
        modes.push(supernode);
      };
      try {
        await start("", "ns", { __execution: { supernode: false, dryRun: true } });
        await start("", "ns", { __execution: { supernode: true } });
        await start();
      } finally {
        delete Ctor.prototype.setHostMode;
      }
      // An ordinary execution carries no mode at all
      expect(modes).to.deep.equal([false, true]);
    });

    it("gates reserved stream names on the node's build", async () => {
      await start();
      const Ctor = (vm as any).contracts[location];
      const seen: boolean[] = [];
      Ctor.prototype.setReservedStreams = function (v: boolean) {
        seen.push(v);
      };
      try {
        setOption("build", 40299);
        await start();
        setOption("build", 40300);
        await start();
      } finally {
        delete Ctor.prototype.setReservedStreams;
      }
      expect(seen).to.deep.equal([false, true]);
    });

    it("passes setEvent the transaction's event engine", async () => {
      const first = await start();
      const Ctor = (vm as any).contracts[location];
      let got: any;
      Ctor.prototype.setEvent = function (e: any) {
        got = e;
      };
      try {
        const { umid } = await start();
        expect(got).to.not.equal(undefined);
        expect(vm.getEvents(umid)).to.deep.equal([]);
        expect(first.umid).to.not.equal(umid);
      } finally {
        delete Ctor.prototype.setEvent;
      }
    });

    it("gives default namespace contracts a copy of the system configuration", async () => {
      const first = await start("", "default");
      void first;
      const Ctor = (vm as any).contracts[location];
      let cfg: any;
      Ctor.prototype.sysConfig = function (c: any) {
        cfg = c;
      };
      try {
        setOption("marker", "present");
        await start("", "default");
        expect(cfg).to.have.property("marker", "present");
        cfg = undefined;
        await start("", "ns");
        expect(cfg).to.equal(undefined);
      } finally {
        delete Ctor.prototype.sysConfig;
      }
    });

    it("rejects with a formatted error when the contract cannot be loaded", async () => {
      let error: any;
      try {
        await vm.initialise(
          { ...payload("bad-load"), contractLocation: path.join(dir, "missing.js") },
          "missing"
        );
      } catch (e) {
        error = e;
      }
      expect(error.error).to.contain("Cannot find module");
    });

    describe("isolation policy", () => {
      it("refuses to run a non-privileged contract in-process when none is registered", async () => {
        setOption("security", { contractIsolation: "isolate" });
        let error: any;
        try {
          await vm.initialise(payload("iso-1"), "fakecontract");
        } catch (e) {
          error = e;
        }
        expect(error.error).to.contain("no isolate backend is registered");
        expect(error.error).to.contain("fakecontract");
        expect((vm as any).smartContracts["iso-1"]).to.equal(undefined);
      });

      it("loads once through the backend and instantiates per transaction", async () => {
        setOption("security", { contractIsolation: "isolate" });
        let loads = 0;
        const instantiated: any[] = [];
        VirtualMachine.registerIsolateBackend({
          load: async (loc: string) => {
            loads++;
            return {
              instantiate: (args: any[]) => {
                instantiated.push([loc, args]);
                return { isolated: true, args };
              },
            };
          },
        } as any);
        await vm.initialise(payload("iso-2"), "fakecontract");
        await vm.initialise(payload("iso-3"), "fakecontract");
        expect(loads).to.equal(1);
        expect(instantiated).to.have.length(2);
        expect(instantiated[0][0]).to.equal(location);
        expect(instantiated[0][1][2]).to.equal("iso-2");
        expect((vm as any).smartContracts["iso-3"].isolated).to.equal(true);
      });

      it("never isolates the node's own default namespace", async () => {
        setOption("security", { contractIsolation: "isolate" });
        const { contract } = await start("", "default");
        expect(contract.ctor.tx.$namespace).to.equal("default");
      });
    });
  });

  describe("phases", () => {
    it("verify passes the sigless flag and returns the contract's answer", async () => {
      const { umid, contract } = await start();
      expect(await vm.verify(true, umid)).to.equal("verified");
      expect(contract.calls).to.deep.equal([["verify", true]]);
    });

    it("verify treats a falsy answer as success", async () => {
      const { umid } = await start("falsy:verify");
      expect(await vm.verify(false, umid)).to.equal(true);
    });

    it("vote returns the contract's answer, including a leader object", async () => {
      const a = await start();
      expect(await vm.vote({}, a.umid)).to.equal(true);
      const b = await start("leader");
      expect(await vm.vote({}, b.umid)).to.deep.equal({ leader: true });
    });

    it("commit resolves true and passes territoriality", async () => {
      const { umid, contract } = await start();
      expect(await vm.commit({}, true, umid)).to.equal(true);
      expect(contract.calls).to.deep.equal([["commit", true]]);
    });

    it("commit defaults territoriality to false", async () => {
      const { umid, contract } = await start();
      await vm.commit({}, undefined, umid);
      expect(contract.calls).to.deep.equal([["commit", false]]);
    });

    it("reconcile runs the contract's reconcile when it has one", async () => {
      const { umid } = await start();
      expect(await vm.reconcile({}, umid)).to.equal("reconciled");
    });

    it("reconcile resolves undefined when the contract has no reconcile", async () => {
      const { umid, contract } = await start();
      contract.reconcile = undefined;
      expect(await vm.reconcile({}, umid)).to.equal(undefined);
    });

    it("read calls the named method and returns its result", async () => {
      const { umid } = await start();
      expect(await vm.read(umid, "read")).to.deep.equal({ read: true });
    });

    it("read resolves false when the method is missing or returns nothing", async () => {
      const a = await start();
      expect(await vm.read(a.umid, "doesNotExist")).to.equal(false);
      const b = await start("falsy:read");
      expect(await vm.read(b.umid, "read")).to.equal(false);
    });

    it("postProcess passes territoriality and who", async () => {
      const { umid, contract } = await start();
      expect(await vm.postProcess(true, "node-a", umid)).to.equal("posted");
      expect(contract.calls).to.deep.equal([["post", true, "node-a"]]);
    });

    it("postProcess resolves undefined when the contract has none", async () => {
      const { umid } = await start();
      (vm as any).smartContracts[umid] = {};
      expect(await vm.postProcess(false, "n", umid)).to.equal(undefined);
    });

    it("postProcess on a VM that has run nothing resolves undefined", async () => {
      const fresh = new VirtualMachine("localhost:5259", {} as any, {} as any);
      expect(await fresh.postProcess(true, "n", "unknown-umid")).to.equal(undefined);
    });

    it("postProcess does nothing on a dry run", async () => {
      const { umid, contract } = await start("", "ns", {
        __execution: { supernode: true, dryRun: true },
      });
      expect(await vm.postProcess(true, "n", umid)).to.equal(undefined);
      expect(contract.calls).to.deep.equal([]);
    });

    const phases: [string, string, (vm: VirtualMachine, umid: string) => Promise<any>][] = [
      ["verify", "verify", (v, u) => v.verify(false, u)],
      ["vote", "vote", (v, u) => v.vote({}, u)],
      ["commit", "commit", (v, u) => v.commit({}, false, u)],
      ["reconcile", "reconcile", (v, u) => v.reconcile({}, u)],
      ["post", "post", (v, u) => v.postProcess(false, "n", u)],
      ["read", "read", (v, u) => v.read(u, "read")],
    ];

    for (const [name, phase, run] of phases) {
      it(`${name}: an Error thrown by the contract rejects with its message and location`, async () => {
        const { umid } = await start(`fail:${phase}`);
        let error: any;
        try {
          await run(vm, umid);
        } catch (e) {
          error = e;
        }
        expect(error).to.have.property("error", `contract ${phase} failed`);
        expect(error.at).to.match(/^fakecontract\.js:\d+:\d+\)?$/);
      });

      it(`${name}: a plain value thrown by the contract is passed through untouched`, async () => {
        const { umid } = await start(`reject:${phase}`);
        let error: any;
        try {
          await run(vm, umid);
        } catch (e) {
          error = e;
        }
        expect(error).to.equal(`plain ${phase} rejection`);
      });

      it(`${name}: rejects when the contract is gone`, async () => {
        let error: any;
        // A VM that has initialised something else, as in a running worker
        await start();
        try {
          await run(vm, "never-initialised");
        } catch (e) {
          error = e;
        }
        if (name === "reconcile" || name === "post") {
          // These carry on without a contract and resolve with nothing
          expect(error).to.equal(undefined);
        } else {
          expect(error).to.equal("VM Error : Contract not found");
        }
      });
    }

    it("includes the offending source line when debug is on", async () => {
      setOption("debug", true);
      const { umid } = await start("fail:commit");
      let error: any;
      try {
        await vm.commit({}, false, umid);
      } catch (e) {
        error = e;
      }
      const lines = source.split("\n");
      const throwing = lines.find((l) => l.includes('throw new Error("contract "'))!;
      expect(error.line).to.equal(throwing.trim());
    });
  });

  describe("timeouts", () => {
    it("rejects a phase that outlives contractCheckTimeout", async () => {
      setOption("contractCheckTimeout", 20);
      const { umid } = await start("hang:vote");
      let error: any;
      try {
        await vm.vote({}, umid);
      } catch (e) {
        error = e;
      }
      expect(error).to.equal("VM Error : Vote phase timeout");
    });

    it("lets a contract extend within the maximum, then times out when it stops", async () => {
      setOption("contractCheckTimeout", 20);
      const { umid, contract } = await start("hang:vote");
      let asked = 0;
      contract.getTimeout = () => {
        asked++;
        return asked < 3 ? new Date(Date.now() + 60000) : null;
      };
      let error: any;
      try {
        await vm.vote({}, umid);
      } catch (e) {
        error = e;
      }
      expect(error).to.equal("VM Error : Vote phase timeout");
      expect(asked).to.equal(3);
    });

    it("ignores an extension beyond the configured maximum", async () => {
      setOption("contractCheckTimeout", 20);
      setOption("contractMaxTimeout", 1);
      const { umid, contract } = await start("hang:vote");
      contract.getTimeout = () => new Date(Date.now() + 10 * 60 * 1000);
      let error: any;
      try {
        await vm.vote({}, umid);
      } catch (e) {
        error = e;
      }
      expect(error).to.equal("VM Error : Vote phase timeout");
    });

    it("ignores an extension already in the past", async () => {
      setOption("contractCheckTimeout", 20);
      const { umid, contract } = await start("hang:vote");
      contract.getTimeout = () => new Date(Date.now() - 1000);
      let error: any;
      try {
        await vm.vote({}, umid);
      } catch (e) {
        error = e;
      }
      expect(error).to.equal("VM Error : Vote phase timeout");
    });

    it("does not fire for a phase that finished", async () => {
      setOption("contractCheckTimeout", 20);
      const { umid } = await start();
      await vm.verify(false, umid);
      await new Promise((r) => setTimeout(r, 60));
      expect((vm as any).timeoutTimers[umid]).to.equal(undefined);
    });
  });

  describe("inter node comms", () => {
    it("hands the contract only the comms nodes actually sent", async () => {
      const { umid, contract } = await start();
      await vm.vote(
        {
          a: { incomms: { hello: 1 } },
          b: {},
          c: { incomms: { bye: 2 } },
        } as any,
        umid
      );
      expect(contract.comms.key).to.equal(4242);
      expect(contract.comms.comms).to.deep.equal({
        a: { hello: 1 },
        c: { bye: 2 },
      });
    });

    it("does not touch the contract when no node sent comms", async () => {
      const { umid, contract } = await start();
      await vm.vote({ a: {}, b: {} } as any, umid);
      expect(contract.comms).to.equal(null);
    });
  });

  describe("reading results back out", () => {
    it("exposes the contract's outputs", async () => {
      const { umid } = await start();
      expect(vm.getInternodeCommsFromVM(umid)).to.deep.equal({ some: "comms" });
      expect(vm.clearingInternodeCommsFromVM(umid)).to.equal(true);
      expect(vm.getReturnContractData(umid)).to.deep.equal({ back: "to client" });
      expect(vm.getThrowsFromVM(umid)).to.deep.equal(["elsewhere"]);
    });

    it("returns safe defaults once the contract is gone", () => {
      expect(vm.getInternodeCommsFromVM("gone")).to.equal(null);
      expect(vm.clearingInternodeCommsFromVM("gone")).to.equal(false);
      expect(vm.getReturnContractData("gone")).to.equal(null);
      expect(vm.getThrowsFromVM("gone")).to.deep.equal([]);
      expect(vm.getActivityStreamsFromVM("gone")).to.deep.equal([]);
      expect(vm.getNewContractData("gone")).to.equal(false);
      expect(vm.getEvents("gone")).to.deep.equal([]);
    });

    it("reports new contract data only when the contract updated it", async () => {
      const { umid, contract } = await start();
      expect(vm.getNewContractData(umid)).to.equal(false);
      contract.updatedContractData = true;
      expect(vm.getNewContractData(umid)).to.deep.equal({ _id: "contract-data", data: 1 });
    });

    describe("getActivityStreamsFromVM", () => {
      const activity = (over: any = {}) => ({
        updated: true,
        state: { v: 1 },
        updatedMeta: false,
        meta: { name: "meta" },
        volatileUpdated: false,
        volatile: { vol: 1 },
        ...over,
      });

      it("exports only streams that changed, with their state", async () => {
        const { umid, contract } = await start();
        contract.activities = {
          one: activity(),
          two: activity({ updated: false }),
        };
        const out = vm.getActivityStreamsFromVM(umid);
        expect(out).to.deep.equal([{ state: { v: 1 } }]);
      });

      it("puts changed contract data first", async () => {
        const { umid, contract } = await start();
        contract.updatedContractData = true;
        contract.activities = { one: activity() };
        const out = vm.getActivityStreamsFromVM(umid);
        expect(out).to.have.length(2);
        expect(out[0]).to.deep.equal({ _id: "contract-data", data: 1 });
      });

      it("includes meta only when it changed, and volatile only when updated", async () => {
        const { umid, contract } = await start();
        contract.activities = {
          m: activity({ updatedMeta: true, meta: { name: "n" } }),
          v: activity({ volatileUpdated: true }),
        };
        const out = vm.getActivityStreamsFromVM(umid) as any[];
        const withMeta = out.find((s) => s.meta);
        const withVol = out.find((s) => s.volatile);
        expect(withMeta.meta).to.deep.equal({ name: "n" });
        expect(withMeta.volatile).to.equal(undefined);
        expect(withVol.volatile).to.deep.equal({ vol: 1 });
        expect(withVol.meta).to.equal(undefined);
      });

      describe("staged rollout of meta fields", () => {
        const meta = () => ({
          authorities: [{ expire: 99, umid: "u", other: "keep" }],
          removedAuthorities: ["x"],
        });
        const exported = async (build: number) => {
          setOption("build", build);
          const { umid, contract } = await start();
          contract.activities = { m: activity({ updatedMeta: true, meta: meta() }) };
          return (vm.getActivityStreamsFromVM(umid) as any[])[0].meta;
        };

        it("below 40000 strips expiry, authority umids and removed authorities", async () => {
          const m = await exported(39999);
          expect(m.authorities).to.deep.equal([{ other: "keep" }]);
          expect(m.removedAuthorities).to.equal(undefined);
        });

        it("from 40000 keeps authority umids and removed authorities but still strips expiry below 40100", async () => {
          const m = await exported(40000);
          expect(m.authorities).to.deep.equal([{ umid: "u", other: "keep" }]);
          expect(m.removedAuthorities).to.deep.equal(["x"]);
        });

        it("from 40100 keeps expiry", async () => {
          const m = await exported(40100);
          expect(m.authorities).to.deep.equal([{ expire: 99, umid: "u", other: "keep" }]);
        });
      });
    });
  });

  describe("destroy", () => {
    it("calls the contract's shutdown and clears its pending timer", async () => {
      const { umid, contract } = await start();
      let shutdown = 0;
      contract.shutdown = () => shutdown++;
      (vm as any).timeoutTimers[umid] = setTimeout(() => undefined, 60000);
      const timer = (vm as any).timeoutTimers[umid];
      vm.destroy(umid);
      expect(shutdown).to.equal(1);
      expect((vm as any).timeoutTimers[umid]).to.equal(undefined);
      clearTimeout(timer);
    });

    it("forgets the key references straight away and the contract after a delay", async () => {
      const timers = require("timers");
      const real = timers.setTimeout;
      const queued: (() => void)[] = [];
      timers.setTimeout = (fn: () => void) => {
        queued.push(fn);
        return 0;
      };
      try {
        const { umid } = await start("", "ns", {
          __execution: { supernode: true },
        });
        vm.destroy(umid);
        expect(() => vm.getInputs(umid)).to.throw();
        expect((vm as any).smartContracts[umid]).to.not.equal(undefined);
        queued.forEach((f) => f());
        expect((vm as any).smartContracts[umid]).to.equal(undefined);
        expect((vm as any).events[umid]).to.equal(undefined);
        expect((vm as any).executions[umid]).to.equal(undefined);
        expect(vm.getEvents(umid)).to.deep.equal([]);
      } finally {
        timers.setTimeout = real;
      }
    });

    it("leaves a newer execution of the same umid alone", async () => {
      const timers = require("timers");
      const real = timers.setTimeout;
      const queued: (() => void)[] = [];
      timers.setTimeout = (fn: () => void) => {
        queued.push(fn);
        return 0;
      };
      try {
        const execution = { supernode: true };
        const { umid } = await start("", "ns", { __execution: execution });
        vm.destroy(umid);
        // The same umid starts again (dry run, then the real item)
        await vm.initialise(
          payload(umid),
          "fakecontract",
          { supernode: true, dryRun: false }
        );
        const again = (vm as any).smartContracts[umid];
        queued.forEach((f) => f());
        expect((vm as any).smartContracts[umid]).to.equal(again);
        expect((vm as any).executions[umid]).to.not.equal(undefined);
      } finally {
        timers.setTimeout = real;
      }
    });
  });

  describe("reload requests", () => {
    it("are taken once, only after a default contract asked for one", async () => {
      const { umid, contract } = await start("", "default");
      contract.sysConfig = () => undefined;
      contract.configReload = () => true;
      await vm.postProcess(true, "n", umid);
      expect(vm.takeReloadRequest(umid)).to.equal(true);
      expect(vm.takeReloadRequest(umid)).to.equal(false);
    });

    it("are not raised when the contract does not want a reload", async () => {
      const { umid, contract } = await start("", "default");
      contract.sysConfig = () => undefined;
      contract.configReload = () => false;
      await vm.postProcess(true, "n", umid);
      expect(vm.takeReloadRequest(umid)).to.equal(false);
    });

    it("are ignored outside the default namespace", async () => {
      const { umid, contract } = await start("", "ns");
      contract.sysConfig = () => undefined;
      contract.configReload = () => true;
      await vm.postProcess(true, "n", umid);
      expect(vm.takeReloadRequest(umid)).to.equal(false);
    });
  });

  describe("execution report", () => {
    it("is empty and independent of supernodes for an ordinary contract", async () => {
      const { umid } = await start();
      expect(vm.getExecutionReport(umid)).to.deep.equal({
        supernodeDependent: false,
        dependence: [],
        adopt: [],
      });
    });

    it("merges what the host saw with what the contract recorded, without duplicates", async () => {
      const { umid, contract } = await start("", "ns", {
        __execution: { supernode: false },
      });
      contract.getSupernodeDependence = () => ["isSupernode", "blocked:http"];
      contract.exportAdoptDeclarations = () => [{ adopt: 1 }];
      (vm as any).markHostDependent(umid, "blocked:http");
      (vm as any).markHostDependent(umid, "blocked:http");
      const report = vm.getExecutionReport(umid);
      expect(report.supernodeDependent).to.equal(true);
      expect(report.dependence).to.deep.equal(["blocked:http", "isSupernode"]);
      expect(report.adopt).to.deep.equal([{ adopt: 1 }]);
    });

    it("records a blocked outbound call made inside a hybrid contract", async () => {
      const { umid, contract } = await start("", "ns", {
        __execution: { supernode: false },
      });
      contract.verify = () => {
        require("http").get("http://127.0.0.1:1/");
      };
      let error: any;
      try {
        await vm.verify(false, umid);
      } catch (e) {
        error = e;
      }
      expect(error).to.have.property("error");
      expect(vm.getExecutionReport(umid).dependence).to.deep.equal(["blocked:http"]);
    });

    it("does not sandbox a supernode execution", async () => {
      const { umid, contract } = await start("", "ns", {
        __execution: { supernode: true },
      });
      contract.verify = () => {
        const req = require("http").get("http://127.0.0.1:1/");
        req.on("error", () => undefined);
        return true;
      };
      expect(await vm.verify(false, umid)).to.equal(true);
      expect(vm.getExecutionReport(umid).supernodeDependent).to.equal(false);
    });
  });

  describe("host data requests from a contract", () => {
    const fakeDb = (docs: any) => ({
      get: async (id: string) => {
        if (id in docs) return docs[id];
        throw new Error("missing " + id);
      },
    });
    const once = (emitter: any, event: string) =>
      new Promise<any[]>((resolve) => emitter.once(event, (...a: any[]) => resolve(a)));

    it("answers getVolatile from the node's own database", async () => {
      const db = fakeDb({ "s1:volatile": { v: 1 } });
      const machine = new VirtualMachine("h", db as any, {} as any);
      const emitter = (machine as any).emitter;
      const reply = once(emitter, "volatileFetched-u1s1");
      emitter.emit("getVolatile", "u1", "s1");
      expect(await reply).to.deep.equal([null, { v: 1 }]);
    });

    it("answers getVolatile with the error when the stream has none", async () => {
      const machine = new VirtualMachine("h", fakeDb({}) as any, {} as any);
      const emitter = (machine as any).emitter;
      const reply = once(emitter, "volatileFetched-u1s2");
      emitter.emit("getVolatile", "u1", "s2");
      const [err] = await reply;
      expect(err.message).to.equal("missing s2:volatile");
    });

    it("answers getStreamData, preferring the execution's own database", async () => {
      const machine = new VirtualMachine("h", fakeDb({ s3: { from: "node" } }) as any, {} as any);
      (machine as any).executions["u3"] = { supernode: false, db: fakeDb({ s3: { from: "hybrid" } }) };
      const emitter = (machine as any).emitter;
      const hybrid = once(emitter, "getStreamDataFetched-u3s3");
      emitter.emit("getStreamData", "u3", "s3");
      expect(await hybrid).to.deep.equal([null, { from: "hybrid" }]);
      const node = once(emitter, "getStreamDataFetched-u4s3");
      emitter.emit("getStreamData", "u4", "s3");
      expect(await node).to.deep.equal([null, { from: "node" }]);
    });

    it("answers getStreamData with the error for an unknown stream", async () => {
      const machine = new VirtualMachine("h", fakeDb({}) as any, {} as any);
      const emitter = (machine as any).emitter;
      const reply = once(emitter, "getStreamDataFetched-u5nope");
      emitter.emit("getStreamData", "u5", "nope");
      const [err] = await reply;
      expect(err.message).to.equal("missing nope");
    });
  });

  describe("catchException", () => {
    const format = (e: Error, umid: string) => (vm as any).catchException(e, umid);

    it("returns just the message when nothing is known about the contract", async () => {
      expect(await format(new Error("plain"), "unknown")).to.equal("plain");
    });

    it("degrades to the first stack frame when the contract is not in the trace", async () => {
      await start();
      const umid = `umid-${n - 1}`;
      const e = new Error("elsewhere");
      e.stack = "Error: elsewhere\n    at helper (/lib/other.js:10:5)\n    at more (/lib/x.js:1:1)";
      expect(await format(e, umid)).to.deep.equal({
        error: "elsewhere",
        at: "fakecontract:10:5",
      });
    });

    it("reports an empty line in debug mode when the line is past the end of the file", async () => {
      setOption("debug", true);
      await start();
      const umid = `umid-${n - 1}`;
      const e = new Error("far");
      e.stack = `Error: far\n    at X (${location}:9999:1)`;
      const out = await format(e, umid);
      expect(out.error).to.equal("far");
      expect(out.at).to.equal("fakecontract.js:9999:1)");
      expect(out.line).to.equal("");
    });
  });
});
