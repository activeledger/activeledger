import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Contract from "../packages/activeledger/src/contracts/default/contract";
import { ActiveOptions } from "@activeledger/activeoptions";

// An update may retire the versions it replaces in the same commit. Driven
// directly, as contract-commit-shape.test.ts does: what matters is the lock
// files and the refusals, not a contract execution.
describe("Contract update locks the versions it replaces (Activeledger)", () => {
  const base64 = Buffer.from("export default class Example {}\n").toString("base64");
  const streamName = "c".repeat(64);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-lock-test-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts/testns", { recursive: true });
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const state = () => ({
    contract: { "1.0.0": "x", "1.1.0": "y", "1.2.0": "z" },
    compiled: { "1.0.0": streamName, "1.1.0": streamName, "1.2.0": streamName },
  });

  const context = (st: any, input: any) => ({
    umid: "a".repeat(64),
    namespace: "testns",
    name: "example",
    rootDir: "./contracts/",
    transactions: { $i: { identityStream: { contract: base64, namespace: "testns", name: "example", ...input } }, $o: { [streamName]: {} } },
    identity: { getName: () => "identityStream" },
    normaliseLegacyVersions: proto.normaliseLegacyVersions,
    useContractReferences: proto.useContractReferences,
    contractTarget: proto.contractTarget,
    compiledEntry: proto.compiledEntry,
    versionsToLock: proto.versionsToLock,
    transpile: () => "class Example {}",
    getActivityStreams: () => ({ getName: () => streamName, getState: () => st, setState: () => undefined }),
  });

  const update = (ctx: any) =>
    new Promise<void>((resolve, reject) => proto.commitUpdate.call(ctx, () => resolve(), reject));
  const locked = () =>
    fs.readdirSync("contracts/testns").filter((f) => f.startsWith("_LOCK.")).sort();

  it("locks nothing unless asked", async () => {
    await update(context(state(), { version: "2.0.0" }));
    expect(locked()).to.deep.equal([]);
  });

  it('"all" locks every other version and not the new one', async () => {
    await update(context(state(), { version: "2.0.0", lock: "all" }));
    expect(locked()).to.deep.equal([`_LOCK.${streamName}@1.0.0`, `_LOCK.${streamName}@1.1.0`, `_LOCK.${streamName}@1.2.0`]);
  });

  it("an array locks just those versions", async () => {
    await update(context(state(), { version: "2.0.0", lock: ["1.0.0", "1.1.0"] }));
    expect(locked()).to.deep.equal([`_LOCK.${streamName}@1.0.0`, `_LOCK.${streamName}@1.1.0`]);
  });

  it("records the locks on the contract stream so a restore can write them back", async () => {
    const st: any = state();
    await update(context(st, { version: "2.0.0", lock: ["1.1.0", "1.0.0"] }));
    expect(st.locks).to.deep.equal({ versions: ["1.0.0", "1.1.0"] });
    const none: any = state();
    await update(context(none, { version: "2.0.0" }));
    expect(none.locks).to.equal(undefined);
  });

  it("redeploying an existing version with all keeps that version open", async () => {
    await update(context(state(), { version: "1.2.0", lock: "all" }));
    expect(locked()).to.deep.equal([`_LOCK.${streamName}@1.0.0`, `_LOCK.${streamName}@1.1.0`]);
  });

  it("refuses an unknown version, the new version, and a malformed list, locking nothing", async () => {
    for (const lock of [["9.9.9"], ["2.0.0"], "some", [1], {}, new Array(1001).fill("1.0.0")]) {
      let err: any;
      await update(context(state(), { version: "2.0.0", lock })).catch((e) => (err = e));
      expect(err, JSON.stringify(lock).slice(0, 30)).to.be.instanceOf(Error);
    }
    expect(locked()).to.deep.equal([]);
  });

  it("is refused below the build that every node honours it from", async () => {
    ActiveOptions.set("build", 40200);
    try {
      let err: any;
      await update(context(state(), { version: "2.0.0", lock: "all" })).catch((e) => (err = e));
      expect(err.message).to.contain("40300");
      expect(locked()).to.deep.equal([]);
    } finally {
      ActiveOptions.set("build", 40300);
    }
  });
});
