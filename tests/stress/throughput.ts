/**
 * Throughput stress tool: a closed loop of transactions against a real
 * harness network, for each network size in turn, round after round (so
 * sizes are interleaved). See docs/guide/operate/stress-tests.md.
 *
 *   npm run stress:throughput -- --profile quick
 */

import { COMMON_FLAGS, FlagSpec, formatTable, runTool } from "./lib/cli";
import { THROUGHPUT_PROFILES, parseNodeList, planThroughput } from "./lib/plans";
import { valueResolution } from "./lib/resolution";
import { appendRecord, defaultOut, environment } from "./lib/results";
import { median, percentile, summarise } from "./lib/stats";
import { CONTRACT_FILES, gate, hotTransaction, loadNow, setupWorkload, timedSubmit, uniqueTransaction, withNetwork } from "./lib/workload";

const SPECS: FlagSpec[] = [
  { name: "nodes", type: "string", default: "4", description: "network sizes, comma separated, e.g. 4 or 1,4,8 (the profile sets 1,4)" },
  { name: "clients", type: "number", default: 8, description: "concurrent clients; each submits its transactions one after another" },
  { name: "duration", type: "number", default: 60, description: "seconds of load per run, warm-up included (the profile sets it)" },
  { name: "warmup", type: "number", default: 20, description: "seconds at the start of each run excluded from the figures (the profile sets it)" },
  { name: "tx-per-client", type: "number", description: "instead of a duration: each client sends exactly this many transactions (pre-signed, after 20 unmeasured ones)" },
  { name: "reps", type: "number", default: 3, description: "rounds; each round runs every size once on a fresh network (the profile sets it)" },
  { name: "stop-early", type: "boolean", default: false, description: "after round 2, stop if the spread already resolves --target-pct (the standard profile turns it on)" },
  { name: "target-pct", type: "number", default: 5, description: "for --stop-early: the resolving power, in percent, that is good enough" },
  { name: "contract", type: "string", default: "returner", choices: Object.keys(CONTRACT_FILES), description: "contract the transactions run (hot mode only)" },
  { name: "mode", type: "string", default: "hot", choices: ["hot", "unique"], description: "hot: each client keeps writing its own stream; unique: every transaction creates a new stream (an onboard, whatever --contract is)" },
  { name: "entry", type: "string", default: "spread", choices: ["spread", "first"], description: "spread: clients enter at nodes in turn; first: all enter at node 0" },
  { name: "fail-on-uncommitted", type: "boolean", default: false, description: "exit 1 if any transaction did not commit (always reported either way)" },
  { name: "min-tps", type: "number", description: "fail (exit 1) if the median tx/s of any size is below this" },
  { name: "max-p99-ms", type: "number", description: "fail (exit 1) if the median p99 latency of any size is above this" },
  ...COMMON_FLAGS,
];

const HELP = `Profiles: quick (60 s runs, 3 rounds over 1 and 4 nodes), standard (150 s runs, 3
rounds, may stop early), full (150 s runs, 5 rounds). Flags you give override the
profile. At the end the tool prints the resolving power of what it measured.

Exit status: 0 whenever the tool ran and printed its report (uncommitted
transactions are reported, not fatal). 1 only if you pass a gate: --min-tps,
--max-p99-ms or --fail-on-uncommitted and it is missed; 2 if it could not run.

Example:
  npm run stress:throughput -- --profile quick --out /tmp/a.jsonl
  npm run stress:throughput -- --profile standard --dry-run
  npm run stress:throughput -- --nodes 8 --base-port 5610 --mode unique --duration 90 --warmup 20`;

const WARMUP_TX = 20;

runTool(
  "stress:throughput",
  "Closed-loop throughput and latency on a harness network; every response is checked for a commit.",
  SPECS,
  HELP,
  async (f) => {
    const out: string = f.out || defaultOut("throughput");
    const env = environment();
    const sizes = parseNodeList(f.nodes);
    const countMode = f.txPerClient !== undefined;
    if (!countMode && f.warmup >= f.duration) {
      console.error("stress:throughput: --warmup must be shorter than --duration");
      return 2;
    }
    console.log(planThroughput(f));
    console.log(`results in ${out}`);

    await gate(f);
    const bySize = new Map<number, any[]>(sizes.map((n) => [n, []]));
    let uncommittedRuns = 0;
    let rounds = 0;

    for (let round = 0; round < f.reps; round++) {
      rounds++;
      for (const nodeCount of sizes) {
        const group = `nodes=${nodeCount} clients=${f.clients} mode=${f.mode} contract=${f.mode === "unique" ? "onboard" : f.contract} entry=${f.entry}`;
        const record: any = await withNetwork({ nodeCount, basePort: f.basePort, readyTimeoutMs: 60000 }, async (_h, nodes) => {
          const workload = await setupWorkload(nodes, f.contract, f.clients);
          const entryOf = (client: number) => (f.entry === "first" ? nodes[0] : nodes[client % nodes.length]).baseUrl;
          const build = (client: number, i: number) => (f.mode === "unique" ? uniqueTransaction() : hotTransaction(workload, client, `g${round}c${client}i${i}`));
          const latencies: number[] = [];
          const reasons = new Map<string, number>();
          let okMeasured = 0;
          let failed = 0;
          const note = (t: { committed: boolean; reason?: string }) => {
            if (t.committed) return;
            failed++;
            reasons.set(t.reason || "unknown", (reasons.get(t.reason || "unknown") || 0) + 1);
          };

          const loadBefore = loadNow();
          let wall: number;
          if (countMode) {
            for (let i = 0; i < WARMUP_TX; i++) note(await timedSubmit(entryOf(i % f.clients), build(i % f.clients, -1 - i)));
            // Signing is outside the timed section: the tool measures the network.
            const batches = Array.from({ length: f.clients }, (_, c) => Array.from({ length: f.txPerClient }, (_, i) => build(c, i)));
            const start = process.hrtime.bigint();
            await Promise.all(
              batches.map(async (list, client) => {
                for (const tx of list) {
                  const t = await timedSubmit(entryOf(client), tx);
                  latencies.push(t.ms);
                  if (t.committed) okMeasured++;
                  note(t);
                }
              })
            );
            wall = Number(process.hrtime.bigint() - start) / 1e9;
          } else {
            // Signed just before each submit (RSA signing is cheap beside a
            // network round trip), so a run can be as long as it likes.
            const t0 = Date.now();
            const warmEnd = t0 + f.warmup * 1000;
            const stopAt = t0 + f.duration * 1000;
            await Promise.all(
              Array.from({ length: f.clients }, async (_, client) => {
                for (let i = 0; Date.now() < stopAt; i++) {
                  const t = await timedSubmit(entryOf(client), build(client, i));
                  if (Date.now() >= warmEnd) {
                    latencies.push(t.ms);
                    if (t.committed) okMeasured++;
                  }
                  note(t);
                }
              })
            );
            wall = (Date.now() - warmEnd) / 1000;
          }
          return {
            tool: "throughput",
            kind: "run",
            ts: new Date().toISOString(),
            label: f.label,
            profile: f.profile,
            group,
            ...env,
            nodes: nodeCount,
            clients: f.clients,
            mode: f.mode,
            contract: f.mode === "unique" ? "onboard" : f.contract,
            entry: f.entry,
            round,
            measuredSec: +wall.toFixed(1),
            ok: okMeasured,
            of: latencies.length,
            failedTx: failed,
            tps: +(okMeasured / wall).toFixed(2),
            p50Ms: +percentile(latencies, 50).toFixed(1),
            p90Ms: +percentile(latencies, 90).toFixed(1),
            p99Ms: +percentile(latencies, 99).toFixed(1),
            failureReasons: Object.fromEntries(reasons),
            loadBefore,
            loadAfter: loadNow(),
          };
        });
        appendRecord(out, record);
        bySize.get(nodeCount)!.push(record);
        if (record.failedTx > 0) uncommittedRuns++;
        console.log(
          `  round ${round + 1}/${f.reps}, ${nodeCount} node(s): ${record.tps} tx/s  p50 ${record.p50Ms} ms  p99 ${record.p99Ms} ms  committed ${record.ok}/${record.of}  load ${record.loadBefore.load1}->${record.loadAfter.load1}`
        );
        for (const [reason, n] of Object.entries(record.failureReasons)) console.log(`    ${n} x ${reason}`);
      }
      if (f.stopEarly && round >= 1 && round + 1 < f.reps) {
        const worst = Math.max(...sizes.map((n) => valueResolution(bySize.get(n)!.map((r) => r.tps)).detectablePct));
        if (worst <= f.targetPct) {
          console.log(`early stop after round ${round + 1}: resolving power ${worst.toFixed(1)}% is within --target-pct ${f.targetPct}`);
          break;
        }
      }
    }

    let status = 0;
    console.log(`summary over ${rounds} round(s)`);
    for (const nodeCount of sizes) {
      const runs = bySize.get(nodeCount)!;
      const tps = summarise(runs.map((r) => r.tps));
      const p50 = summarise(runs.map((r) => r.p50Ms));
      const p99 = summarise(runs.map((r) => r.p99Ms));
      const res = valueResolution(runs.map((r) => r.tps));
      console.log(`  ${nodeCount} node(s): tx/s median ${tps.median.toFixed(1)} IQR ${tps.iqr.toFixed(1)} (min ${tps.min.toFixed(1)}, max ${tps.max.toFixed(1)}); p50 median ${p50.median.toFixed(1)} ms; p99 median ${p99.median.toFixed(1)} ms IQR ${p99.iqr.toFixed(1)}`);
      appendRecord(out, { tool: "throughput", kind: "summary", ts: new Date().toISOString(), label: f.label, profile: f.profile, group: runs[0].group, runs: runs.length, tps, p50Ms: p50, p99Ms: p99, resolution: res });
      if (f.minTps !== undefined && median(runs.map((r) => r.tps)) < f.minTps) {
        console.error(`FAIL: ${nodeCount} node(s): median ${tps.median.toFixed(1)} tx/s is below --min-tps ${f.minTps}`);
        status = 1;
      }
      if (f.maxP99Ms !== undefined && p99.median > f.maxP99Ms) {
        console.error(`FAIL: ${nodeCount} node(s): median p99 ${p99.median.toFixed(1)} ms is above --max-p99-ms ${f.maxP99Ms}`);
        status = 1;
      }
    }
    console.log(`resolving power (${f.profile} profile)`);
    for (const nodeCount of sizes) {
      const res = valueResolution(bySize.get(nodeCount)!.map((r) => r.tps));
      console.log(
        `  ${nodeCount} node(s): ${res.n} runs, run-to-run spread ${Number.isFinite(res.spreadPct) ? res.spreadPct.toFixed(1) : "n/a"}% of the median; an A/B of this size could only call a tx/s change larger than about ${Number.isFinite(res.detectablePct) ? res.detectablePct.toFixed(1) : "any size of"}%`
      );
      if (res.n < 3) console.log("    fewer than 3 runs: the spread itself is not reliable");
      else if (res.detectablePct > 5) console.log("    changes smaller than that are inside the noise of this run: use the standard or full profile to see them");
    }
    console.log("");
    console.log(`throughput results (${f.profile} profile)`);
    console.log(
      formatTable(
        ["nodes", "runs", "tx/s median", "tx/s IQR", "p50 ms", "p99 ms", "committed"],
        sizes.map((n) => {
          const runs = bySize.get(n)!;
          const tps = summarise(runs.map((r) => r.tps));
          return [String(n), String(runs.length), tps.median.toFixed(1), tps.iqr.toFixed(1), median(runs.map((r) => r.p50Ms)).toFixed(1), median(runs.map((r) => r.p99Ms)).toFixed(1), uncommittedRuns ? `${uncommittedRuns} run(s) with failures` : "all"];
        })
      )
    );
    console.log(`results written to ${out}`);
    if (uncommittedRuns) {
      const msg = `${uncommittedRuns} run(s) had transactions that did not commit`;
      if (f.failOnUncommitted) {
        console.error(`FAIL: ${msg}`);
        status = 1;
      } else console.log(`note: ${msg}`);
    }
    return status;
  },
  THROUGHPUT_PROFILES,
  planThroughput
);
