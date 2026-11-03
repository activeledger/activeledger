/**
 * Resolving power: what a set of runs could and could not have shown. Each
 * tool prints this at the end so a short run is not read as proof of
 * something it cannot show. Pure functions, unit tested.
 */

import { minDetectableRateIncrease, SlopeFit, spread, summarise, wilson } from "./stats";

export interface ThroughputResolution {
  n: number;
  median: number;
  /** run-to-run spread as a percent of the median */
  spreadPct: number;
  /** the smallest relative change an A/B with this many runs per side could call, percent */
  detectablePct: number;
}

/**
 * The compare tool treats a difference as real only when it exceeds the
 * larger of the spread and the tolerance (5% by default), so that is also the
 * smallest difference a set of runs like this one can resolve.
 */
export function valueResolution(values: number[], tolerancePct = 5): ThroughputResolution {
  const s = summarise(values);
  const spreadPct = s.median ? (100 * spread(values)) / Math.abs(s.median) : NaN;
  return { n: s.n, median: s.median, spreadPct, detectablePct: Number.isFinite(spreadPct) ? Math.max(spreadPct, tolerancePct) : Infinity };
}

export interface RateResolution {
  runs: number;
  failures: number;
  rate: number;
  low: number;
  high: number;
  /** smallest rise in failure rate (0-1) a same-size second set could be told apart by */
  detectableIncrease: number;
  /** smallest rate (0-1) one failure in this many runs stands for */
  oneFailure: number;
}

export function rateResolution(failures: number, runs: number, alpha = 0.05): RateResolution {
  const w = wilson(failures, runs);
  return {
    runs,
    failures,
    rate: runs ? failures / runs : NaN,
    low: w.low,
    high: w.high,
    detectableIncrease: minDetectableRateIncrease(failures, runs, alpha),
    oneFailure: runs ? 1 / runs : NaN,
  };
}

/** A growth verdict needs this much load after warm-up and this many samples. */
export const GROWTH_VERDICT_MIN_SECONDS = 900;
export const GROWTH_VERDICT_MIN_SAMPLES = 20;

export type GrowthLevel = "none" | "provisional" | "verdict";

/**
 * How much a memory run may say about growth. The profile sets the intent
 * (quick: plateau only; standard: provisional; full: a verdict) and the data
 * can only lower it: a "full" run that was cut short, or sampled too rarely,
 * is provisional.
 */
export function growthLevel(profile: string, postWarmupSeconds: number, samples: number): GrowthLevel {
  if (profile === "quick") return "none";
  if (profile === "full" && postWarmupSeconds >= GROWTH_VERDICT_MIN_SECONDS && samples >= GROWTH_VERDICT_MIN_SAMPLES) return "verdict";
  return "provisional";
}

export function describeGrowth(role: string, fit: SlopeFit, level: GrowthLevel, threshold?: number): string {
  if (level === "none") return `${role}: no growth verdict from a quick run (plateau only)`;
  if (!Number.isFinite(fit.halfWidth)) return `${role}: growth cannot be estimated (only ${fit.n} samples after warm-up)`;
  const text = `${role}: ${fit.slope.toFixed(2)} +/- ${fit.halfWidth.toFixed(2)} MB per 10k tx (95%, ${fit.n} samples)`;
  const lo = fit.slope - fit.halfWidth;
  const hi = fit.slope + fit.halfWidth;
  const kind = level === "verdict" ? "" : " PROVISIONAL";
  if (threshold === undefined) return text + kind;
  if (hi < threshold) return `${text}: below ${threshold}${kind}`;
  if (lo > threshold) return `${text}: ABOVE ${threshold}${kind}`;
  return `${text}: straddles ${threshold}, cannot say${kind}`;
}
