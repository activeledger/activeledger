import { Process } from "../packages/protocol/src/protocol/process";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Locks have to be honoured for a version a processor has already cached.
 * The cache is pre-seeded, exactly the state in which a lock written later
 * used to be ignored until a restart.
 */
describe("Process.start - contract locks on a cached version (Activeprotocol)", () => {
  let dir: string;
  const contract = "abc123@=1.0.0";
  const cacheKey = contract;

  const run = async (): Promise<string | undefined> => {
    const entry: any = {
      $umid: "u",
      $tx: { $namespace: "ns", $contract: contract, $i: {}, $o: {} },
      $nodes: { self: {} },
    };
    const proc: any = Object.create(Process.prototype);
    proc.entry = entry;
    proc.reference = "self";
    proc.emit = () => undefined;
    // An unlocked version carries on into the VM, which is not under test
    proc.postVote = () => undefined;
    await proc.start(undefined, { _id: "", data: {} });
    return entry.$nodes.self.error;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-locks-"));
    fs.mkdirSync(`${dir}/ns`);
    fs.writeFileSync(`${dir}/ns/abc123@1.0.0.js`, "module.exports = {};");
    (Process as any).contractPathCache[cacheKey] = `${dir}/ns/abc123@1.0.0.js`;
  });

  afterEach(() => {
    delete (Process as any).contractPathCache[cacheKey];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a cached version once its version lock exists", async () => {
    fs.writeFileSync(`${dir}/ns/_LOCK.abc123@1.0.0`, "");
    expect(await run()).to.contain("Contract Version Lock 1.0.0");
  });

  it("refuses a cached version once the whole contract is locked", async () => {
    fs.writeFileSync(`${dir}/ns/_LOCK.abc123`, "");
    expect(await run()).to.contain("Contract Global Lock");
  });

  it("does not take a lock on another version for this one", async () => {
    fs.writeFileSync(`${dir}/ns/_LOCK.abc123@2.0.0`, "");
    expect(await run() ?? "").to.not.contain("Lock");
  });
});
