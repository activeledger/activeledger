/**
 * Realistic-users stress tool: a multi-node network offered a stepped ladder
 * of transaction rates by thousands of distinct users, each held to a
 * per-user rate limit (default one transaction per 6.6 s), arriving as an
 * open-loop Poisson process. Reports what the network committed at each
 * offered rate, the latency users saw, and what it cost in CPU, and says
 * which steps it sustained. Writes a one page PDF with --pdf.
 *
 *   npm run stress:realistic -- --pdf report.pdf
 */

import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import { COMMON_FLAGS, FlagSpec, formatTable, runTool } from "./lib/cli";
import { ProcRow, clockTicksPerSecond, cpuSecondsByRole, memoryByRole, sampleNetwork } from "./lib/proc";
import { appendRecord, defaultOut, environment } from "./lib/results";
import { percentile } from "./lib/stats";
import { gate, loadNow, setupWorkload, sleep, withNetwork } from "./lib/workload";
import type { PrepareCommand, StageCommand, StageResult, WorkerInit } from "./lib/realistic-worker";
import { writeRealisticPdf } from "./lib/realistic-report";

const SPECS: FlagSpec[] = [
  { name: "nodes", type: "number", default: 4, description: "nodes in the network" },
  { name: "rates", type: "string", default: "300,500,700,900,1100", description: "offered tx/s steps, comma separated, ascending" },
  { name: "duration", type: "number", default: 45, description: "seconds per step, warm-up included" },
  { name: "warmup", type: "number", default: 10, description: "seconds at the start of each step excluded from the figures" },
  { name: "settle", type: "number", default: 5, description: "seconds of quiet between steps" },
  { name: "users", type: "number", default: 1000, description: "distinct users (each with its own key and stream); a user is not used again while its previous transaction is in flight" },
  { name: "contract", type: "string", default: "no-write", choices: ["no-write", "returner"], description: "no-write: validates and returns, writes no state; returner: writes a message onto the user's stream" },
  { name: "join-pct", type: "number", default: 5, description: "percent of arrivals that are a new user joining (onboard); the rest are contract transactions on the user's own stream" },
  { name: "workers", type: "number", default: 6, description: "load-generator threads" },
  { name: "sustain-pct", type: "number", default: 97, description: "a step is sustained if the network committed at least this percent of the offered rate" },
  { name: "max-fail-pct", type: "number", default: 0.5, description: "... and no more than this percent of transactions failed" },
  { name: "max-p99-ms", type: "number", default: 3000, description: "... and p99 latency stayed under this" },
  { name: "stop-after", type: "number", default: 2, description: "stop climbing after this many unsustained steps in a row" },
  { name: "node-config", type: "string", description: "JSON merged into every node's config.json before it starts, e.g. '{\"debug\":false}' (recorded in the results)" },
  { name: "pdf", type: "string", description: "write a one page PDF summary to this path" },
  { name: "from", type: "string", description: "do not run: build the --pdf from an existing results file" },
  ...COMMON_FLAGS,
];

const HELP = `The population: --users distinct users, all onboarded before the first step, each
with one transaction in flight at most. There is no per-user rate limit. Arrivals
are open loop: the generator keeps offering the rate whether or not earlier
transactions have been answered, so a network that cannot keep up shows as
committed < offered and rising latency, not as a quietly slower test.

Example:
  npm run stress:realistic -- --pdf tps.pdf
  npm run stress:realistic -- --rates 700,900 --duration 60 --pdf tps.pdf
  npm run stress:realistic -- --from stress-results/realistic-X.jsonl --pdf tps.pdf`;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

runTool("stress:realistic", "Stepped open-loop load from thousands of rate-limited users on a multi-node network.", SPECS, HELP, async (f) => {
  if (f.from) {
    if (!f.pdf) {
      console.error("stress:realistic: --from needs --pdf");
      return 2;
    }
    await writeRealisticPdf(f.from, f.pdf);
    console.log(`wrote ${f.pdf}`);
    return 0;
  }
  const rates: number[] = String(f.rates).split(",").map(Number);
  if (!rates.length || rates.some((r) => !(r > 0))) {
    console.error("stress:realistic: --rates needs positive numbers");
    return 2;
  }
  if (f.warmup >= f.duration) {
    console.error("stress:realistic: --warmup must be shorter than --duration");
    return 2;
  }
  const out: string = f.out || defaultOut("realistic");
  const env = environment();
  const maxUsers = f.users;
  const perWorker = Math.ceil(maxUsers / f.workers);
  const estMin = (rates.length * (f.duration + f.settle) + 60 + maxUsers / 400) / 60;
  console.log(`stress:realistic: ${f.nodes} nodes, steps ${rates.join(", ")} tx/s, ${f.duration}s each (${f.warmup}s warm-up), ${maxUsers} users, ${f.joinPct}% joins`);
  console.log(`about ${estMin.toFixed(1)} minutes; results in ${out}`);
  if (f.dryRun) return 0;

  const gateResult = await gate(f);
  const loadStart = loadNow();
  appendRecord(out, {
    tool: "realistic", kind: "meta", ts: new Date().toISOString(), label: f.label, group: "meta", ...env,
    nodes: f.nodes, rates, durationSec: f.duration, warmupSec: f.warmup, joinPct: f.joinPct, contract: f.contract, nodeConfig: f.nodeConfig, sustainPct: f.sustainPct, maxFailPct: f.maxFailPct, maxP99Ms: f.maxP99Ms,
    users: maxUsers, workers: f.workers, cpuModel: os.cpus()[0] && os.cpus()[0].model, totalMemGb: +(os.totalmem() / 2 ** 30).toFixed(1),
    gateQuiet: gateResult ? gateResult.quiet : undefined, loadStart,
  });

  const tick = clockTicksPerSecond();
  let status = 0;
  const records: any[] = [];

  await withNetwork({ nodeCount: f.nodes, basePort: f.basePort, readyTimeoutMs: 90000, config: f.nodeConfig ? JSON.parse(f.nodeConfig) : undefined }, async (_h, nodes) => {
    const handles = () => nodes.map((n) => ({ index: n.index, pid: n.child.pid!, dataDir: n.dataDir }));
    const workload = await setupWorkload(nodes, f.contract, 0);
    console.log(`onboarding ${maxUsers} users over ${f.workers} threads ...`);
    const t0 = Date.now();
    const workers: Worker[] = [];
    const prepareAll = (cmd: PrepareCommand) => Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
      const on = (m: any) => {
        if (m.type === "prepared") { w.off("message", on); resolve(); }
        else if (m.type === "error") { w.off("message", on); reject(new Error(m.message)); }
      };
      w.on("message", on);
      w.postMessage(cmd);
    })));
    const send = (w: Worker, cmd: StageCommand) => new Promise<StageResult>((resolve, reject) => {
      const on = (m: any) => {
        if (m.type === "result") { w.off("message", on); resolve(m.result); }
        else if (m.type === "error") { w.off("message", on); reject(new Error(m.message)); }
      };
      w.on("message", on);
      w.postMessage(cmd);
    });
    try {
      await Promise.all(Array.from({ length: f.workers }, (_, index) => new Promise<void>((resolve, reject) => {
        const init: WorkerInit = { urls: nodes.map((n) => n.baseUrl), namespace: workload.namespace, contractId: workload.contractId, users: perWorker, index: index * perWorker };
        const w = new Worker(path.join(__dirname, "lib", "realistic-worker.ts"), { workerData: init });
        workers.push(w);
        w.on("error", reject);
        const on = (m: any) => {
          if (m.type === "ready") { w.off("message", on); resolve(); }
          else if (m.type === "error") reject(new Error(m.message));
        };
        w.on("message", on);
      })));
      console.log(`  ${workers.length * perWorker} users ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

      let failedInARow = 0;
      for (const rate of rates) {
        await sleep(f.settle * 1000);
        const activePerWorker = perWorker;
        const cmd: StageCommand = { type: "stage", rate: rate / f.workers, durationSec: f.duration, warmupSec: f.warmup, activeUsers: activePerWorker, joinShare: f.joinPct / 100 };
        const tp = Date.now();
        await prepareAll({ type: "prepare", rate: cmd.rate, durationSec: f.duration, activeUsers: activePerWorker, joinShare: cmd.joinShare });
        console.log(`  signed the step's transactions in advance (${((Date.now() - tp) / 1000).toFixed(0)}s)`);
        await sleep(2000);
        const loadBefore = loadNow();
        let cpuBefore: ProcRow[] = [];
        let cpuAfter: ProcRow[] = [];
        const cpuTimer = setTimeout(() => (cpuBefore = sampleNetwork(handles())), f.warmup * 1000);
        const stop = setTimeout(() => (cpuAfter = sampleNetwork(handles())), (f.duration - 0.5) * 1000);
        const results = await Promise.all(workers.map((w) => send(w, cmd)));
        clearTimeout(cpuTimer);
        clearTimeout(stop);
        const lat = results.flatMap((r) => r.latenciesMs);
        const committed = sum(results.map((r) => r.committed));
        const failed = sum(results.map((r) => r.failed));
        const measured = sum(results.map((r) => r.measured));
        const sec = results[0].measuredSec;
        const cpu = cpuBefore.length && cpuAfter.length ? cpuSecondsByRole(cpuBefore, cpuAfter, tick) : {};
        const window = f.duration - 0.5 - f.warmup;
        const reasons: Record<string, number> = {};
        for (const r of results) for (const [k, v] of Object.entries(r.reasons)) reasons[k] = (reasons[k] || 0) + v;
        const rec: any = {
          tool: "realistic", kind: "run", ts: new Date().toISOString(), label: f.label, group: `nodes=${f.nodes}`, ...env,
          nodes: f.nodes, offeredTps: rate, activeUsers: activePerWorker * f.workers,
          sentTps: +(sum(results.map((r) => r.measured)) / sec).toFixed(1),
          committedTps: +(committed / sec).toFixed(1),
          committedPctOfOffered: +((100 * committed) / sec / rate).toFixed(1),
          failedPct: +(measured ? (100 * failed) / measured : 0).toFixed(2),
          p50Ms: +percentile(lat, 50).toFixed(0), p90Ms: +percentile(lat, 90).toFixed(0), p99Ms: +percentile(lat, 99).toFixed(0), maxMs: +Math.max(...lat, 0).toFixed(0),
          generatorLagP99Ms: +Math.max(...results.map((r) => r.lagP99Ms)).toFixed(0),
          peakInFlight: sum(results.map((r) => r.peakInFlight)),
          poolExhausted: sum(results.map((r) => r.poolExhausted)),
          signedInline: sum(results.map((r) => r.signedInline)),
          cpuCores: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +((v as number) / window).toFixed(2)])),
          rssMb: Object.fromEntries(Object.entries(memoryByRole(cpuAfter)).map(([k, v]) => [k, Math.round(v!.totalRssMb)])),
          failureReasons: reasons, loadBefore, loadAfter: loadNow(),
        };
        rec.sustained = rec.committedPctOfOffered >= f.sustainPct && rec.failedPct <= f.maxFailPct && rec.p99Ms <= f.maxP99Ms;
        appendRecord(out, rec);
        records.push(rec);
        console.log(`  offered ${rate} tx/s: committed ${rec.committedTps} (${rec.committedPctOfOffered}%)  fail ${rec.failedPct}%  p50 ${rec.p50Ms} ms  p99 ${rec.p99Ms} ms  load ${loadBefore.load1}->${rec.loadAfter.load1}  ${rec.sustained ? "SUSTAINED" : "not sustained"}`);
        for (const [k, v] of Object.entries(reasons).slice(0, 3)) console.log(`    ${v} x ${k}`);
        if (rec.poolExhausted > 0) console.log(`    note: ${rec.poolExhausted} arrivals were dropped because every user already had a transaction in flight; use more --users`);
        if (rec.generatorLagP99Ms > 50) console.log(`    note: the generator's own timer ran ${rec.generatorLagP99Ms} ms late at p99; this machine is too busy to offer the rate cleanly`);
        failedInARow = rec.sustained ? 0 : failedInARow + 1;
        if (failedInARow >= f.stopAfter) {
          console.log(`  ${failedInARow} steps in a row not sustained: stopping the climb`);
          break;
        }
      }
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
  });

  console.log("");
  console.log(
    formatTable(
      ["offered", "committed", "% offered", "fail %", "p50 ms", "p99 ms", "cores", "sustained"],
      records.map((r) => [String(r.offeredTps), String(r.committedTps), String(r.committedPctOfOffered), String(r.failedPct), String(r.p50Ms), String(r.p99Ms), String(+Object.values(r.cpuCores as Record<string, number>).reduce((a, b) => a + b, 0).toFixed(1)), r.sustained ? "yes" : "no"])
    )
  );
  appendRecord(out, { tool: "realistic", kind: "summary", ts: new Date().toISOString(), group: "summary", loadEnd: loadNow(), loadStart });
  if (f.pdf) {
    await writeRealisticPdf(out, f.pdf);
    console.log(`wrote ${f.pdf}`);
  }
  return status;
});

