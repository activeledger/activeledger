/**
 * Measures what `activerestore --full` costs a live network, on a ledger big
 * enough to notice.
 *
 * Fills a 4-node network with RESTORE_STREAMS identities (default 300), empties
 * one node's ledger, then restores it while the other nodes keep taking
 * transactions. Reports how long the restore took and how much slower the live
 * transactions were while it ran. It asserts correctness (every document is
 * back at the network's revision) and prints the numbers; it does not fail on
 * speed, because the right limit is for whoever sets the throttle to choose.
 *
 * RESTORE_STREAMS=1000 npm run test:network:restore:load
 * RESTORE_FAST=1 turns the restore's throttle off (--fast) to see the difference.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import { NetworkHarness } from "./harness";
import { requestJson, storageDelete } from "./http";
import { Report } from "./report";
import { onboard } from "./actions";

const STREAMS = Number(process.env.RESTORE_STREAMS || 300);
const CONCURRENCY = 8;

const settle = async (cond: () => boolean, tries: number, every = 100) => {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, every));
  return cond();
};

async function ledger(storageUrl: string): Promise<Map<string, string>> {
  const rows: any[] = [];
  // all_docs pages; the engine caps a page, so walk it
  for (let start = ""; ; ) {
    const url = `${storageUrl}/activeledger/_all_docs` + (start ? `?startkey=${encodeURIComponent(JSON.stringify(start))}&skip=1` : "");
    const page = await requestJson(url, "GET");
    const got: any[] = page?.rows || [];
    if (!got.length) break;
    rows.push(...got);
    start = got[got.length - 1].id;
    if (got.length < 2) break;
  }
  return new Map(rows.map((r) => [r.id, r.value?.rev]));
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const describe = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50)}ms p95=${pct(xs, 95)}ms max=${pct(xs, 100)}ms`;

/** Submit onboards at the given nodes until `stop()`, recording how long each took. */
async function liveLoad(urls: string[], stop: () => boolean): Promise<number[]> {
  const times: number[] = [];
  const worker = async (w: number) => {
    while (!stop()) {
      const t = Date.now();
      try {
        await onboard(urls[w % urls.length]);
        times.push(Date.now() - t);
      } catch {
        times.push(Date.now() - t);
      }
    }
  };
  await Promise.all([0, 1, 2].map(worker));
  return times;
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
    const live = nodes.slice(0, 3).map((n) => n.baseUrl);

    report.phase(`Filling the ledger with ${STREAMS} identities`);
    const fillStart = Date.now();
    let made = 0;
    const next = async () => {
      while (made < STREAMS) {
        made++;
        await onboard(origin.baseUrl);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, next));
    report.ok(`${STREAMS} identities in ${Date.now() - fillStart}ms`);

    // Baseline: the same load with nothing else going on
    report.phase("Baseline: live transactions with no restore running");
    let stopBaseline = false;
    setTimeout(() => (stopBaseline = true), 8000);
    const baseline = await liveLoad(live, () => stopBaseline);
    report.info(describe(baseline));

    // let the fourth node catch up before it is emptied
    await new Promise((r) => setTimeout(r, 3000));
    const want = new Map([...(await ledger(origin.storageUrl))].filter(([id]) => !id.endsWith(":volatile")));
    report.phase("Emptying one node's ledger");
    report.info(`the network ledger holds ${want.size} documents`);
    for (const id of (await ledger(lost.storageUrl)).keys()) {
      await storageDelete(lost.storageUrl, id).catch(() => undefined);
    }
    check((await ledger(lost.storageUrl)).size === 0, "the node's ledger is empty");

    report.phase("Restoring it while the other nodes take transactions");
    const configPath = path.join(lost.dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.consensus = { ...(config.consensus || {}), reached: 60 };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const entry = path.join(__dirname, "..", "..", "packages", "restore", "lib", "index.js");
    const logPath = path.join(lost.dataDir, "restore-load.log");
    const fd = fs.openSync(logPath, "w");
    const started = Date.now();
    const child = spawn(process.execPath, [entry, "--full", ...(process.env.RESTORE_FAST ? ["--fast"] : [])], { cwd: lost.dataDir, stdio: ["ignore", fd, fd] });
    let restoreDone = false;
    const waiter = settle(() => /Rebuild Complete|error running quick full restore/.test(fs.readFileSync(logPath, "utf8")), 20000)
      .then((ok) => {
        restoreDone = true;
        return ok;
      });
    const during = await liveLoad(live, () => restoreDone);
    const finished = await waiter;
    report.info(`throttle: ${process.env.RESTORE_FAST ? "off (--fast)" : "default"}`);
    const took = Date.now() - started;
    child.kill();
    check(finished, "the restore reported completion");
    report.info(`restore took ${took}ms for ${want.size} documents (${Math.round((want.size / took) * 1000)} docs/s)`);
    report.info(`live transactions during it: ${describe(during)}`);
    report.info(`live transactions baseline : ${describe(baseline)}`);
    if (baseline.length && during.length) {
      report.info(`p95 slowdown while restoring: x${(pct(during, 95) / Math.max(1, pct(baseline, 95))).toFixed(2)}`);
    }

    const got = await ledger(lost.storageUrl);
    const missing = [...want.keys()].filter((id) => !got.has(id));
    const wrong = [...want].filter(([id, rev]) => got.has(id) && got.get(id) !== rev).map(([id]) => id);
    if (missing.length) {
      await new Promise((r) => setTimeout(r, 3000));
      for (const id of missing.slice(0, 6)) {
        const direct = await requestJson(`${lost.storageUrl}/activeledger/${encodeURIComponent(id)}`, "GET").catch((e) => ({ error: String(e) }));
        const held = await Promise.all(nodes.map((n) => requestJson(`${n.storageUrl}/activeledger/${encodeURIComponent(id)}`, "GET").then((d: any) => (d?._rev ? d._rev.slice(0, 6) : "-")).catch(() => "-")));
        report.warn(`holders of ${id.slice(0, 8)}: ${held.join(" ")}`);
        report.warn(`${id.slice(0, 16)}${id.slice(64)} on the node now: ${direct?._rev ? "present " + direct._rev : JSON.stringify(direct).slice(0, 80)}; network ${want.get(id)}`);
      }
    }
    if (missing.length || wrong.length) {
      const kept = path.join(os.tmpdir(), "restore-load.log");
      fs.copyFileSync(logPath, kept);
      report.warn(`restore output kept at ${kept}`);
    }
    check(missing.length === 0, missing.length ? `${missing.length} of ${want.size} documents not restored, e.g. ${missing.slice(0, 3).join(", ")}` : `all ${want.size} documents are back`);
    check(wrong.length === 0, wrong.length ? `${wrong.length} documents at a different revision` : "every revision matches the network");
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nRESTORE LOAD CHECK PASSED\n" : "\nRESTORE LOAD CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
