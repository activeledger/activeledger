import { Contract } from "../packages/restore/src/modules/contract/contract";
import { Provider } from "../packages/restore/src/modules/provider/provider";
import { ContractSource } from "@activeledger/activecontracts/lib/source";
import { ActiveLogger } from "@activeledger/activelogger";
import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("Restore Contract.rebuild (cov)", () => {
  let tmp: string;
  let cwd: string;
  let warns: string[];
  const origWarn = (ActiveLogger as any).warn;
  const origDb = (Provider as any).database;
  let umids: Record<string, any>;

  const ts = (msg: string) => Buffer.from(`export default "${msg}" as string;`).toString("base64");
  const read = (p: string) => fs.readFileSync(path.join(tmp, "contracts", p), "utf8");
  const has = (p: string) => fs.existsSync(path.join(tmp, "contracts", p));

  beforeEach(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-contract-"));
    process.chdir(tmp);
    warns = [];
    umids = {};
    (ActiveLogger as any).warn = (m: string) => warns.push(String(m));
    (Provider as any).database = {
      get: async (id: string) => {
        if (!(id in umids)) throw new Error("missing");
        return umids[id];
      },
    };
  });
  afterEach(() => {
    process.chdir(cwd);
    (ActiveLogger as any).warn = origWarn;
    (Provider as any).database = origDb;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes an inline version transpiled, as latest and as that version", async () => {
    const src = ts("hello");
    await Contract.rebuild({ _id: "c1", namespace: "ns", contract: { "1.0.0": src } });
    const js = ContractSource.transpile(src, "es2017");
    expect(read("ns/c1.js")).to.equal(js);
    expect(read("ns/c1@1.0.0.js")).to.equal(js);
    expect(js).to.contain("hello");
    expect(warns).to.deep.equal([]);
  });

  it("recovers a referenced version from the deploying umid, via the store", async () => {
    const src = ts("fromumid");
    umids["U1:umid"] = { umid: { $tx: { $i: { owner: { contract: src } } } } };
    await Contract.rebuild({
      _id: "c2",
      namespace: "ns",
      identity: "owner",
      contract: { "2.0.0": { hash: ContractSource.hash(src), umid: "U1" } },
    });
    expect(read("ns/c2@2.0.0.js")).to.contain("fromumid");
  });

  it("reports a version it cannot recover and still rebuilds the others", async () => {
    const src = ts("ok");
    await Contract.rebuild({
      _id: "c3",
      namespace: "ns",
      identity: "owner",
      contract: {
        "1.0.0": { hash: "abc", umid: "NOPE" },
        "2.0.0": src,
      },
    });
    expect(has("ns/c3@1.0.0.js")).to.equal(false);
    expect(has("ns/c3@2.0.0.js")).to.equal(true);
    expect(warns.length).to.equal(1);
    expect(warns[0]).to.contain("c3@1.0.0");
  });

  it("restores the lock files the stream recorded", async () => {
    await Contract.rebuild({
      _id: "c4",
      namespace: "ns",
      contract: { "1.0.0": ts("x") },
      locks: { all: true, versions: ["1.0.0", 5, "2.0.0"] },
    });
    expect(has("ns/_LOCK.c4")).to.equal(true);
    expect(has("ns/_LOCK.c4@1.0.0")).to.equal(true);
    expect(has("ns/_LOCK.c4@2.0.0")).to.equal(true);
    expect(fs.readdirSync(path.join(tmp, "contracts/ns")).filter((f) => f.startsWith("_LOCK")).length).to.equal(3);
  });

  it("does not lock when the stream recorded no locks", async () => {
    await Contract.rebuild({ _id: "c5", namespace: "ns", contract: { "1.0.0": ts("x") }, locks: { all: false } });
    await Contract.rebuild({ _id: "c6", namespace: "ns", contract: { "1.0.0": ts("x") } });
    expect(fs.readdirSync(path.join(tmp, "contracts/ns")).some((f) => f.startsWith("_LOCK"))).to.equal(false);
  });

  it("warns, and carries on, when a lock cannot be written", async () => {
    // Nothing recoverable, so the namespace directory never gets made and
    // the lock file has nowhere to go
    await Contract.rebuild({
      _id: "c7",
      namespace: "ns",
      contract: { "1.0.0": { hash: "h" } },
      locks: { all: true, versions: ["1.0.0"] },
    });
    const lockWarns = warns.filter((w) => w.startsWith("Cannot restore the lock on"));
    expect(lockWarns.length).to.equal(2);
    expect(lockWarns[0]).to.contain("c7");
    expect(lockWarns[1]).to.contain("c7@1.0.0");
  });

  it("warns when the lock record itself cannot be read", async () => {
    const contract: any = { _id: "c8", namespace: "ns", contract: {} };
    Object.defineProperty(contract, "locks", {
      get() {
        throw new Error("corrupt");
      },
    });
    await Contract.rebuild(contract);
    expect(warns.length).to.equal(1);
    expect(warns[0]).to.contain("Cannot restore the locks on c8").and.to.contain("corrupt");
  });
});
