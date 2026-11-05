/**
 * Memory and CPU stress tool: memory per role (host, storage, restore,
 * worker) read from /proc at idle, after warm-up and under sustained load,
 * CPU per transaction per role, and the growth of each role in MB per 10k
 * transactions once warmed up. See docs/guide/operate/stress-tests.md.
 *
 *   npm run stress:memory -- --duration 120 --max-growth-mb-per-10k 5
 */

import { COMMON_FLAGS, FlagSpec, runTool } from "./lib/cli";
import { appendRecord, defaultOut, environment } from "./lib/results";
import { ProcRow, ROLES, Role, clockTicksPerSecond, cpuSecondsByRole, memoryByRole, sampleNetwork } from "./lib/proc";
import { percentile, slopeFit } from "./lib/stats";
import { describeGrowth, growthLevel } from "./lib/resolution";
import { MEMORY_PROFILES, planMemory } from "./lib/plans";
import { CONTRACT_FILES, gate, hotTransaction, loadNow, setupWorkload, sleep, timedSubmit, withNetwork } from "./lib/workload";

const SPECS: FlagSpec[] = [
  { name: "nodes", type: "number", default: 4, description: "nodes in the network" },
  { name: "clients", type: "number", default: 16, description: "concurrent clients during the load phase" },
  { name: "duration", type: "number", default: 240, description: "seconds of sustained load, warm-up included (the profile sets it: quick 240, standard 780, full 1500)" },
  { name: "warmup", type: "number", default: 60, description: "seconds of load before the growth fit and CPU window start (the profile sets it)" },
  { name: "idle", type: "number", default: 10, description: "seconds the idle sample window lasts after boot" },
  { name: "sample-interval", type: "number", default: 10, description: "seconds between samples under load" },
  { name: "contract", type: "string", default: "returner", choices: Object.keys(CONTRACT_FILES), description: "contract the load runs" },
  { name: "cpus", type: "number", description: "set the nodes' cpus config (size of the contract worker pool)" },
  { name: "worker-semi-space", type: "number", description: "set the nodes' worker_semi_space config (MB)" },
  { name: "node-config", type: "string", description: "JSON merged into every node's config.json before it starts, e.g. '{\"releaseTailSeconds\":30}' (recorded in the results)" },
  { name: "reps", type: "number", default: 1, description: "repeat the whole run on fresh networks (more reps give the compare tool a spread)" },
  { name: "fail-on-uncommitted", type: "boolean", default: false, description: "exit 1 if any transaction did not commit (always reported either way)" },
  { name: "max-growth-mb-per-10k", type: "number", description: "fail (exit 1) if any role's anonymous memory grows faster than this, MB per 10k tx" },
  ...COMMON_FLAGS,
];

const HELP = `Memory is per process, averaged over the processes of a role (all nodes). Anon is
RssAnon from /proc, the part a leak grows. Growth is the least squares slope of
the mean anon of a role against committed transactions, from the end of warm-up.
CPU per tx is the CPU time the role's processes used after warm-up, divided by
the transactions committed in that time.

Exit status: 0 whenever the tool ran and printed its report; 1 only if you pass
--max-growth-mb-per-10k (standard or full profile) and it is exceeded, or
--fail-on-uncommitted and a transaction did not commit; 2 if it could not run.

Example:
  npm run stress:memory -- --duration 180 --warmup 40 --max-growth-mb-per-10k 5 --out /tmp/mem.jsonl`;

interface Sample {
  elapsed: number;
  tx: number;
  rows: ProcRow[];
}

const fixed = (x: number | undefined, digits = 1) => (x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(digits));

async function oneRep(f: any, out: string, rep: number): Promise<{ failed: boolean; growthBreach: string[] }> {
  const loadBefore = loadNow();
  const tick = clockTicksPerSecond();
  let committed = 0;
  let bad = 0;
  const reasons = new Map<string, number>();
  const config: Record<string, unknown> = {};
  if (f.cpus) config.cpus = f.cpus;
  if (f.workerSemiSpace !== undefined) config.worker_semi_space = f.workerSemiSpace;
  if (f.nodeConfig) Object.assign(config, JSON.parse(f.nodeConfig));

  const result = await withNetwork(
    { nodeCount: f.nodes, basePort: f.basePort, readyTimeoutMs: 60000, config: Object.keys(config).length ? config : undefined },
    async (_h, nodes) => {
      const handles = () => nodes.map((n) => ({ index: n.index, pid: n.child.pid!, dataDir: n.dataDir }));

      // Idle: let the network settle, then a window to read its idle cost.
      await sleep(3000);
      const idleStart = sampleNetwork(handles());
      const idleT0 = Date.now();
      await sleep(f.idle * 1000);
      const idleEnd = sampleNetwork(handles());
      const idleSecs = (Date.now() - idleT0) / 1000;
      const idleCpu = cpuSecondsByRole(idleStart, idleEnd, tick);

      const workload = await setupWorkload(nodes, f.contract, f.clients);
      await sleep(2000);

      // Sustained load, lazily signed, entering at nodes in turn.
      const samples: Sample[] = [];
      const t0 = Date.now();
      const stopAt = t0 + f.duration * 1000;
      const snap = () => samples.push({ elapsed: (Date.now() - t0) / 1000, tx: committed, rows: sampleNetwork(handles()) });
      const interval = setInterval(snap, f.sampleInterval * 1000);
      let warmIndex = -1;
      const warmTimer = setTimeout(() => {
        snap();
        warmIndex = samples.length - 1;
      }, f.warmup * 1000);
      const latencies: number[] = [];
      await Promise.all(
        workload.identities.map(async (_id, client) => {
          const entry = nodes[client % nodes.length].baseUrl;
          for (let i = 0; Date.now() < stopAt; i++) {
            const t = await timedSubmit(entry, hotTransaction(workload, client, `m${rep}c${client}i${i}`));
            if (t.committed) {
              committed++;
              if (warmIndex >= 0) latencies.push(t.ms);
            } else {
              bad++;
              reasons.set(t.reason || "unknown", (reasons.get(t.reason || "unknown") || 0) + 1);
            }
          }
        })
      );
      clearInterval(interval);
      clearTimeout(warmTimer);
      snap();
      return { idleEnd, idleCpu, idleSecs, samples, warmIndex, latencies };
    }
  );

  const { samples, idleEnd, idleCpu, idleSecs } = result;
  const warm = result.warmIndex >= 0 ? samples[result.warmIndex] : samples[0];
  const end = samples[samples.length - 1];
  const fitSet = samples.filter((s) => s.elapsed >= warm.elapsed);

  // Per role: mean anon per process at each fit sample against tx / 10k.
  const growth: Record<string, number> = {};
  const growthRss: Record<string, number> = {};
  const growthHalf: Record<string, number> = {};
  const fits: Record<string, ReturnType<typeof slopeFit>> = {};
  const postWarmSeconds = end.elapsed - warm.elapsed;
  const level = growthLevel(f.profile, postWarmSeconds, fitSet.length);
  for (const role of ROLES) {
    const xs: number[] = [];
    const anon: number[] = [];
    const rss: number[] = [];
    for (const s of fitSet) {
      const m = memoryByRole(s.rows)[role];
      if (!m) continue;
      xs.push(s.tx / 10000);
      anon.push(m.anonMb);
      rss.push(m.rssMb);
    }
    const fit = slopeFit(xs, anon);
    if (Number.isFinite(fit.slope)) {
      fits[role] = fit;
      growth[role] = +fit.slope.toFixed(3);
      if (Number.isFinite(fit.halfWidth)) growthHalf[role] = +fit.halfWidth.toFixed(3);
      growthRss[role] = +slopeFit(xs, rss).slope.toFixed(3);
    }
  }

  const txWindow = end.tx - warm.tx;
  const cpuSecs = cpuSecondsByRole(warm.rows, end.rows, tick);
  const cpuMsPerTx: Record<string, number> = {};
  if (txWindow > 0) for (const role of ROLES) if (cpuSecs[role] !== undefined) cpuMsPerTx[role] = +((cpuSecs[role]! * 1000) / txWindow).toFixed(3);
  const tps = end.elapsed > warm.elapsed ? txWindow / (end.elapsed - warm.elapsed) : NaN;

  const round = (by: Partial<Record<Role, { rssMb: number; anonMb: number; count: number }>>) =>
    Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v!.count, rssMb: +v!.rssMb.toFixed(1), anonMb: +v!.anonMb.toFixed(1) }]));
  const phases = { idle: round(memoryByRole(idleEnd)), afterWarmup: round(memoryByRole(warm.rows)), loadEnd: round(memoryByRole(end.rows)) };
  const loadRss = Object.fromEntries(Object.entries(memoryByRole(end.rows)).map(([k, v]) => [k, +v!.rssMb.toFixed(1)]));

  const record = {
    tool: "memory",
    kind: "run",
    ts: new Date().toISOString(),
    label: f.label,
    nodeConfig: f.nodeConfig,
    profile: f.profile,
    growthVerdict: level,
    group: `nodes=${f.nodes} clients=${f.clients} contract=${f.contract} cpus=${f.cpus ?? "default"} semi=${f.workerSemiSpace ?? "default"}`,
    ...environment(),
    rep,
    nodes: f.nodes,
    clients: f.clients,
    contract: f.contract,
    durationSec: f.duration,
    warmupSec: f.warmup,
    committed,
    failedTx: bad,
    failureReasons: Object.fromEntries(reasons),
    committedAfterWarmup: txWindow,
    tps: Number.isFinite(tps) ? +tps.toFixed(2) : undefined,
    p50Ms: result.latencies.length ? +percentile(result.latencies, 50).toFixed(1) : undefined,
    p99Ms: result.latencies.length ? +percentile(result.latencies, 99).toFixed(1) : undefined,
    phases,
    rssMb: loadRss,
    growthMbPer10k: growth,
    growthRssMbPer10k: growthRss,
    growthHalfWidthMbPer10k: growthHalf,
    postWarmupSec: +postWarmSeconds.toFixed(1),
    cpuMsPerTx,
    idleCpuMsPerSec: Object.fromEntries(Object.entries(idleCpu).map(([k, v]) => [k, +((v! * 1000) / idleSecs).toFixed(2)])),
    samples: samples.map((s) => ({
      elapsed: +s.elapsed.toFixed(1),
      tx: s.tx,
      roles: round(memoryByRole(s.rows)),
    })),
    loadBefore,
    loadAfter: loadNow(),
  };
  appendRecord(out, record);

  console.log(`  rep ${rep + 1}/${f.reps}: ${committed} tx committed, ${bad} not, ${fixed(tps)} tx/s after warm-up`);
  console.log("  role      procs   idle rss/anon   warm rss/anon   end rss/anon   anon change warm->end   cpu ms/tx");
  for (const role of ROLES) {
    const idle = phases.idle[role];
    if (!idle) continue;
    const w = phases.afterWarmup[role];
    const e = phases.loadEnd[role];
    const cell = (x?: { rssMb: number; anonMb: number }) => (x ? `${fixed(x.rssMb, 0)}/${fixed(x.anonMb, 0)}`.padStart(13) : "-".padStart(13));
    console.log(
      `  ${role.padEnd(9)} ${String(e?.n ?? idle.n).padStart(5)}  ${cell(idle)}  ${cell(w)}  ${cell(e)}  ${(w && e ? `${e.anonMb - w.anonMb >= 0 ? "+" : ""}${fixed(e.anonMb - w.anonMb, 1)} MB` : "-").padStart(21)}  ${fixed(cpuMsPerTx[role], 2).padStart(9)}`
    );
  }
  for (const [reason, n] of reasons) console.log(`    ${n} x ${reason}`);

  console.log(`  resolving power (${f.profile} profile): ${postWarmSeconds.toFixed(0)} s and ${txWindow} tx after warm-up, ${fitSet.length} samples`);
  if (level === "none") {
    console.log("  growth: NO VERDICT. A quick run shows where memory plateaus, not whether it grows slowly; use --profile standard or full.");
  } else {
    for (const role of ROLES) if (fits[role]) console.log("  growth " + describeGrowth(role, fits[role], level, f.maxGrowthMbPer10k));
    if (level === "provisional") console.log("  these growth figures are PROVISIONAL: a growth verdict needs the full profile (long enough after warm-up, enough samples)");
  }
  const breach: string[] = [];
  if (f.maxGrowthMbPer10k !== undefined && level !== "none") {
    for (const [role, g] of Object.entries(growth)) if (g > f.maxGrowthMbPer10k) breach.push(`${role} ${g} MB/10k tx`);
  }
  return { failed: bad > 0, growthBreach: breach };
}

runTool("stress:memory", "Memory by role, CPU per transaction and growth per 10k transactions on a harness network.", SPECS, HELP, async (f) => {
  if (f.warmup >= f.duration) {
    console.error("stress:memory: --warmup must be shorter than --duration");
    return 2;
  }
  if (f.maxGrowthMbPer10k !== undefined && f.profile === "quick") {
    console.error("stress:memory: --max-growth-mb-per-10k needs --profile standard or full; a quick run cannot judge growth");
    return 2;
  }
  const out: string = f.out || defaultOut("memory");
  console.log(`memory: ${f.nodes} nodes, ${f.clients} clients, ${f.duration}s load (${f.warmup}s warm-up), ${f.reps} rep(s), results in ${out}`);
  await gate(f);
  let status = 0;
  for (let rep = 0; rep < f.reps; rep++) {
    const r = await oneRep(f, out, rep);
    if (r.failed) {
      if (f.failOnUncommitted) {
        console.error("FAIL: some transactions did not commit");
        status = 1;
      } else console.log("note: some transactions did not commit");
    }
    if (r.growthBreach.length) {
      console.error(`FAIL: growth above --max-growth-mb-per-10k ${f.maxGrowthMbPer10k}: ${r.growthBreach.join(", ")}`);
      status = 1;
    }
  }
  console.log(`results written to ${out}`);
  return status;
}, MEMORY_PROFILES, planMemory);
