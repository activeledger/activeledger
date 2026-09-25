import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Contract from "../packages/activeledger/src/contracts/default/contract";
// By package name - the subject resolves "@activeledger/activeoptions"
// through node_modules to the built lib/, a separate module instance.
import { ActiveOptions } from "@activeledger/activeoptions";
import { isContractRef } from "../packages/definitions/src/definitions/document";

// commitAdd and commitUpdate are driven directly with a hand-built
// context rather than through the VM. The behaviour under test is what
// they put in state, and standing up a real contract execution to check
// that would test the harness instead.
describe("Contract commit writes references, not source (Activeledger)", () => {
  const source = "export default class Example {}\n";
  const base64 = Buffer.from(source).toString("base64");
  const crypto = require("crypto");
  const hashOf = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const umid = "a".repeat(64);
  const streamName = "c".repeat(64);

  let written: any;
  let filesWritten: string[];

  // Both handlers write the transpiled .js to disk as well as setting
  // state. That is unchanged by this work, but it means the tests need a
  // real directory to write into - commitUpdate in particular assumes
  // contracts/<ns>/ was already created by the add that preceded it.
  let tmpDir: string;
  let cwd: string;
  let originalBuild: any;

  // Contract references are gated behind build >= 40100 so a rolling
  // upgrade cannot diverge contract streams. This suite is about the
  // reference shape itself, so it runs with the gate open;
  // contract-reference-rollout.test.ts covers the gate.
  before(() => {
    originalBuild = ActiveOptions.get("build", 0);
    ActiveOptions.set("build", 40100);
  });
  after(() => ActiveOptions.set("build", originalBuild));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-commit-test-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts");
    fs.mkdirSync("contracts/testns");
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const context = (state: any, version: string) => {
    written = state;
    filesWritten = [];
    return {
      umid,
      namespace: "testns",
      name: "example",
      rootDir: "./contracts/",
      transactions: {
        $i: {
          identityStream: {
            contract: base64,
            version,
            namespace: "testns",
            name: "example",
          },
        },
        $o: { [streamName]: {} },
      },
      identity: { getName: () => "identityStream" },
      // normaliseLegacyVersions is called as this.normaliseLegacyVersions,
      // so it has to be on the context. hashContractSource is a static and
      // is reached as Contract.hashContractSource - not needed here.
      normaliseLegacyVersions: (Contract as any).prototype.normaliseLegacyVersions,
      useContractReferences: (Contract as any).prototype.useContractReferences,
      contractTarget: (Contract as any).prototype.contractTarget,
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
      __files: filesWritten,
    };
  };

  const add = (ctx: any) =>
    new Promise<void>((resolve, reject) =>
      (Contract as any).prototype.commitAdd.call(ctx, () => resolve(), reject)
    );
  const update = (ctx: any) =>
    new Promise<void>((resolve, reject) =>
      (Contract as any).prototype.commitUpdate.call(ctx, () => resolve(), reject)
    );

  it("commitAdd stores a umid reference instead of base64", async () => {
    await add(context({}, "1.0.0"));
    expect(isContractRef(written.contract["1.0.0"])).to.equal(true);
    expect(written.contract["1.0.0"].umid).to.equal(umid);
    expect(written.contract["1.0.0"].hash).to.equal(hashOf(source));
  });

  it("commitAdd never stores the base64 source", async () => {
    await add(context({}, "1.0.0"));
    expect(JSON.stringify(written)).to.not.contain(base64);
  });

  // Rebuild has to know which $i key of the deploy transaction carried
  // the source, and nothing in a contract stream's state recorded it -
  // commitAdd wrote name, namespace, contract and compiled and nothing
  // else. Without this, rebuild indexes $tx.$i[undefined] and every
  // umid-based rebuild fails.
  it("commitAdd records the deploy identity", async () => {
    await add(context({}, "1.0.0"));
    expect(written.identity).to.equal("identityStream");
  });

  it("commitUpdate records the deploy identity too", async () => {
    await update(context({ contract: {}, compiled: {} }, "2.0.0"));
    expect(written.identity).to.equal("identityStream");
  });

  // compiled is dead data - it is stream.getName() for every version -
  // but quick-restore.ts:257 and hybrid/server.ts:493 both use its
  // presence to recognise a contract stream at all. Dropping it makes
  // contract rebuild silently stop, so it is pinned here.
  it("keeps writing compiled so the recognition gates still match", async () => {
    await add(context({}, "1.0.0"));
    expect(written.compiled["1.0.0"]).to.equal(streamName);
  });

  it("commitUpdate normalises legacy entries already in the stream", async () => {
    const legacySource = "export default class Old {}\n";
    const legacy = Buffer.from(legacySource).toString("base64");
    await update(
      context({ contract: { "1.0.0": legacy }, compiled: { "1.0.0": streamName } }, "2.0.0")
    );
    expect(written.contract["1.0.0"]).to.deep.equal({ hash: hashOf(legacySource) });
    expect(JSON.stringify(written)).to.not.contain(legacy);
  });

  it("commitUpdate leaves no base64 anywhere in the resulting state", async () => {
    const legacy = Buffer.from("export default class Old {}\n").toString("base64");
    await update(context({ contract: { "1.0.0": legacy }, compiled: {} }, "2.0.0"));
    for (const v of Object.values(written.contract)) {
      expect(typeof v).to.not.equal("string");
    }
  });

  // The invariant the whole historical seam rests on: whatever else is in
  // the stream, the version just deployed can always be rebuilt.
  it("leaves the newest version carrying its umid", async () => {
    const legacy = Buffer.from("export default class Old {}\n").toString("base64");
    await update(context({ contract: { "1.0.0": legacy }, compiled: {} }, "2.0.0"));
    expect(written.contract["2.0.0"].umid).to.equal(umid);
  });

  it("never drops a version key while normalising", async () => {
    const a = Buffer.from("export default class A {}\n").toString("base64");
    const b = Buffer.from("export default class B {}\n").toString("base64");
    await update(context({ contract: { "1.0.0": a, "1.1.0": b }, compiled: {} }, "2.0.0"));
    expect(Object.keys(written.contract).sort()).to.deep.equal(["1.0.0", "1.1.0", "2.0.0"]);
  });

  it("leaves an already-normalised entry untouched", async () => {
    const existing = { umid: "d".repeat(64), hash: hashOf(source) };
    await update(context({ contract: { "1.0.0": existing }, compiled: {} }, "2.0.0"));
    expect(written.contract["1.0.0"]).to.deep.equal(existing);
  });

  // Purity. Two nodes running the same transaction against the same prior
  // state must produce byte-identical results, with nothing fetched.
  it("is deterministic across runs", async () => {
    const legacy = Buffer.from("export default class Old {}\n").toString("base64");
    await update(context({ contract: { "1.0.0": legacy }, compiled: {} }, "2.0.0"));
    const first = JSON.stringify(written);
    await update(context({ contract: { "1.0.0": legacy }, compiled: {} }, "2.0.0"));
    expect(JSON.stringify(written)).to.equal(first);
  });
});
