import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { Activity } from "../packages/contracts/src/stream";
import Contract from "../packages/activeledger/src/contracts/default/contract";
import { ActiveOptions } from "@activeledger/activeoptions";

// The lock tests with a stub stream passed while unlock was broken: the real
// Activity merges what setState is given over its state, so a deleted key
// came straight back. These run the entries against the real class.
describe("Contract locks against a real activity stream (Activeledger)", () => {
  const id = "c".repeat(64);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-realstream-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts/testns", { recursive: true });
    fs.writeFileSync(`contracts/testns/${id}.js`, "");
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const stream = () =>
    new Activity("umid", null, false, new EventEmitter(), { _id: `${id}:stream`, _rev: null } as any, {
      _id: id,
      _rev: null,
      namespace: "testns",
      contract: { "1.0.0": "x", "1.1.0": "y" },
    } as any, "umid", true);

  const context = (out: Activity, version: string) => ({
    namespace: "testns",
    contract: id,
    version: version ? "@" + version : "",
    rootDir: "./contracts/",
    transactions: { $i: { who: { namespace: "testns", contract: id, version } }, $o: { [id]: {} } },
    identity: { getState: () => ({ namespace: "testns" }) },
    assertDeployerAllowed: () => undefined,
    lockOutput: proto.lockOutput,
    lockHeld: proto.lockHeld,
    getActivityStreams: () => out,
  });
  const run = (fn: string, ctx: any) =>
    new Promise<boolean>((resolve, reject) => proto[fn].call(ctx, resolve, reject));
  const locks = (a: Activity) => (a.getState() as any).locks;

  it("lock, second lock, unlock and the global lock leave the state each node must agree on", async () => {
    const a = stream();
    await run("commitLock", context(a, "1.0.0"));
    await run("commitLock", context(a, "1.1.0"));
    await run("commitLock", context(a, ""));
    expect(locks(a)).to.deep.equal({ all: true, versions: ["1.0.0", "1.1.0"] });

    await run("commitUnlock", context(a, "1.0.0"));
    expect(locks(a)).to.deep.equal({ all: true, versions: ["1.1.0"] });
    await run("commitUnlock", context(a, ""));
    await run("commitUnlock", context(a, "1.1.0"));
    expect(locks(a)).to.deep.equal({ versions: [] });
  });

  it("the vote agrees with the state after each step", async () => {
    const a = stream();
    await run("commitLock", context(a, "1.0.0"));
    let err: any;
    await run("voteLock", context(a, "1.0.0")).catch((e) => (err = e));
    expect(err).to.equal("Lock already exists");
    await run("commitUnlock", context(a, "1.0.0"));
    expect(await run("voteLock", context(a, "1.0.0"))).to.equal(true);
    err = undefined;
    await run("voteUnlock", context(a, "1.0.0")).catch((e) => (err = e));
    expect(err).to.equal("Lock doesn't exists");
  });

  it("two streams given the same transaction end in the same state", async () => {
    const [a, b] = [stream(), stream()];
    for (const s of [a, b]) {
      await run("commitLock", context(s, "1.1.0"));
      await run("commitLock", context(s, "1.0.0"));
    }
    expect(JSON.stringify(a.getState())).to.equal(JSON.stringify(b.getState()));
  });
});
