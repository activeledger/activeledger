import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import { installSandbox } from "../packages/protocol/src/protocol/sandbox";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const source = `
class FakeContract {
  constructor(date, remote, umid, tx) {
    this.mode = tx.$entry || "";
    this.configs = [];
  }
  sysConfig(c) { this.configs.push(c); }
  configReload() { return true; }
  verify() { if (this.mode === "hang:verify") return new Promise(() => {}); return true; }
  readHang() { return new Promise(() => {}); }
  async vote() { return true; }
  async commit() { if (this.mode === "hang:commit") return new Promise(() => {}); }
  async reconcile() { if (this.mode === "hang:reconcile") return new Promise(() => {}); return true; }
  async postProcess() { if (this.mode === "hang:post") return new Promise(() => {}); return "posted"; }
  getTimeout() { return undefined; }
  getThisInterNodeComms() { return null; }
  getClearInterNodeComms() { return false; }
}
exports.default = FakeContract;
`;

describe("VirtualMachine (cov)", () => {
  let dir: string;
  let location: string;
  let vm: VirtualMachine;
  let n = 0;
  const saved: { [k: string]: any } = {};
  const setOption = (k: string, v: any) => {
    if (!(k in saved)) saved[k] = (ActiveOptions as any).config?.[k];
    ActiveOptions.set(k, v);
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-vm-"));
    location = path.join(dir, "covcontract.js");
    fs.writeFileSync(location, source);
    installSandbox();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    vm = new VirtualMachine("localhost:5259", {} as any, {} as any);
    VirtualMachine.registerIsolateBackend(null);
    setOption("contractCheckTimeout", 5000);
  });
  afterEach(() => {
    VirtualMachine.registerIsolateBackend(null);
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete (ActiveOptions as any).config[k];
      else ActiveOptions.set(k, saved[k]);
      delete saved[k];
    }
  });

  const start = async (entry = "", namespace = "ns") => {
    const umid = `cov-umid-${n++}`;
    await vm.initialise(
      {
        contractLocation: location,
        umid,
        date: new Date("2024-01-02T03:04:05.000Z"),
        remoteAddress: "10.0.0.9",
        transaction: { $namespace: namespace, $contract: "c", $entry: entry, $i: {}, $o: {} } as any,
        signatures: {} as any,
        inputs: [] as any,
        outputs: [] as any,
        readonly: {} as any,
        key: 1,
      } as any,
      "covcontract"
    );
    return { umid, contract: (vm as any).smartContracts[umid] };
  };

  const rejected = async (p: Promise<any>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected a rejection");
  };

  describe("phase timeouts", () => {
    beforeEach(() => setOption("contractCheckTimeout", 20));

    it("rejects a commit that never finishes", async () => {
      const { umid } = await start("hang:commit");
      expect(await rejected(vm.commit({}, false, umid))).to.equal("VM Error : Commit phase timeout");
    });

    it("rejects a reconcile that never finishes", async () => {
      const { umid } = await start("hang:reconcile");
      expect(await rejected(vm.reconcile({}, umid))).to.equal("VM Error : Reconcile phase timeout");
    });

    it("rejects a post process that never finishes", async () => {
      const { umid } = await start("hang:post");
      expect(await rejected(vm.postProcess(true, "me", umid))).to.equal("VM Error : Post phase timeout");
    });

    it("rejects a verify that never finishes", async () => {
      const { umid } = await start("hang:verify");
      expect(await rejected(vm.verify(false, umid))).to.equal("VM Error : Verify phase timeout");
    });

    it("rejects a read that never finishes", async () => {
      const { umid } = await start();
      expect(await rejected(vm.read(umid, "readHang"))).to.equal("VM Error : Read phase timeout");
    });

    it("does not reject phases that finish in time", async () => {
      const { umid } = await start();
      expect(await vm.commit({}, false, umid)).to.equal(true);
      expect(await vm.reconcile({}, umid)).to.equal(true);
      expect(await vm.postProcess(true, "me", umid)).to.equal("posted");
      await new Promise((r) => setTimeout(r, 60));
      expect((vm as any).timeoutTimers[umid]).to.equal(undefined);
    });
  });

  describe("destroy", () => {
    it("still forgets the contract references when the contract's shutdown throws", async () => {
      const { umid, contract } = await start();
      contract.shutdown = () => {
        throw new Error("shutdown blew up");
      };
      expect((vm as any).contractReferences[umid]).to.not.equal(undefined);
      expect(() => vm.destroy(umid)).to.not.throw();
      expect((vm as any).contractReferences[umid]).to.equal(undefined);
    });
  });

  describe("system configuration handed to default contracts", () => {
    it("is a fresh copy for every contract, so one cannot alter what the next sees", async () => {
      setOption("security", { signedConsensus: true });
      const a = await start("", "default");
      a.contract.configs[0].security.signedConsensus = false;
      a.contract.configs[0].injected = "by contract";
      const b = await start("", "default");
      expect(b.contract.configs[0].security.signedConsensus).to.equal(true);
      expect(b.contract.configs[0]).to.not.have.property("injected");
      expect(b.contract.configs[0]).to.not.equal(a.contract.configs[0]);
      // and the real configuration is untouched
      expect(ActiveOptions.get<any>("security").signedConsensus).to.equal(true);
    });

    it("follows a configuration change made through ActiveOptions", async () => {
      setOption("security", { signedConsensus: false });
      const before = await start("", "default");
      expect(before.contract.configs[0].security.signedConsensus).to.equal(false);
      setOption("security", { signedConsensus: true });
      const after = await start("", "default");
      expect(after.contract.configs[0].security.signedConsensus).to.equal(true);
    });

    it("is not handed to contracts outside the default namespace", async () => {
      const { contract } = await start("", "ns");
      expect(contract.configs).to.deep.equal([]);
    });

    it("keeps using the snapshot while the configuration version is unchanged", async () => {
      setOption("marker", "one");
      const first = await start("", "default");
      expect(first.contract.configs[0].marker).to.equal("one");
      // changed behind ActiveOptions' back: no version bump, no rebuild
      (ActiveOptions as any).config.marker = "two";
      const second = await start("", "default");
      expect(second.contract.configs[0].marker).to.equal("one");
      ActiveOptions.configVersion++;
      const third = await start("", "default");
      expect(third.contract.configs[0].marker).to.equal("two");
    });

    it("does not mark a snapshot current when it could not be built", async () => {
      setOption("marker", "good");
      const warm = await start("", "default");
      expect(warm.contract.configs[0].marker).to.equal("good");

      // a function cannot be serialised, so the next default contract fails to start
      setOption("unserialisable", () => 1);
      const failure: any = await rejected(
        vm.initialise(
          {
            contractLocation: location,
            umid: "cov-fail",
            date: new Date(),
            remoteAddress: "x",
            transaction: { $namespace: "default", $contract: "c", $i: {}, $o: {} } as any,
            signatures: {} as any,
            inputs: [] as any,
            outputs: [] as any,
            readonly: {} as any,
            key: 1,
          } as any,
          "covcontract"
        )
      );
      expect(failure).to.not.equal(undefined);

      // repaired without a version bump: the failed attempt must not have
      // recorded the new version against the old snapshot
      delete (ActiveOptions as any).config.unserialisable;
      (ActiveOptions as any).config.marker = "repaired";
      const after = await start("", "default");
      expect(after.contract.configs[0].marker).to.equal("repaired");
    });
  });
});
