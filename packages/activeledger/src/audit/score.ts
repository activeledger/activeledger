import { Band, FileReport, Finding, Report, Severity, SEVERITIES, WEIGHT } from "./types";

export const band = (score: number): Band => (score >= 70 ? "critical" : score >= 40 ? "high" : score >= 10 ? "medium" : "low");

/** Points for one file: each finding by severity, capped at 100 */
export const fileScore = (findings: Finding[]): number => Math.min(100, findings.reduce((n, f) => n + WEIGHT[f.severity], 0));

/** The blend: the worst file counts most so it cannot hide in a clean folder, the average keeps a spread of medium files visible */
export const overallScore = (files: FileReport[]): { score: number; band: Band; worst: number; average: number } => {
  if (!files.length) return { score: 0, band: "low", worst: 0, average: 0 };
  const worst = Math.max(...files.map((f) => f.score));
  const average = Math.round(files.reduce((n, f) => n + f.score, 0) / files.length);
  const score = Math.round(0.6 * worst + 0.4 * average);
  return { score, band: band(score), worst, average };
};

export const countBySeverity = (files: FileReport[]): Report["counts"] => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
  for (const f of files) for (const x of f.findings) counts[x.severity]++;
  return counts;
};

export const atLeast = (severity: Severity, floor: Severity): boolean => SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(floor);
