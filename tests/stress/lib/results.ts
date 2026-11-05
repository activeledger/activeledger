/**
 * JSONL results: one JSON object per line, appended as runs finish, so a
 * file survives a crash and two invocations can feed the same file (which is
 * how an interleaved A/B is collected).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { LoadAverages } from "./loadgate";

export type Tool = "throughput" | "cold-start" | "memory" | "realistic";

/** Fields every record carries. */
export interface BaseRecord {
  tool: Tool;
  /** "run" is one measured run; "summary" is the tool's roll-up at the end */
  kind: "run" | "summary";
  ts: string;
  /** Free text the user gave with --label, e.g. "baseline" or "candidate" */
  label?: string;
  /**
   * Runs are only compared with runs of the same group: the settings that
   * make two runs comparable, as a string (e.g. "nodes=4 clients=8 mode=hot").
   */
  group: string;
  /** Short git commit of the checkout the tool ran in, when there is one */
  commit?: string;
  loadBefore?: LoadAverages;
  loadAfter?: LoadAverages;
  [key: string]: unknown;
}

export function appendRecord(file: string, record: object): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

/** Parses JSONL text. Blank lines are skipped; a bad line names its line number. */
export function parseJsonl<T = BaseRecord>(text: string, source = "input"): T[] {
  const out: T[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Error(`${source}: line ${i + 1} is not valid JSON`);
    }
  });
  return out;
}

export function readRecords<T = BaseRecord>(file: string): T[] {
  return parseJsonl<T>(fs.readFileSync(file, "utf8"), file);
}

/** Default output file for a tool: ./stress-results/<tool>-<timestamp>.jsonl */
export function defaultOut(tool: Tool): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("stress-results", `${tool}-${stamp}.jsonl`);
}

/** What the machine and checkout looked like, stored with each run. */
export function environment(): { commit?: string; node: string; cpus: number; hostname: string } {
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", cwd: __dirname });
  return {
    commit: git.status === 0 ? git.stdout.trim() : undefined,
    node: process.version,
    cpus: os.cpus().length,
    hostname: os.hostname(),
  };
}
