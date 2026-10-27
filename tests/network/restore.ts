/**
 * Live check of `activerestore --full` on a real 4-node network.
 *
 * Two faults, because they take different repair paths:
 *   1. a node lost only its contract files and still holds every stream
 *   2. a node lost its whole ledger (an empty database)
 *
 * Run via `npm run test:network:restore`.
 */

import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storageGet, storageDelete } from "./http";
import { Report } from "./report";
import { Identity, onboard, registerNamespace, deployContract } from "./actions";

const NAMESPACE = "restoretest";
const CONTRACT_NAME = "restoreexample";

const settle = async (cond: () => Promise<boolean> | boolean, tries = 30) => {
  for (let i = 0; i < tries && !(await cond()); i++) await new Promise((r) => setTimeout(r, 500));
  return cond();
};

/** Every document id and revision a node holds in the ledger database. */
async function ledger(storageUrl: string): Promise<Map<string, string>> {
  const all = await requestJson(`${storageUrl}/activeledger/_all_docs`, "GET");
  const rows: any[] = all?.rows || [];
  return new Map(rows.map((r) => [r.id, r.value?.rev]));
}

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 4, config: { build: 40300 } });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = ok && passed;
  };

  report.phase("Booting 4-node network");
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready`);

  const runRestore = async (dataDir: string, name: string): Promise<number> => {
    // activerestore reads its own config.json; the harness config has no consensus.reached
    const configPath = path.join(dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.consensus = { ...(config.consensus || {}), reached: 60 };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const entry = path.join(__dirname, "..", "..", "packages", "restore", "lib", "index.js");
    const logPath = path.join(dataDir, `${name}.log`);
    const fd = fs.openSync(logPath, "w");
    const child = spawn(process.execPath, [entry, "--full"], { cwd: dataDir, stdio: ["ignore", fd, fd] });
    const started = Date.now();
    // The process lingers after the work is finished, so wait for its
    // completion line and stop it
    const done = await settle(() => /Rebuild Complete|error running quick full restore/.test(fs.readFileSync(logPath, "utf8")), 240);
    child.kill();
    if (!done) report.warn(`${name}: restore did not report completion, log at ${logPath}`);
    return Date.now() - started;
  };

  try {
    const origin = nodes[0];
    const lost = nodes[3];
    const identity: Identity = await onboard(origin.baseUrl);
    await registerNamespace(origin.baseUrl, identity, NAMESPACE);
    const streamId = await deployContract(
      origin.baseUrl, identity, NAMESPACE, CONTRACT_NAME,
      path.join(__dirname, "contracts", "returner-contract.ts")
    );
    report.ok(`deployed ${streamId.substring(0, 16)}...`);

    const nsDir = path.join(lost.dataDir, "contracts", NAMESPACE);
    const filesOf = () => (fs.existsSync(nsDir) ? fs.readdirSync(nsDir).filter((f) => f.includes(streamId)) : []);
    check(await settle(() => filesOf().length > 0), "the node has the contract files before the fault");
    const expected = filesOf().sort();

    // ---- 1: files lost, every stream still held ---------------------------
    report.phase("Restore: the node lost its contract files only");
    for (const f of filesOf()) fs.rmSync(path.join(nsDir, f));
    check(filesOf().length === 0, "contract files removed");
    const ms1 = await runRestore(lost.dataDir, "restore-files");
    report.info(`took ${ms1}ms`);
    check(JSON.stringify(filesOf().sort()) === JSON.stringify(expected), "restore rebuilt the contract files of a stream the node holds");

    // ---- 2: empty ledger ---------------------------------------------------
    report.phase("Restore: the node lost its whole ledger");
    const want = new Map([...(await ledger(origin.storageUrl))].filter(([id]) => !id.endsWith(":volatile")));
    report.info(`the network ledger holds ${want.size} documents`);
    for (const id of await ledger(lost.storageUrl).then((m) => [...m.keys()])) {
      await storageDelete(lost.storageUrl, id).catch(() => undefined);
    }
    check((await ledger(lost.storageUrl)).size === 0, "the node's ledger is empty");
    for (const f of filesOf()) fs.rmSync(path.join(nsDir, f));
    const ms2 = await runRestore(lost.dataDir, "restore-empty");
    report.info(`took ${ms2}ms`);
    const got = await ledger(lost.storageUrl);
    const missing = [...want.keys()].filter((id) => !got.has(id));
    // volatile is per node and never synced
    const wrong = [...want.entries()]
      .filter(([id, rev]) => got.has(id) && got.get(id) !== rev)
      .map(([id]) => id);
    check(missing.length === 0, missing.length ? `${missing.length} documents not restored, e.g. ${missing.slice(0, 3).join(", ")}` : "every document is back");
    check(wrong.length === 0, wrong.length ? `${wrong.length} documents at a different revision, e.g. ${wrong.slice(0, 3).join(", ")}` : "every revision matches the network");
    check([...got.keys()].every((id) => !id.endsWith(":volatile")), "no volatile document was synced");
    check(JSON.stringify(filesOf().sort()) === JSON.stringify(expected), "the contract files were rebuilt");
    check((await storageGet(lost.storageUrl, streamId).catch(() => null))?.contract !== undefined, "the contract stream is back");
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nRESTORE CHECK PASSED\n" : "\nRESTORE CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
