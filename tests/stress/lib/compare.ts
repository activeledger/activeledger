/**
 * Compares two result sets, a baseline and a candidate, by their spread.
 *
 * Absolute numbers depend on the machine, so nothing here has a built-in
 * limit. A candidate is "worse" on a metric when its median is on the bad
 * side of the baseline's median by more than the allowance:
 *
 *   allowance = max(IQR of baseline, IQR of candidate,
 *                   tolerance % of the baseline median,
 *                   a small absolute floor for the metric)
 *
 * so a difference inside the run-to-run noise of either side is "same", and
 * so is one too small to matter. But "same" is only a finding if the runs
 * could have shown a difference of the size the user cares about (--claim-pct,
 * default 5%): when the allowance is coarser than that, or a side has fewer
 * than 3 runs, the answer is "inconclusive", not "no regression". Cold-start pass/fail runs are compared as
 * failure rates with Fisher's exact test instead.
 */

import { BaseRecord } from "./results";
import { fisherExact, minDetectableRateIncrease, spread, summarise, Summary, wilson } from "./stats";

export type Better = "higher" | "lower";

export interface Metric {
  name: string;
  value: number;
  better: Better;
  unit: string;
  /** differences smaller than this never count, whatever the spread */
  minAbs: number;
  /** false for metrics near zero (growth), where a percentage of the baseline means nothing */
  relative: boolean;
}

export type Verdict = "worse" | "better" | "same" | "inconclusive";

export interface MetricComparison {
  tool: string;
  group: string;
  metric: string;
  unit: string;
  better: Better;
  base: Summary;
  cand: Summary;
  /** candidate median minus baseline median */
  delta: number;
  deltaPct: number;
  allowance: number;
  verdict: Verdict;
}

export interface RateComparison {
  tool: string;
  group: string;
  base: { failures: number; runs: number; rate: number; low: number; high: number };
  cand: { failures: number; runs: number; rate: number; low: number; high: number };
  /** two-sided Fisher exact p-value */
  p: number;
  verdict: Verdict;
}

export interface CompareOptions {
  /** relative allowance, percent of the baseline median (default 5) */
  tolerancePct?: number;
  /** significance for failure rates (default 0.05) */
  alpha?: number;
  /** the relative difference, percent, the runs must be able to rule out before "same" is believed (default 5) */
  claimPct?: number;
  /** the same for failure rates, in percentage points (default 10) */
  claimPoints?: number;
}

export interface CompareReport {
  metrics: MetricComparison[];
  rates: RateComparison[];
  notes: string[];
  /** true if the candidate is worse on anything */
  worse: boolean;
  /** true if something is "same" only because the runs were too coarse to say */
  inconclusive: boolean;
}

const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

/** The numbers a run record contributes to a comparison. */
export function extractMetrics(record: BaseRecord): Metric[] {
  const out: Metric[] = [];
  const add = (name: string, value: unknown, better: Better, unit: string, minAbs: number, relative = true) => {
    const v = num(value);
    if (v !== undefined) out.push({ name, value: v, better, unit, minAbs, relative });
  };
  if (record.tool === "throughput") {
    add("tx/s", record.tps, "higher", "tx/s", 0);
    add("p50", record.p50Ms, "lower", "ms", 1);
    add("p99", record.p99Ms, "lower", "ms", 2);
  } else if (record.tool === "memory") {
    for (const [name, key, unit, minAbs] of [
      ["rss", "rssMb", "MB", 2],
      ["growth", "growthMbPer10k", "MB/10k tx", 0.5],
      ["cpu", "cpuMsPerTx", "ms/tx", 0.2],
    ] as const) {
      const byRole = record[key];
      if (byRole && typeof byRole === "object") {
        for (const [role, value] of Object.entries(byRole as Record<string, unknown>)) {
          // a quick run says nothing about growth, so it contributes none
          if (key === "growthMbPer10k" && record.growthVerdict === "none") continue;
          add(`${name}.${role}`, value, "lower", unit, minAbs, key !== "growthMbPer10k");
        }
      }
    }
    add("tx/s", record.tps, "higher", "tx/s", 0);
  }
  return out;
}

export function compareSamples(
  base: number[],
  cand: number[],
  better: Better,
  minAbs = 0,
  tolerancePct = 5,
  claimPct?: number,
  relative = true
): Pick<MetricComparison, "base" | "cand" | "delta" | "deltaPct" | "allowance" | "verdict"> {
  const b = summarise(base);
  const c = summarise(cand);
  const delta = c.median - b.median;
  const allowance = Math.max(spread(base), spread(cand), (tolerancePct / 100) * Math.abs(b.median), minAbs);
  const bad = better === "higher" ? -delta : delta;
  let verdict: Verdict = bad > allowance ? "worse" : -bad > allowance ? "better" : "same";
  if (verdict === "same") {
    const coarse = relative && claimPct !== undefined && b.median !== 0 && (100 * Math.max(spread(base), spread(cand), (tolerancePct / 100) * Math.abs(b.median))) / Math.abs(b.median) > claimPct + 1e-9;
    if (coarse || b.n < 3 || c.n < 3) verdict = "inconclusive";
  }
  return { base: b, cand: c, delta, deltaPct: b.median ? (100 * delta) / Math.abs(b.median) : NaN, allowance, verdict };
}

const runsOf = (records: BaseRecord[]) => records.filter((r) => r.kind === "run");

function groupKey(r: BaseRecord): string {
  return `${r.tool} | ${r.group}`;
}

function failedRun(r: BaseRecord): boolean {
  return r.tool === "cold-start" ? r.pass === false : (num(r.failedTx) || 0) > 0;
}

export function compareRecords(baseAll: BaseRecord[], candAll: BaseRecord[], options: CompareOptions = {}): CompareReport {
  const tolerancePct = options.tolerancePct ?? 5;
  const alpha = options.alpha ?? 0.05;
  const claimPct = options.claimPct ?? 5;
  const claimPoints = options.claimPoints ?? 10;
  const base = runsOf(baseAll);
  const cand = runsOf(candAll);
  const report: CompareReport = { metrics: [], rates: [], notes: [], worse: false, inconclusive: false };

  const baseGroups = new Set(base.map(groupKey));
  const candGroups = new Set(cand.map(groupKey));
  for (const g of baseGroups) if (!candGroups.has(g)) report.notes.push(`only in baseline, not compared: ${g}`);
  for (const g of candGroups) if (!baseGroups.has(g)) report.notes.push(`only in candidate, not compared: ${g}`);
  const shared = [...baseGroups].filter((g) => candGroups.has(g));
  if (!shared.length) {
    report.notes.push("no run group is present in both files: nothing to compare (same tool and same settings are needed)");
  }

  for (const g of shared) {
    const b = base.filter((r) => groupKey(r) === g);
    const c = cand.filter((r) => groupKey(r) === g);
    const tool = b[0].tool;
    const group = b[0].group;

    // Runs that did not verify (an uncommitted transaction, a node that
    // lagged) are failures of their own, apart from any timing.
    if (tool !== "cold-start") {
      const bf = b.filter(failedRun).length;
      const cf = c.filter(failedRun).length;
      if (cf > 0 && bf === 0) {
        report.notes.push(`WORSE ${g}: ${cf} of ${c.length} candidate runs had uncommitted transactions, baseline had none`);
        report.worse = true;
      }
    }

    if (tool === "cold-start") {
      const bFail = b.filter(failedRun).length;
      const cFail = c.filter(failedRun).length;
      const p = fisherExact(cFail, c.length - cFail, bFail, b.length - bFail);
      const bw = wilson(bFail, b.length);
      const cw = wilson(cFail, c.length);
      const bRate = bFail / b.length;
      const cRate = cFail / c.length;
      let verdict: Verdict = p < alpha ? (cRate > bRate ? "worse" : cRate < bRate ? "better" : "same") : "same";
      // Could this many runs have shown a rise of the size claimed?
      if (verdict === "same" && minDetectableRateIncrease(bFail, b.length, alpha) > claimPoints / 100) verdict = "inconclusive";
      report.rates.push({
        tool,
        group,
        base: { failures: bFail, runs: b.length, rate: bRate, low: bw.low, high: bw.high },
        cand: { failures: cFail, runs: c.length, rate: cRate, low: cw.low, high: cw.high },
        p,
        verdict,
      });
      if (verdict === "worse") report.worse = true;
      if (verdict === "inconclusive") report.inconclusive = true;
      continue;
    }

    const series = (records: BaseRecord[]) => {
      const by = new Map<string, { metric: Metric; values: number[] }>();
      for (const r of records) {
        for (const m of extractMetrics(r)) {
          const entry = by.get(m.name) || { metric: m, values: [] };
          entry.values.push(m.value);
          by.set(m.name, entry);
        }
      }
      return by;
    };
    const bs = series(b);
    const cs = series(c);
    for (const [name, entry] of bs) {
      const other = cs.get(name);
      if (!other) continue;
      const cmp = compareSamples(entry.values, other.values, entry.metric.better, entry.metric.minAbs, tolerancePct, claimPct, entry.metric.relative);
      report.metrics.push({
        tool,
        group,
        metric: name,
        unit: entry.metric.unit,
        better: entry.metric.better,
        ...cmp,
      });
      if (cmp.verdict === "worse") report.worse = true;
      if (cmp.verdict === "inconclusive") report.inconclusive = true;
    }
    if (b.length < 3 || c.length < 3) {
      report.notes.push(`thin data for ${g}: ${b.length} baseline and ${c.length} candidate runs; the spread is a poor guide below 3 each`);
    }
  }

  const profiles = new Set([...base, ...cand].map((r) => r.profile).filter(Boolean));
  if (profiles.size > 1) report.notes.push(`runs come from different profiles (${[...profiles].join(", ")}): the coarser one limits the resolving power`);
  const loaded = [...base, ...cand].filter((r) => (r.loadBefore?.load1 ?? 0) > 2 || (r.loadAfter?.load1 ?? 0) > 4);
  if (loaded.length) {
    report.notes.push(`${loaded.length} of ${base.length + cand.length} runs ran with a busy machine (1-minute load above 2 before, or 4 after): treat the result with care`);
  }
  return report;
}

const fmt = (x: number, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : "n/a");

/** The words the report uses for a verdict. */
export function wording(v: Verdict): string {
  return { same: "within spread", worse: "WORSE beyond spread", better: "better beyond spread", inconclusive: "INCONCLUSIVE (too few or too noisy runs to say)" }[v];
}

export function formatReport(report: CompareReport): string {
  const lines: string[] = [];
  let last = "";
  for (const m of report.metrics) {
    const head = `${m.tool} | ${m.group}`;
    if (head !== last) {
      lines.push("", head);
      last = head;
    }
    lines.push(
      `  ${m.metric.padEnd(16)} base ${fmt(m.base.median).padStart(9)} (iqr ${fmt(m.base.iqr)}, n=${m.base.n})` +
        `  cand ${fmt(m.cand.median).padStart(9)} (iqr ${fmt(m.cand.iqr)}, n=${m.cand.n})` +
        `  ${(m.delta >= 0 ? "+" : "") + fmt(m.delta)} ${m.unit} (${fmt(m.deltaPct)}%)` +
        `  allowance ${fmt(m.allowance)}  ${wording(m.verdict)}`
    );
  }
  for (const r of report.rates) {
    lines.push(
      "",
      `${r.tool} | ${r.group}`,
      `  failure rate     base ${r.base.failures}/${r.base.runs} (${fmt(100 * r.base.rate)}%, 95% CI ${fmt(100 * r.base.low)}-${fmt(100 * r.base.high)}%)` +
        `  cand ${r.cand.failures}/${r.cand.runs} (${fmt(100 * r.cand.rate)}%, 95% CI ${fmt(100 * r.cand.low)}-${fmt(100 * r.cand.high)}%)` +
        `  Fisher p=${fmt(r.p, 3)}  ${wording(r.verdict)}`
    );
  }
  if (report.notes.length) lines.push("", ...report.notes.map((n) => `note: ${n}`));
  lines.push(
    "",
    report.worse
      ? "RESULT: candidate is worse than baseline beyond the measured spread"
      : report.inconclusive
        ? "RESULT: inconclusive, rerun with a longer profile: the runs are too few or too noisy to rule out a difference of the size claimed (see --claim-pct / --claim-points), so no regression is declared"
        : "RESULT: candidate is within the spread of baseline, and the runs were fine enough to say so"
  );
  return lines.join("\n");
}
