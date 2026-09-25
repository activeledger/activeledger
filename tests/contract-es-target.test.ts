import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Contract from "../packages/activeledger/src/contracts/default/contract";
// By package name - the subject resolves "@activeledger/activeoptions"
// through node_modules to the built lib/, a separate module instance.
import { ActiveOptions } from "@activeledger/activeoptions";

// Contracts compile to ES2025 from build 40200, and the edition is recorded
// on the version entry. The compiled .js is written once per node at deploy
// and run from then on, so what matters is that every node picks the same
// edition for the same deploy - which the gate decides - and that nothing
// written before the gate ever changes edition.
describe("Contract compile target (Activeledger)", () => {
  const umid = "a".repeat(64);
  const streamName = "c".repeat(64);
  const toBase64 = (s: string) => Buffer.from(s).toString("base64");

  let written: any;
  let targets: string[];
  let tmpDir: string;
  let cwd: string;
  let originalBuild: any;

  before(() => (originalBuild = ActiveOptions.get("build", 0)));
  after(() => ActiveOptions.set("build", originalBuild));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-target-test-"));
    cwd = process.cwd();
    process.chdir(tmpDir);
    fs.mkdirSync("contracts");
    fs.mkdirSync("contracts/testns");
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const context = (state: any, version: string, source = "export default class Example {}\n") => {
    written = state;
    targets = [];
    const proto = (Contract as any).prototype;
    return {
      umid,
      namespace: "testns",
      name: "example",
      rootDir: "./contracts/",
      transactions: {
        $i: {
          identityStream: {
            contract: toBase64(source),
            version,
            namespace: "testns",
            name: "example",
          },
        },
        $o: { [streamName]: {} },
      },
      identity: { getName: () => "identityStream" },
      normaliseLegacyVersions: proto.normaliseLegacyVersions,
      useContractReferences: proto.useContractReferences,
      contractTarget: proto.contractTarget,
      // The real compiler, recording which edition it was asked for.
      transpile(target: string) {
        targets.push(target);
        return proto.transpile.call(this, target);
      },
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
    new Promise<void>((resolve, reject) =>
      (Contract as any).prototype.commitAdd.call(ctx, () => resolve(), reject)
    );
  const update = (ctx: any) =>
    new Promise<void>((resolve, reject) =>
      (Contract as any).prototype.commitUpdate.call(ctx, () => resolve(), reject)
    );
  const compiled = (version: string) =>
    fs.readFileSync(`contracts/testns/${streamName}@${version}.js`, "utf8");

  describe("below 40200", () => {
    beforeEach(() => ActiveOptions.set("build", 40100));

    it("compiles to es2017", async () => {
      await add(context({}, "1.0.0"));
      expect(targets).to.deep.equal(["es2017"]);
    });

    // The entry has to be exactly what 4.8.0 wrote, or a node on this
    // release and a node on 4.8.0 disagree about the same deploy.
    it("writes the entry without a target", async () => {
      await add(context({}, "1.0.0"));
      expect(written.contract["1.0.0"]).to.have.all.keys("umid", "hash");
    });
  });

  describe("from 40200", () => {
    beforeEach(() => ActiveOptions.set("build", 40200));

    it("compiles a new contract to es2025 and records it", async () => {
      await add(context({}, "1.0.0"));
      expect(targets).to.deep.equal(["es2025"]);
      expect(written.contract["1.0.0"].target).to.equal("es2025");
    });

    it("compiles an update to es2025 and records it", async () => {
      await update(context({ contract: {}, compiled: {} }, "2.0.0"));
      expect(targets).to.deep.equal(["es2025"]);
      expect(written.contract["2.0.0"].target).to.equal("es2025");
    });

    // Earlier versions were compiled to es2017 and are still running as
    // that on every node. Marking them es2025 would make a rebuild produce
    // different code from what the rest of the network runs.
    it("never gives an earlier version a target", async () => {
      const legacy = toBase64("export default class Old {}\n");
      const ref = { umid: "d".repeat(64), hash: "e".repeat(64) };
      await update(
        context({ contract: { "0.9.0": legacy, "1.0.0": ref }, compiled: {} }, "2.0.0")
      );
      expect(written.contract["0.9.0"]).to.not.have.property("target");
      expect(written.contract["1.0.0"]).to.deep.equal(ref);
    });

    it("is deterministic across runs", async () => {
      await update(context({ contract: {}, compiled: {} }, "2.0.0"));
      const first = JSON.stringify(written) + compiled("2.0.0");
      await update(context({ contract: {}, compiled: {} }, "2.0.0"));
      expect(JSON.stringify(written) + compiled("2.0.0")).to.equal(first);
    });
  });

  describe("what each edition emits", () => {
    const source = [
      "export default class Example {",
      "  #secret = 1;",
      "  read(o?: { a?: number }) { return o?.a ?? this.#secret; }",
      "}",
      "",
    ].join("\n");
    const emit = (target: string) =>
      (Contract as any).prototype.transpile.call(context({}, "1.0.0", source), target);

    it("es2017 downlevels newer syntax, as before", () => {
      const out = emit("es2017");
      expect(out).to.not.contain("?.");
      expect(out).to.not.contain("#secret");
      expect(out).to.contain("WeakMap");
    });

    it("es2025 keeps it native", () => {
      const out = emit("es2025");
      expect(out).to.contain("?.");
      expect(out).to.contain("??");
      expect(out).to.contain("#secret = 1");
    });

    // The breaking part, pinned so it cannot change silently. From ES2022
    // a redeclared field is a real field definition that runs after
    // super(), so it resets what the base constructor set. `declare`
    // is the fix for contract authors.
    it("es2025 turns a redeclared field into a real field definition", () => {
      const redeclared = [
        "class Base { transactions: any; constructor() { this.transactions = 1; } }",
        "export default class Example extends Base { transactions: any; }",
        "",
      ].join("\n");
      const emitFrom = (src: string, target: string) =>
        (Contract as any).prototype.transpile.call(context({}, "1.0.0", src), target);

      const Es2017 = new Function("exports", emitFrom(redeclared, "es2017") + "\nreturn exports;");
      const Es2025 = new Function("exports", emitFrom(redeclared, "es2025") + "\nreturn exports;");
      expect(new (Es2017({}).default)().transactions).to.equal(1);
      expect(new (Es2025({}).default)().transactions).to.equal(undefined);

      const declared = redeclared.replace(
        "extends Base { transactions",
        "extends Base { declare transactions"
      );
      const Fixed = new Function("exports", emitFrom(declared, "es2025") + "\nreturn exports;");
      expect(new (Fixed({}).default)().transactions).to.equal(1);
    });
  });
});
