import { Process } from "../packages/protocol/src/protocol/process";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildProcess, ProcessFixture } from "./helpers/process-fixture";

/**
 * Process.start - everything between a transaction arriving and the VM
 * running it: which contract file is resolved, which transactions are
 * refused before any of that, and how a stream error is reported.
 *
 * start() resolves contracts under process.cwd(), so each test runs from a
 * scratch directory holding its own contracts/ and default_contracts/.
 */
describe("Process.start - resolving and refusing a contract (Activeprotocol)", () => {
  let dir: string;
  let cwd: string;
  let fixture: ProcessFixture;
  let processed: any[][];
  let postVoted: any[][];

  const setup = (entry: any = {}) => {
    fixture = buildProcess({ entry });
    const { proc } = fixture;
    processed = [];
    postVoted = [];
    // The VM phases are not under test; record what start() hands over
    proc.process = (...args: any[]) => processed.push(args);
    proc.postVote = (...args: any[]) => postVoted.push(args);
    proc.permissionChecker = {
      prefetch: () => Promise.resolve(),
      process: (ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ _id: id }))),
    };
    return fixture;
  };

  const error = () => fixture.entry.$nodes.self.error;

  beforeEach(() => {
    cwd = globalThis.process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-start-"));
    fs.mkdirSync(`${dir}/contracts/ns`, { recursive: true });
    fs.mkdirSync(`${dir}/default_contracts`);
  });

  afterEach(() => {
    globalThis.process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    Process.clearContractPathCache();
  });

  // start() reads process.cwd() when it runs, so move there after building
  const start = (f: ProcessFixture, ...args: any[]) => {
    globalThis.process.chdir(dir);
    return f.proc.start(...args);
  };

  const touch = (file: string) => fs.writeFileSync(`${dir}/${file}`, "");

  describe("path traversal", () => {
    for (const field of ["$contract", "$namespace"]) {
      for (const bad of ["../evil", "a/b", "a\\b", "a\0b", ".."]) {
        it(`refuses ${field} ${JSON.stringify(bad)} before touching the filesystem`, async () => {
          const f = setup({ $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {}, [field]: bad } });

          let thrown: Error | undefined;
          try {
            await start(f);
          } catch (e) {
            thrown = e as Error;
          }

          expect(thrown?.message).to.equal(`Invalid ${field}`);
          expect(f.events).to.deep.equal([]);
        });
      }
    }

    it("still allows the dots of a version string", async () => {
      // Resolves far enough to fail on the missing namespace, not on the name
      const f = setup({ $tx: { $namespace: "missing", $contract: "abc@1.2.3", $i: {}, $o: {} } });

      await start(f);

      expect(error()).to.equal("Init Contract Error - Namespace not found - ENOENT");
    });
  });

  describe("default contracts", () => {
    const defaults = { $namespace: "default", $contract: "onboard", $i: {}, $o: {} };

    it("refuses a default contract that has its own lock", async () => {
      touch("default_contracts/_LOCK.onboard");
      touch("default_contracts/onboard.js");
      const f = setup({ $tx: defaults });

      await start(f);

      expect(error()).to.equal("Init Contract Error - Contract Global Lock");
      expect(f.events).to.deep.equal([{ event: "commited", payload: { instant: true } }]);
      expect(processed).to.have.length(0);
    });

    it("reports a default contract that does not exist", async () => {
      const f = setup({ $tx: defaults });

      await start(f);

      expect(error()).to.match(/^Init Contract Error - ENOENT/);
      expect(f.events).to.deep.equal([{ event: "commited", payload: { instant: true } }]);
    });
  });

  describe("transpiled contracts", () => {
    const tx = (contract: string) => ({ $namespace: "ns", $contract: contract, $i: {}, $o: {} });

    it("reports a contract nothing in the namespace matches", async () => {
      const f = setup({ $tx: tx("ghost") });

      await start(f);

      expect(error()).to.equal("Init Contract Error - Contract not found");
    });

    it("does not let a contract whose name starts with another's win its latest version", async () => {
      // "token" is not "tok" with something on the end
      touch("contracts/ns/tok@1.0.0.js");
      touch("contracts/ns/token@2.0.0.js");
      const f = setup({ $tx: tx("tok") });

      await start(f);

      expect(f.proc.contractLocation).to.equal(
        fs.realpathSync(`${dir}/contracts/ns/tok@1.0.0.js`)
      );
    });

    it("reports an exact version that is not deployed", async () => {
      touch("contracts/ns/abc@1.0.0.js");
      const f = setup({ $tx: tx("abc@=3.0.0") });

      await start(f);

      expect(error()).to.equal("Init Contract Error - Contract not found");
    });

    it("votes no when a cached contract file has gone missing", async () => {
      (Process as any).contractPathCache["abc"] = `${dir}/contracts/ns/abc@1.0.0.js`;
      const f = setup({ $tx: tx("abc") });

      await start(f, undefined, { _id: "", data: {} });

      expect(postVoted).to.have.length(1);
      expect(postVoted[0][1]).to.deep.equal({ code: 1401, reason: "Contract Not Found" });
    });
  });

  describe("stream resolution", () => {
    beforeEach(() => touch("default_contracts/onboard.js"));

    const base = (extra: any = {}) => ({
      $tx: { $namespace: "default", $contract: "onboard", $i: {}, $o: {} },
      ...extra,
    });

    it("marks a labelled input that is signature only", async () => {
      const f = setup(
        base({
          $tx: {
            $namespace: "default",
            $contract: "onboard",
            $i: { from: { $stream: "stream-a", $sigOnly: true }, other: { $stream: "stream-c" } },
            $o: {},
          },
        })
      );

      await start(f);

      expect(f.proc.shared.sigOnly).to.deep.equal({ "stream-a": true });
    });

    const positionError = { code: 1200, reason: "Input Stream Position Incorrect" };

    for (const [name, rejection] of [
      ["Position Incorrect", positionError],
      ["Stream(s) not found", { code: 1210, reason: "Stream(s) not found" }],
    ] as const) {
      it(`fails a unanimous direct transaction straight away on ${name}`, async () => {
        const f = setup(base({ $unanimous: true, $broadcast: false }));
        f.proc.permissionChecker.process = () => Promise.reject(rejection);

        await start(f);

        const failed = f.events.filter((e) => e.event === "failed");
        expect(failed).to.have.length(1);
        expect(failed[0].payload.status).to.equal(rejection.code);
        expect(failed[0].payload.error).to.equal(rejection.reason);
        expect(f.entry.$nodes.self.error).to.equal(rejection.reason);
        expect(postVoted).to.have.length(0);
      });
    }

    it("defaults a stream rejection without a code to 1200", async () => {
      const f = setup(base({ $unanimous: true }));
      f.proc.permissionChecker.process = () => Promise.reject(new Error("Position Incorrect somewhere"));

      await start(f);

      expect(f.events.find((e) => e.event === "failed")?.payload.status).to.equal(1200);
    });

    for (const [label, extra] of [
      ["is a retry", { $unanimous: true, $spiRetry: true }],
      ["is broadcast", { $unanimous: true, $broadcast: true }],
      ["is not unanimous", {}],
    ] as const) {
      it(`votes no rather than failing early when the transaction ${label}`, async () => {
        const f = setup(base(extra));
        f.proc.permissionChecker.process = () => Promise.reject(positionError);

        await start(f);

        expect(f.events.filter((e) => e.event === "failed")).to.have.length(0);
        expect(postVoted).to.have.length(1);
        expect(postVoted[0][1]).to.deep.equal(positionError);
      });
    }

    it("votes no with the message of an error that carries no reason", async () => {
      const f = setup(base());
      f.proc.permissionChecker.prefetch = () => Promise.reject(new Error("db down"));

      await start(f);

      expect(postVoted[0][1]).to.deep.equal({ code: undefined, reason: "db down" });
    });
  });

  describe("self signed transactions", () => {
    beforeEach(() => touch("default_contracts/onboard.js"));

    const selfSigned = (inputs: any, sigs: any, extra: any = {}) =>
      setup({
        $selfsign: true,
        $sigs: sigs,
        $tx: { $namespace: "default", $contract: "onboard", $i: inputs, $o: {} },
        ...extra,
      });

    it("refuses a self signed transaction with no inputs", async () => {
      const f = selfSigned({}, {});

      await start(f);

      expect(f.raised).to.deep.equal([
        { code: 1260, message: "Self signed - Must have inputs", stop: undefined, priority: undefined },
      ]);
    });

    it("refuses an input that has no signature", async () => {
      const f = selfSigned({ id: { publicKey: "pk" } }, {});

      await start(f);

      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
        [1260, "Self signed signature not found"],
      ]);
    });

    it("refuses an input that carries no public key to check against", async () => {
      const f = selfSigned({ id: {} }, { id: "sig" });

      await start(f);

      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
        [1255, "Self signed publicKey property not found in $i id"],
      ]);
    });

    it("refuses a signature that does not match, using the declared key type", async () => {
      const f = selfSigned({ id: { publicKey: "pk", type: "secp256k1" } }, { id: "sig" });
      const checked: any[][] = [];
      f.proc.shared.signatureCheck = (...args: any[]) => (checked.push(args), false);

      await start(f);

      expect(checked).to.deep.equal([["pk", "sig", "secp256k1"]]);
      expect(f.raised.map((r) => [r.code, r.message])).to.deep.equal([
        [1250, "Self signed signature not matching"],
      ]);
      expect(processed).to.have.length(0);
    });

    it("assumes rsa when the input declares no type, and runs a valid one with no input streams", async () => {
      const f = selfSigned({ id: { publicKey: "pk" } }, { id: "sig" });
      const checked: any[][] = [];
      f.proc.shared.signatureCheck = (...args: any[]) => (checked.push(args), true);

      await start(f);

      expect(checked).to.deep.equal([["pk", "sig", "rsa"]]);
      expect(f.raised).to.have.length(0);
      expect(processed).to.have.length(1);
      expect(processed[0][0]).to.deep.equal([]);
    });

    it("fails a unanimous direct self signed transaction on a stream position error", async () => {
      const f = selfSigned({ id: { publicKey: "pk" } }, { id: "sig" }, { $unanimous: true });
      f.proc.shared.signatureCheck = () => true;
      f.proc.permissionChecker.process = () =>
        Promise.reject({ code: 1200, reason: "Output Stream Position Incorrect" });

      await start(f);

      const failed = f.events.filter((e) => e.event === "failed");
      expect(failed).to.have.length(1);
      expect(failed[0].payload.status).to.equal(1200);
      expect(f.entry.$nodes.self.error).to.equal("Output Stream Position Incorrect");
    });

    it("votes no on any other output stream error", async () => {
      const f = selfSigned({ id: { publicKey: "pk" } }, { id: "sig" });
      f.proc.shared.signatureCheck = () => true;
      f.proc.permissionChecker.process = () => Promise.reject(new Error("db down"));

      await start(f);

      expect(f.events.filter((e) => e.event === "failed")).to.have.length(0);
      expect(postVoted[0][1]).to.deep.equal({ code: undefined, reason: "db down" });
    });
  });
});
