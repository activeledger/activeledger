/**
 * Small statistics toolbox for the stress tools. Pure functions, no I/O, so
 * they are unit tested (tests/stress-lib.test.ts) against values computed
 * independently of this code.
 */

export function sum(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : NaN;
}

/**
 * The q-quantile (0 to 1) by linear interpolation between the closest ranks
 * (the "type 7" definition used by R, NumPy and Excel). Empty input gives NaN.
 */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The p-th percentile (0 to 100). */
export function percentile(xs: number[], p: number): number {
  return quantile(xs, p / 100);
}

export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

/** Interquartile range: third quartile minus first. */
export function iqr(xs: number[]): number {
  return quantile(xs, 0.75) - quantile(xs, 0.25);
}

export interface Summary {
  n: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  min: number;
  max: number;
}

export function summarise(xs: number[]): Summary {
  const clean = xs.filter((x) => Number.isFinite(x));
  return {
    n: clean.length,
    median: median(clean),
    q1: quantile(clean, 0.25),
    q3: quantile(clean, 0.75),
    iqr: iqr(clean),
    min: clean.length ? Math.min(...clean) : NaN,
    max: clean.length ? Math.max(...clean) : NaN,
  };
}

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion, k successes in n trials.
 * Unlike the plain normal interval it behaves at 0 and n and for small n,
 * which is where cold-start failure counts live. Returns proportions (0-1).
 */
export function wilson(k: number, n: number, z: number = Z95): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

function logFactorial(n: number): number {
  let total = 0;
  for (let i = 2; i <= n; i++) total += Math.log(i);
  return total;
}

/**
 * Two-sided Fisher exact test on the 2x2 table
 *
 *            col 1   col 2
 *   row 1      a       b
 *   row 2      c       d
 *
 * The p-value is the total probability, under fixed margins, of every table
 * as likely as or less likely than the observed one (the definition R and
 * SciPy use). Exact, so valid for the small counts a handful of cold-start
 * runs produces.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const rowOne = a + b;
  const colOne = a + c;
  const total = a + b + c + d;
  if (total === 0) return 1;
  const probability = (x: number): number =>
    Math.exp(
      logFactorial(rowOne) +
        logFactorial(total - rowOne) +
        logFactorial(colOne) +
        logFactorial(total - colOne) -
        logFactorial(total) -
        logFactorial(x) -
        logFactorial(rowOne - x) -
        logFactorial(colOne - x) -
        logFactorial(total - rowOne - colOne + x)
    );
  const observed = probability(a);
  let p = 0;
  const lo = Math.max(0, colOne - (total - rowOne));
  const hi = Math.min(rowOne, colOne);
  for (let x = lo; x <= hi; x++) {
    const px = probability(x);
    // Tolerance for the floating point noise that separates equal tables.
    if (px <= observed * (1 + 1e-9)) p += px;
  }
  return Math.min(1, p);
}

/**
 * Least squares slope of y on x. NaN with fewer than two points or no spread
 * in x. Used for memory growth: MB per 10k transactions.
 */
export function slope(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  return sxx === 0 ? NaN : sxy / sxx;
}

/** Formats a proportion as a percentage with one decimal. */
export function pct(x: number): string {
  return (100 * x).toFixed(1) + "%";
}

/**
 * Run-to-run spread of a small sample: the IQR from five values up, half the
 * range below that (a quartile of three or four numbers says very little).
 */
export function spread(xs: number[]): number {
  const clean = xs.filter((x) => Number.isFinite(x));
  if (clean.length < 2) return 0;
  if (clean.length >= 5) return iqr(clean);
  return (Math.max(...clean) - Math.min(...clean)) / 2;
}

const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** Two-sided 95% critical value of Student's t (table to 30 degrees of freedom, then close approximations). */
export function tCritical95(df: number): number {
  if (df < 1) return Infinity;
  if (df <= 30) return T95[df - 1];
  return df <= 60 ? 2.0 : 1.96;
}

export interface SlopeFit {
  n: number;
  slope: number;
  /** half-width of the 95% interval of the slope; NaN with fewer than 3 points */
  halfWidth: number;
}

/**
 * Least squares slope with the 95% interval from its standard error. The
 * interval assumes independent samples; consecutive memory samples are not,
 * so treat it as optimistic.
 */
export function slopeFit(xs: number[], ys: number[]): SlopeFit {
  const n = Math.min(xs.length, ys.length);
  const b = slope(xs, ys);
  if (n < 3 || !Number.isFinite(b)) return { n, slope: b, halfWidth: NaN };
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxx = 0;
  let sse = 0;
  for (let i = 0; i < n; i++) sxx += (xs[i] - mx) ** 2;
  for (let i = 0; i < n; i++) sse += (ys[i] - my - b * (xs[i] - mx)) ** 2;
  return { n, slope: b, halfWidth: tCritical95(n - 2) * Math.sqrt(sse / (n - 2) / sxx) };
}

/**
 * The smallest increase in a failure rate that a second sample of the same
 * size could be told apart from `failures` out of `runs` by Fisher's exact
 * test at `alpha`, in rate (0-1). Infinity if no increase could be.
 */
export function minDetectableRateIncrease(failures: number, runs: number, alpha = 0.05): number {
  if (runs <= 0) return Infinity;
  for (let c = failures + 1; c <= runs; c++) {
    if (fisherExact(c, runs - c, failures, runs - failures) < alpha) return (c - failures) / runs;
  }
  return Infinity;
}
