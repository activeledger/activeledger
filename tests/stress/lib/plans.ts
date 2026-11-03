/**
 * Profiles (quick, standard, full) and the --dry-run plans for the three
 * network tools. A plan is pure text computed from the flags: how many
 * runs, how long, and what the profile can and cannot resolve. Times are
 * ESTIMATES from the constants below, not measurements.
 */

import { Flags, ProfileName } from "./cli";
import { GROWTH_VERDICT_MIN_SAMPLES, GROWTH_VERDICT_MIN_SECONDS, growthLevel, rateResolution } from "./resolution";

/** Assumed cost of booting, bootstrapping and tearing down one network, seconds. */
export const NETWORK_OVERHEAD_SECONDS = 25;
/** Assumed cost of one cold-start run: boot with stagger, checks, teardown, seconds. */
export const COLD_RUN_SECONDS = 10;
/** Assumed fixed cost of one memory run around its load phase (boot, settle, setup, teardown), seconds. */
export const MEMORY_OVERHEAD_SECONDS = 45;

export const THROUGHPUT_PROFILES: Record<ProfileName, Record<string, unknown>> = {
  quick: { nodes: "1,4", duration: 60, warmup: 20, reps: 3, stopEarly: false },
  standard: { nodes: "1,4", duration: 150, warmup: 30, reps: 3, stopEarly: true },
  full: { nodes: "1,4", duration: 150, warmup: 30, reps: 5, stopEarly: false },
};

export const COLD_PROFILES: Record<ProfileName, Record<string, unknown>> = {
  quick: { runs: 20 },
  standard: { runs: 100 },
  full: { runs: 400 },
};

export const MEMORY_PROFILES: Record<ProfileName, Record<string, unknown>> = {
  quick: { duration: 240, warmup: 60 },
  standard: { duration: 780, warmup: 120 },
  full: { duration: 1500, warmup: 300 },
};

/** "75 s", "12 min", "1 h 05 min" */
export function human(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return `${h} h ${String(Math.round((seconds - h * 3600) / 60)).padStart(2, "0")} min`;
}

export function parseNodeList(text: string): number[] {
  const list = String(text)
    .split(",")
    .map((x) => Number(x.trim()));
  if (!list.length || list.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`--nodes must be a list of node counts such as 4 or 1,4,8, got "${text}"`);
  return list;
}

export function planThroughput(f: Flags): string {
  const nodes = parseNodeList(f.nodes);
  const measured = f.duration - f.warmup;
  const perRun = NETWORK_OVERHEAD_SECONDS + f.duration;
  const rounds = f.reps;
  const total = rounds * nodes.length * perRun;
  const earliest = f.stopEarly ? Math.min(2, rounds) * nodes.length * perRun : total;
  return [
    `stress:throughput plan, ${f.profile} profile (dry run: nothing is started)`,
    `  network sizes: ${nodes.join(", ")} nodes; ${f.clients} clients; mode ${f.mode}; contract ${f.mode === "unique" ? "onboard" : f.contract}`,
    `  rounds: ${rounds}, each round runs every size in turn on a fresh network (interleaved), ${rounds * nodes.length} runs in all`,
    `  each run: ${f.duration} s of load, the first ${f.warmup} s excluded, so ${measured} s measured`,
    f.stopEarly
      ? `  early stop: after round 2 the tool stops if the spread is already tight (resolving power within ${f.targetPct}%), so between ${rounds >= 2 ? 2 : rounds} and ${rounds} rounds`
      : "  early stop: off, every round runs",
    `  estimated wall-clock: ${f.stopEarly ? `${human(earliest)} to ` : ""}${human(total)} (estimate from the plan, assuming ${NETWORK_OVERHEAD_SECONDS} s to boot and tear down a network; not measured)`,
    "  can resolve: a change in tx/s or p99 larger than the run-to-run spread of the runs, which the tool measures and prints at the end",
    rounds < 3
      ? "  cannot resolve: with fewer than 3 runs per size the spread itself is unreliable"
      : `  cannot resolve: changes smaller than that spread; short runs spread about +/-10% run to run, so a few percent needs the standard or full profile (${rounds} runs per size here)`,
  ].join("\n");
}

export function planColdStart(f: Flags): string {
  const total = f.runs * COLD_RUN_SECONDS;
  const assumed = Math.max(1, Math.round(0.1 * f.runs));
  const r = rateResolution(assumed, f.runs);
  const point = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)} points` : "any amount");
  return [
    `stress:cold-start plan, ${f.profile} profile (dry run: nothing is started)`,
    `  runs: ${f.runs} fresh ${f.nodes}-node networks, stagger 0-${f.maxStaggerMs} ms, extra ${f.extraDelayMs} ms on one node with probability ${f.extraProbability}`,
    `  estimated wall-clock: ${human(total)} (estimate from the plan, assuming ${COLD_RUN_SECONDS} s per run plus the load gate once; not measured)`,
    `  can resolve: one failure here stands for ${(100 / f.runs).toFixed(1)}%; at a 10% failure rate the 95% interval is ${(100 * r.low).toFixed(0)}% to ${(100 * r.high).toFixed(0)}%`,
    `  cannot resolve: a second set of ${f.runs} runs could be told apart from a 10% rate only if its rate were about ${point(r.detectableIncrease)} higher; a 2% failure needs hundreds of runs`,
  ].join("\n");
}

export function planMemory(f: Flags): string {
  const post = f.duration - f.warmup;
  const samples = Math.floor(post / f.sampleInterval) + 1;
  const level = growthLevel(f.profile, post, samples);
  const total = f.reps * (f.duration + f.idle + MEMORY_OVERHEAD_SECONDS);
  const verdict =
    level === "none"
      ? "memory plateau only: no growth verdict (a quick run is too short to tell slow growth from settling)"
      : level === "provisional"
        ? `a provisional growth estimate with its uncertainty (a verdict needs a full profile: at least ${GROWTH_VERDICT_MIN_SECONDS} s after warm-up and ${GROWTH_VERDICT_MIN_SAMPLES} samples)`
        : "a growth verdict per role (estimate, 95% interval, and a pass or fail against --max-growth-mb-per-10k)";
  return [
    `stress:memory plan, ${f.profile} profile (dry run: nothing is started)`,
    `  ${f.reps} run(s) of ${f.nodes} nodes, ${f.clients} clients: ${f.idle} s idle window, then ${f.duration} s of load of which ${f.warmup} s is warm-up (${post} s, ${samples} samples, after it)`,
    `  estimated wall-clock: ${human(total)} (estimate from the plan, assuming ${MEMORY_OVERHEAD_SECONDS} s of boot and teardown; not measured)`,
    `  can resolve: ${verdict}`,
    level === "verdict" ? "  cannot resolve: growth too slow to show in the transactions sent during the run" : "  cannot resolve: slow growth, which needs well past a 5-minute plateau",
  ].join("\n");
}
