export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
export const WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1 };

export type Group = "security" | "contract" | "best-practice" | "duplicate" | "hygiene" | "dependency";

export interface Finding {
  file: string;
  /** 1-based; 0 when the finding is not on one line */
  line: number;
  severity: Severity;
  group: Group;
  rule: string;
  message: string;
  fix: string;
}

export interface FileReport {
  file: string;
  findings: Finding[];
  score: number;
  band: Band;
}

export type Band = "low" | "medium" | "high" | "critical";

export interface Duplicate {
  a: { file: string; from: number; to: number };
  b: { file: string; from: number; to: number };
  lines: number;
}

export interface Report {
  files: FileReport[];
  duplicates: Duplicate[];
  counts: Record<Severity, number>;
  overall: { score: number; band: Band; worst: number; average: number };
  /** Things that could not be checked (offline, registry unreachable, unreadable file) */
  notes: string[];
}
