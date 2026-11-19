import { Process } from "../packages/protocol/src/protocol/process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A contract resolved under one namespace must never run for a transaction
 * that names another. The path cache used to be keyed by `$contract` alone,
 * so on a warm worker `$namespace` was not looked at at all.
 */
describe("Process.start - contract is bound to its namespace (Activeprotocol)", () => {
  const contract = "abc123@=1.0.0";
  let dir: string;
  let cwd: string;
  let build: number;

  const run = async (namespace: string): Promise<string | undefined> => {
    const entry: any = {
      $umid: "u",
      $tx: { $namespace: namespace, $contract: contract, $i: {}, $o: {} },
      $nodes: { self: {} },
    };
    const proc: any = Object.create(Process.prototype);
    proc.entry = entry;
    proc.reference = "self";
    proc.emit = () => undefined;
    // A transaction that gets past resolution carries on into the VM
    proc.postVote = () => undefined;
    await proc.start(undefined, { _id: "", data: {} });
    return entry.$nodes.self.error;
  };

  beforeEach(() => {
    build = ActiveOptions.get<number>("build", 0);
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-binding-"));
    fs.mkdirSync(`${dir}/contracts/owner`, { recursive: true });
    fs.mkdirSync(`${dir}/contracts/varnir`, { recursive: true });
    fs.writeFileSync(`${dir}/contracts/owner/abc123@1.0.0.js`, "module.exports = {};");
    process.chdir(dir);
    (Process as any).contractPathCache = {};
  });

  afterEach(() => {
    process.chdir(cwd);
    ActiveOptions.set("build", build);
    (Process as any).contractPathCache = {};
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs the contract for the namespace it lives in", async () => {
    ActiveOptions.set("build", Process.NAMESPACE_BINDING_BUILD);
    expect(await run("owner") ?? "").to.not.contain("not found");
  });

  it("refuses a warm contract named under another namespace", async () => {
    ActiveOptions.set("build", Process.NAMESPACE_BINDING_BUILD);
    // Warm the cache the way a first transaction in the owner's namespace does
    expect(await run("owner") ?? "").to.not.contain("not found");
    expect(await run("varnir")).to.contain("Contract not found");
  });

  it("refuses a wrong-case namespace on a warm cache", async () => {
    ActiveOptions.set("build", Process.NAMESPACE_BINDING_BUILD);
    expect(await run("owner") ?? "").to.not.contain("not found");
    expect(await run("Owner")).to.contain("Namespace not found");
  });

  it("keeps the old behaviour below the build level", async () => {
    ActiveOptions.set("build", Process.NAMESPACE_BINDING_BUILD - 1);
    expect(await run("owner") ?? "").to.not.contain("not found");
    // Served from the cache, as before the gate
    expect(await run("varnir") ?? "").to.not.contain("not found");
  });

  it("clears a namespace-keyed entry by contract id", async () => {
    ActiveOptions.set("build", Process.NAMESPACE_BINDING_BUILD);
    expect(await run("owner") ?? "").to.not.contain("not found");
    expect(Object.keys((Process as any).contractPathCache)).to.have.length(1);
    Process.clearContractPathCache("abc123");
    expect(Object.keys((Process as any).contractPathCache)).to.have.length(0);
  });
});
