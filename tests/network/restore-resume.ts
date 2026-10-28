/**
 * A full restore that is stopped part way and run again carries on rather
 * than starting over: what it already wrote is skipped, and what is left is
 * fetched.
 *
 * Fills a 4-node network, empties one node's ledger, starts a throttled
 * `activerestore --full`, kills it part way, runs it again, and checks the
 * second run fetched only the remainder and ended with the whole ledger.
 *
 * RESTORE_STREAMS=300 npm run test:network:restore:resume
 */

import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storageDelete } from "./http";
import { Report } from "./report";
import { onboard } from "./actions";

const STREAMS = Number(process.env.RESTORE_STREAMS || 300);

const settle = async (cond: () => boolean, tries: number, every = 100) => {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, every));
  return cond();
};

async function ledger(storageUrl: string): Promise<Map<string, string>> {
  const rows: any[] = [];
  for (let start = ""; ; ) {
    const url = `${storageUrl}/activeledger/_all_docs` + (start ? `?startkey=${encodeURIComponent(JSON.stringify(start))}&skip=1` : "");
    const got: any[] = (await requestJson(url, "GET"))?.rows || [];
    if (!got.length) break;
    rows.push(...got);
    start = got[got.length - 1].id;
  }
  return new Map(rows.filter((r) => !r.id.endsWith(":volatile")).map((r) => [r.id, r.value?.rev]));
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

  try {
    const [origin, , , lost] = nodes;
    report.phase(`Filling the ledger with ${STREAMS} identities`);
    let made = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (made < STREAMS) {
          made++;
          await onboard(origin.baseUrl);
        }
      })
    );
    await new Promise((r) => setTimeout(r, 3000));
    const want = await ledger(origin.storageUrl);
    report.ok(`the network ledger holds ${want.size} documents`);

    for (const id of (await ledger(lost.storageUrl)).keys()) await storageDelete(lost.storageUrl, id).catch(() => undefined);
    check((await ledger(lost.storageUrl)).size === 0, "the node's ledger is empty");

    const configPath = path.join(lost.dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.consensus = { ...(config.consensus || {}), reached: 60 };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const entry = path.join(__dirname, "..", "..", "packages", "restore", "lib", "index.js");
    const run = (name: string): { child: ChildProcess; log: () => string } => {
      const logPath = path.join(lost.dataDir, `${name}.log`);
      const fd = fs.openSync(logPath, "w");
      const child = spawn(process.execPath, [entry, "--full"], { cwd: lost.dataDir, stdio: ["ignore", fd, fd] });
      return { child, log: () => fs.readFileSync(logPath, "utf8") };
    };

    report.phase("First run: stopped part way");
    const first = run("restore-first");
    // Stop it once it has written something but not everything
    for (let i = 0; i < 600; i++) {
      if ((await ledger(lost.storageUrl)).size > want.size * 0.25) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    first.child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    const have = (await ledger(lost.storageUrl)).size;
    report.info(`killed with ${have} of ${want.size} documents written`);
    check(have > 0 && have < want.size, "it was stopped part way");

    report.phase("Second run: carries on");
    const second = run("restore-second");
    const finished = await settle(() => /Rebuild Complete|error running quick full restore/.test(second.log()), 3000);
    second.child.kill();
    check(finished, "the second run reported completion");
    const summary = /Restored (\d+) stream\(s\); (\d+) already held/.exec(second.log());
    report.info(summary ? summary[0] : "no summary line");
    check(!!summary && Number(summary[2]) > 0, "it skipped what the first run had written");
    check(!!summary && Number(summary[1]) < want.size, "it fetched only part of the ledger");

    const got = await ledger(lost.storageUrl);
    const missing = [...want.keys()].filter((id) => !got.has(id));
    const wrong = [...want].filter(([id, rev]) => got.has(id) && got.get(id) !== rev);
    check(missing.length === 0, missing.length ? `${missing.length} documents missing, e.g. ${missing.slice(0, 3).join(", ")}` : `all ${want.size} documents are back`);
    check(wrong.length === 0, "every revision matches the network");
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nRESTORE RESUME CHECK PASSED\n" : "\nRESTORE RESUME CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
