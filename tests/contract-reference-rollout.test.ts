import { expect } from "chai";
import "mocha";
// By package name, not ../packages/options/src - the subject resolves
// "@activeledger/activeoptions" through node_modules to the built lib/,
// a different module instance with its own static config.
import { ActiveOptions } from "@activeledger/activeoptions";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Contract from "../packages/activeledger/src/contracts/default/contract";

// Default contracts are loaded from each node's own filesystem
// (process.ts setupDefaultLocation), so what commitAdd writes is decided
// by the node's VERSION. During a rolling upgrade an old node writes
// base64 for a contract deploy while a new one writes {umid,hash} - same
// transaction, different state, different revision, and the contract
// stream diverges. Restore cannot repair that.
//
// So the new shape only appears once the operator raises build, by which
// point every node understands it. Below the threshold a node must write
// byte-for-byte what 4.7.1 wrote.
describe("Contract reference rollout gate (Activeledger)", () => {
  const source = "export default class Example {}\n";
  const base64 = Buffer.from(source).toString("base64");
  const umid = "a".repeat(64);
  const streamName = "c".repeat(64);

  let tmpDir: string;
  let cwd: string;
  let originalBuild: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-gate-test-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts");
    fs.mkdirSync("contracts/testns");
    originalBuild = ActiveOptions.get("build", 0);
  });

  afterEach(() => {
    ActiveOptions.set("build", originalBuild);
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let written: any;

  const context = (state: any, version: string) => {
    written = state;
    return {
      umid,
      namespace: "testns",
      name: "example",
      rootDir: "./contracts/",
      transactions: {
        $i: { identityStream: { contract: base64, version, namespace: "testns", name: "example" } },
        $o: { [streamName]: {} },
      },
      identity: { getName: () => "identityStream" },
      normaliseLegacyVersions: (Contract as any).prototype.normaliseLegacyVersions,
      useContractReferences: (Contract as any).prototype.useContractReferences,
      contractTarget: (Contract as any).prototype.contractTarget,
      compiledEntry: (Contract as any).prototype.compiledEntry,
      transpile: () => "class Example {}",
      newActivityStream: () => ({
        getName: () => streamName,
        getState: () => state,
        setState: (s: any) => (written = s),
        setAuthority: () => undefined,
      }),
      getActivityStreams: () => ({
        getName: () => streamName,
        getState: () => state,
        setState: (s: any) => (written = s),
      }),
    };
  };

  const add = (ctx: any) =>
    new Promise<void>((res, rej) => (Contract as any).prototype.commitAdd.call(ctx, () => res(), rej));
  const update = (ctx: any) =>
    new Promise<void>((res, rej) => (Contract as any).prototype.commitUpdate.call(ctx, () => res(), rej));

  describe("below the threshold - exactly what 4.7.1 did", () => {
    beforeEach(() => ActiveOptions.set("build", 40000));

    it("commitAdd stores the base64 source", async () => {
      await add(context({}, "1.0.0"));
      expect(written.contract["1.0.0"]).to.equal(base64);
    });

    it("commitAdd writes no identity field", async () => {
      await add(context({}, "1.0.0"));
      expect(written.identity).to.equal(undefined);
    });

    it("commitUpdate stores base64 and leaves legacy entries alone", async () => {
      const legacy = Buffer.from("export default class Old {}\n").toString("base64");
      await update(context({ contract: { "1.0.0": legacy }, compiled: {} }, "2.0.0"));
      expect(written.contract["1.0.0"]).to.equal(legacy);
      expect(written.contract["2.0.0"]).to.equal(base64);
    });
  });

  describe("at the threshold", () => {
    beforeEach(() => ActiveOptions.set("build", 40100));

    it("commitAdd stores a umid reference", async () => {
      await add(context({}, "1.0.0"));
      expect(written.contract["1.0.0"].umid).to.equal(umid);
    });

    it("commitAdd records the deploy identity", async () => {
      await add(context({}, "1.0.0"));
      expect(written.identity).to.equal("identityStream");
    });

    it("commitUpdate normalises legacy entries", async () => {
      const legacy = Buffer.from("export default class Old {}\n").toString("base64");
      await update(context({ contract: { "1.0.0": legacy }, compiled: {} }, "2.0.0"));
      expect(typeof written.contract["1.0.0"]).to.not.equal("string");
      expect(written.contract["2.0.0"].umid).to.equal(umid);
    });
  });
});
