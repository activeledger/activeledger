import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Contract from "../packages/activeledger/src/contracts/default/contract";
import { Contract as RestoreContract } from "../packages/restore/src/modules/contract/contract";
import { ActiveOptions } from "@activeledger/activeoptions";

// A lock is a file on each node. Recorded on the contract stream as well, a
// restore can write it back, and a node without the file still agrees it is held.
describe("Contract locks are recorded on the contract stream (Activeledger)", () => {
  const stream = "c".repeat(64);
  const proto = (Contract as any).prototype;
  let tmpDir: string;
  let cwd: string;
  let originalBuild: any;

  before(() => {
    originalBuild = ActiveOptions.get("build", 0);
    ActiveOptions.set("build", 40300);
  });
  after(() => ActiveOptions.set("build", originalBuild));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-lockstate-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts/testns", { recursive: true });
    fs.writeFileSync(`contracts/testns/${stream}.js`, "");
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const context = (st: any, version?: string, outputs: any = { [stream]: {} }) => ({
    namespace: "testns",
    contract: stream,
    version: version ? "@" + version : "",
    rootDir: "./contracts/",
    transactions: { $i: { id: { namespace: "testns", contract: stream, version } }, $o: outputs },
    identity: { getState: () => ({ namespace: "testns" }) },
    assertDeployerAllowed: () => undefined,
    lockOutput: proto.lockOutput,
    lockHeld: proto.lockHeld,
    // As the real stream: a copy out, a shallow merge in (a deleted key comes back)
    getActivityStreams: () => ({ getState: () => JSON.parse(JSON.stringify(st)), setState: (n: any) => Object.assign(st, n) }),
  });
  const own = (more: any = {}) => ({ namespace: "testns", contract: {}, ...more });
  const run = (fn: string, ctx: any) =>
    new Promise<boolean>((resolve, reject) => proto[fn].call(ctx, resolve, reject));
  const files = () => fs.readdirSync("contracts/testns").filter((f) => f.startsWith("_LOCK.")).sort();

  it("a contract of another namespace cannot be locked or unlocked through its state", async () => {
    const st: any = { namespace: "other", contract: {}, locks: { versions: ["1.0.0"] } };
    for (const fn of ["voteLock", "voteUnlock"]) {
      let err: any;
      await run(fn, context(st, "1.0.0")).catch((e) => (err = e));
      expect(err, fn).to.contain("in the namespace");
    }
    expect(st.locks).to.deep.equal({ versions: ["1.0.0"] });
  });

  it("a lock and an unlock of one version are written to the state and removed from it", async () => {
    const st: any = own();
    expect(await run("voteLock", context(st, "1.0.0"))).to.equal(true);
    await run("commitLock", context(st, "1.0.0"));
    expect(st.locks).to.deep.equal({ versions: ["1.0.0"] });
    expect(files()).to.deep.equal([`_LOCK.${stream}@1.0.0`]);
    await run("commitUnlock", context(st, "1.0.0"));
    expect(st.locks).to.deep.equal({ versions: [] });
    expect(files()).to.deep.equal([]);
  });

  it("the global lock is recorded as all", async () => {
    const st: any = own();
    await run("commitLock", context(st));
    expect(st.locks).to.deep.equal({ all: true, versions: [] });
    await run("commitLock", context(st, "1.0.0"));
    await run("commitUnlock", context(st));
    expect(st.locks).to.deep.equal({ versions: ["1.0.0"] });
  });

  it("a node that lost the file still sees the lock as held, and can unlock it", async () => {
    const st: any = own({ locks: { versions: ["1.0.0"] } });
    let err: any;
    await run("voteLock", context(st, "1.0.0")).catch((e) => (err = e));
    expect(err).to.equal("Lock already exists");
    expect(await run("voteUnlock", context(st, "1.0.0"))).to.equal(true);
    await run("commitUnlock", context(st, "1.0.0"));
    expect(st.locks).to.deep.equal({ versions: [] });
  });

  it("without an output the lock is files only, as before", async () => {
    const st: any = own();
    await run("commitLock", context(st, "1.0.0", {}));
    expect(st.locks).to.equal(undefined);
    expect(files()).to.deep.equal([`_LOCK.${stream}@1.0.0`]);
  });

  it("an output that is not the contract is refused", async () => {
    let err: any;
    await run("voteLock", context(own(), "1.0.0", { [("d").repeat(64)]: {} })).catch((e) => (err = e));
    expect(err).to.contain("contract stream");
  });

  it("nothing is recorded below the build that every node honours it from", async () => {
    ActiveOptions.set("build", 40200);
    try {
      const st: any = own();
      await run("commitLock", context(st, "1.0.0"));
      expect(st.locks).to.equal(undefined);
    } finally {
      ActiveOptions.set("build", 40300);
    }
  });

  it("restore writes the recorded locks back beside the rebuilt versions", async () => {
    await RestoreContract.rebuild({
      _id: stream,
      namespace: "testns",
      contract: {},
      locks: { all: true, versions: ["1.0.0", "1.1.0"] },
    });
    expect(files()).to.deep.equal([`_LOCK.${stream}`, `_LOCK.${stream}@1.0.0`, `_LOCK.${stream}@1.1.0`]);
  });

  it("restore ignores locks that are not in the shape written", async () => {
    for (const locks of [{ versions: "1.0.0" }, { all: "yes", versions: [1, null, "../x"] }, "all", 7]) {
      await RestoreContract.rebuild({ _id: stream, namespace: "testns", contract: {}, locks });
      expect(files(), JSON.stringify(locks)).to.deep.equal([]);
    }
  });
});
