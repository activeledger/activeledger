/**
 * Live test of `activeledger prune` against a running node: old rows are put
 * straight into its own errors, archive, events and a stray database, then the
 * command is run the ways an operator would and what is left is checked.
 *  - a dry run changes nothing;
 *  - the default removes old processed errors and the archive, keeps an old
 *    unprocessed error and everything recent, and leaves the events alone;
 *  - --include-umids and --include-events remove the old index rows and events
 *    and keep the recent ones (including the ones this network just made);
 *  - a database the node does not use is left alone unless named, and the
 *    node's own databases are refused;
 *  - the ledger is never touched, and the node still commits afterwards.
 * Not a Mocha suite - run via `npm run test:network:prune`.
 */

import * as path from "path";
import { spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storagePut } from "./http";
import { Report } from "./report";
import { onboard } from "./actions";

const LEDGER = path.resolve(__dirname, "../../packages/activeledger/lib/index.js");
const DAY = 86400e3;

function run(args: string[], cwd: string, timeoutMs = 60000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LEDGER, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const hex = (n: number) => n.toString(16).padStart(64, "0");

async function ids(storageUrl: string, db: string): Promise<string[]> {
  const r = await requestJson(`${storageUrl}/${db}/_all_docs`, "GET");
  return ((r.rows || []) as any[]).map((x) => String(x._id ?? x.id)).sort();
}

async function dbs(storageUrl: string): Promise<string[]> {
  return (await requestJson(`${storageUrl}/_all_dbs`, "GET")) as string[];
}

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 3, basePort: 5730, readyTimeoutMs: 40000 });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };

  try {
    report.phase("Booting 3 nodes and making some real commits");
    const nodes = await harness.start();
    const node = nodes[0];
    const store = node.storageUrl;
    await onboard(nodes[0].baseUrl);
    await onboard(nodes[1].baseUrl);
    const now = Date.now();
    const old = now - 45 * DAY;
    const recent = now - 2 * DAY;

    const realRows = async () => (await ids(store, "activeledgerevents")).filter((id) => id.startsWith("umid:") && Number(id.slice(5, 18)) > now - DAY);
    const deadline = Date.now() + 20000;
    while (!(await realRows()).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    const real = await realRows();
    check(real.length > 0, `${real.length} index row(s) from this network's own commits`);

    report.phase("Putting old and recent rows into the node's own stores");
    const rows: [string, string, any][] = [
      ["activeledgererrors", `${hex(1)}:${old}`, { processed: true, code: 1200 }],
      ["activeledgererrors", `${hex(2)}:${old}`, { processed: false, code: 950 }],
      ["activeledgererrors", `${hex(3)}:${recent}`, { processed: true, code: 1200 }],
      ["activeledgererrors_archive", `${hex(4)}:${old}`, { processed: true }],
      ["activeledgererrors_archive", `${hex(5)}:${recent}`, { processed: true }],
      ["activeledgerevents", `umid:${old},${hex(6)}`, { x: 1 }],
      ["activeledgerevents", `fail:${old},${hex(7)}`, { x: 1 }],
      ["activeledgerevents", `event:${old}-1,${hex(8)}`, { name: "old" }],
      ["activeledgerevents", `umid:${recent},${hex(9)}`, { x: 1 }],
      ["activeledgerevents", `event:${recent}-1,${hex(10)}`, { name: "recent" }],
      ["activeledgerstray", "keep-me", { x: 1 }],
    ];
    for (const [db, id, doc] of rows) await storagePut(store, id, doc, db);
    const ledgerBefore = await ids(store, "activeledger");
    report.ok(`${rows.length} rows written; the ledger holds ${ledgerBefore.length} documents`);

    report.phase("A dry run changes nothing");
    const eventsBefore = await ids(store, "activeledgerevents");
    const errorsBefore = await ids(store, "activeledgererrors");
    const dry = await run(["prune", "30", "--dry-run", "--include-umids", "--include-events"], node.dataDir);
    check(dry.code === 0 && /Dry run/.test(dry.out) && /Would remove [1-9]/.test(dry.out), `dry run: ${dry.out.trim().split("\n").pop()}`);
    check(JSON.stringify(await ids(store, "activeledgerevents")) === JSON.stringify(eventsBefore), "the events database is as it was");
    check(JSON.stringify(await ids(store, "activeledgererrors")) === JSON.stringify(errorsBefore), "the errors database is as it was");
    check((await dbs(store)).includes("activeledgerstray"), "the stray database is still there");

    report.phase("The default: handled errors and the archive");
    const plain = await run(["prune", "30"], node.dataDir);
    check(plain.code === 0, `prune 30: ${plain.out.trim().split("\n").pop()}`);
    const errors = await ids(store, "activeledgererrors");
    check(!errors.includes(`${hex(1)}:${old}`), "an old processed error was removed");
    check(errors.includes(`${hex(2)}:${old}`), "an old UNPROCESSED error was kept (it is a job the restore engine has not done)");
    check(errors.includes(`${hex(3)}:${recent}`), "a recent error was kept");
    const archive = await ids(store, "activeledgererrors_archive");
    check(!archive.includes(`${hex(4)}:${old}`) && archive.includes(`${hex(5)}:${recent}`), "the archive lost the old row and kept the recent one");
    check(JSON.stringify(await ids(store, "activeledgerevents")) === JSON.stringify(eventsBefore), "the events database was not touched without a flag");
    check(/left alone: activeledgerstray/.test(plain.out) && (await dbs(store)).includes("activeledgerstray"), "the stray database was listed and left alone");

    report.phase("--include-umids and --include-events");
    const flagged = await run(["prune", "30", "--include-umids", "--include-events", "--yes"], node.dataDir);
    check(flagged.code === 0, `prune: ${flagged.out.trim().split("\n").pop()}`);
    const events = await ids(store, "activeledgerevents");
    check(![`umid:${old},${hex(6)}`, `fail:${old},${hex(7)}`, `event:${old}-1,${hex(8)}`].some((id) => events.includes(id)), "the old umid, failure and event rows were removed");
    check(events.includes(`umid:${recent},${hex(9)}`) && events.includes(`event:${recent}-1,${hex(10)}`), "the recent ones were kept");
    check(real.every((id) => events.includes(id)), "every index row from this network's own commits was kept");
    const list = await requestJson(`${store}/activeledgerevents/umids`, "GET").catch(() => undefined);
    report.ok(`the umid list still answers (${Array.isArray(list) ? list.length : typeof list})`);

    report.phase("Databases that are not the node's");
    const refused = await run(["prune", "30", "--delete-db", "activeledgerevents"], node.dataDir);
    check(refused.code === 1 && /one of this node's own databases/.test(refused.out), "naming one of the node's own databases is refused");
    check((await dbs(store)).includes("activeledgerevents"), "and it is still there");
    const traversal = await run(["prune", "30", "--delete-db", "../x"], node.dataDir);
    check(traversal.code === 1, "a name that is not a plain name is refused");
    const named = await run(["prune", "30", "--delete-db", "activeledgerstray"], node.dataDir);
    check(named.code === 0 && !(await dbs(store)).includes("activeledgerstray"), "a database named with --delete-db is deleted");

    report.phase("The ledger is untouched and the node carries on");
    const ledgerAfter = await ids(store, "activeledger");
    check(ledgerBefore.every((id) => ledgerAfter.includes(id)), `all ${ledgerBefore.length} ledger documents are still there`);
    const bad = await run(["prune", "0"], node.dataDir);
    check(bad.code === 1, "days of 0 is refused");
    const after = await onboard(nodes[2].baseUrl);
    check(!!after.streamId, "a transaction commits after the prune");
  } catch (e) {
    passed = false;
    report.fail(`aborted: ${(e as Error).message}`);
  } finally {
    await harness.stop();
  }
  console.log(passed ? "\nPASSED" : "\nFAILED");
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
