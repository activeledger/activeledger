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
import * as os from "os";
import { spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storageGet, storageDelete } from "./http";
import { Report } from "./report";
import { Identity, onboard, registerNamespace, deployContract, updateContract } from "./actions";

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

  const runRestore = async (dataDir: string, name: string, extra: string[] = []): Promise<number> => {
    // activerestore reads its own config.json; the harness config has no consensus.reached
    const configPath = path.join(dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.consensus = { ...(config.consensus || {}), reached: 60 };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const entry = path.join(__dirname, "..", "..", "packages", "restore", "lib", "index.js");
    const logPath = path.join(dataDir, `${name}.log`);
    const fd = fs.openSync(logPath, "w");
    const child = spawn(process.execPath, [entry, "--full", ...extra], { cwd: dataDir, stdio: ["ignore", fd, fd] });
    const started = Date.now();
    // The process lingers after the work is finished, so wait for its
    // completion line and stop it
    const done = await settle(() => /History Complete|History pass skipped|error running quick full restore/.test(fs.readFileSync(logPath, "utf8")), 240);
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

    // ---- 3: a few documents missing, the rest held ----------------------------
    report.phase("Restore: the node is missing three documents and holds the rest");
    const before = await ledger(lost.storageUrl);
    const gone = [...before.keys()].filter((id) => !id.endsWith(":volatile")).slice(0, 3);
    for (const id of gone) await storageDelete(lost.storageUrl, id).catch(() => undefined);
    const ms3 = await runRestore(lost.dataDir, "restore-few");
    report.info(`took ${ms3}ms`);
    const after = await ledger(lost.storageUrl);
    check(gone.every((id) => after.get(id) === before.get(id)), "the three documents are back at the network's revision");
    const fewLog = fs.readFileSync(path.join(lost.dataDir, "restore-few.log"), "utf8");
    const heldLine = /Restored (\d+) stream\(s\); (\d+) already held/.exec(fewLog);
    check(!!heldLine && Number(heldLine[1]) <= 6 && Number(heldLine[2]) > 0, `only what was missing was fetched (${heldLine ? heldLine[0] : "no summary line"})`);

    // ---- 4: a umid in the middle of a stream's history that most nodes lost ----------
    report.phase("Restore: a stream's history has a umid only one node still holds");
    const sourceV2 = fs.readFileSync(path.join(__dirname, "contracts", "returner-contract.ts"), "utf8").replace('via: "returner-contract"', 'via: "returner-contract-v2"');
    const sourceV2Path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-restore-v2-")), "returner-contract.ts");
    fs.writeFileSync(sourceV2Path, sourceV2);
    const deployUmid = (await storageGet(origin.storageUrl, streamId))?.contract?.["0.0.1"]?.umid;
    await updateContract(origin.baseUrl, identity, NAMESPACE, streamId, CONTRACT_NAME, sourceV2Path, "0.0.2");
    check(
      await settle(async () => (await Promise.all(nodes.map((n) => storageGet(n.storageUrl, streamId).catch(() => null)))).every((d) => d?.contract?.["0.0.2"])),
      "every node has the updated contract"
    );
    check(typeof deployUmid === "string", "the deploy umid is known");
    // The nodes repair their own history for a few seconds after a commit
    // (SPI), which would put the umid straight back
    await new Promise((r) => setTimeout(r, 8000));
    // Held by one node only, so no majority of the lost node's neighbours has it
    for (const n of [nodes[1], nodes[2], lost]) await storageDelete(n.storageUrl, `${deployUmid}:umid`).catch(() => undefined);
    const hasUmid = (n: { storageUrl: string }) => storageGet(n.storageUrl, `${deployUmid}:umid`).then((d: any) => !!d?._id).catch(() => false);
    check((await hasUmid(origin)) && !(await hasUmid(lost)), "only the first node holds the deploy umid");
    await runRestore(lost.dataDir, "restore-no-history", ["--skip-history"]);
    check(!(await hasUmid(lost)), "--skip-history leaves it out, so the state restore alone does not find it");
    const ms4 = await runRestore(lost.dataDir, "restore-history");
    report.info(`took ${ms4}ms`);
    check(await hasUmid(lost), "the history pass found it and fetched it");
    const histLog = fs.readFileSync(path.join(lost.dataDir, "restore-history.log"), "utf8");
    check(/History Complete;.*[1-9]\d* umid\(s\) recovered/.test(histLog), "and reported what it recovered");
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
