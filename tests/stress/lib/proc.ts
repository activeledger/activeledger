/**
 * Per-process sampling from /proc (Linux only) for a harness network.
 *
 * Processes are found by walking the process tree under each node's main
 * process, and told apart by role from their command lines, never by
 * hard-coded pids:
 *
 *   host     the node's main process (the one the harness spawned)
 *   storage  the node's storage engine (its pid is also in the node's .PID)
 *   restore  the node's restore process, when one runs
 *   worker   a contract worker (packages/network/lib/process.js)
 *   other    anything else under the node
 *
 * The parsing and classification functions are pure and unit tested; only
 * sampleNetwork() touches /proc.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { mean, sum } from "./stats";

export type Role = "host" | "storage" | "restore" | "worker" | "other";
export const ROLES: Role[] = ["host", "storage", "restore", "worker", "other"];

export interface ProcRow {
  node: number;
  pid: number;
  role: Role;
  /** VmRSS, kB */
  rssKb: number;
  /** RssAnon (anonymous memory, what a leak grows), kB */
  anonKb: number;
  /** utime + stime, clock ticks since the process started */
  cpuTicks: number;
}

/** A value in kB from the text of /proc/<pid>/status, 0 when absent. */
export function statusKb(status: string, key: string): number {
  const match = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
  return match ? Number(match[1]) : 0;
}

/**
 * utime + stime and the parent pid from the text of /proc/<pid>/stat. The
 * command name is in parentheses and may itself contain spaces and
 * parentheses, so fields are counted from the last closing parenthesis.
 */
export function parseStat(stat: string): { ppid: number; cpuTicks: number } | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  // fields[0] is state (field 3 of the file), so ppid is fields[1],
  // utime fields[11] and stime fields[12]
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (![ppid, utime, stime].every(Number.isFinite)) return undefined;
  return { ppid, cpuTicks: utime + stime };
}

/** Decides a process's role from its argv (split /proc/<pid>/cmdline). */
export function classifyRole(argv: string[], isNodeMain: boolean, isStoragePid: boolean, isRestorePid = false): Role {
  if (isNodeMain) return "host";
  if (isStoragePid) return "storage";
  if (isRestorePid) return "restore";
  const script = argv.slice(1).join(" ");
  if (/network[\\/]+(lib[\\/]+)?process\.js/.test(script)) return "worker";
  if (/restore[\\/]+lib[\\/]+index\.js/.test(script)) return "restore";
  if (/storage[\\/]+lib[\\/]+(selfhost|index)\.js/.test(script) || /selfhost\.js/.test(script)) return "storage";
  return "other";
}

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

let clockTicks: number | undefined;
/** Clock ticks per second, normally 100. */
export function clockTicksPerSecond(): number {
  if (clockTicks === undefined) {
    const out = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout;
    clockTicks = Number(out) > 0 ? Number(out) : 100;
  }
  return clockTicks;
}

/** Every descendant of `root`, from one scan of /proc. */
export function descendantsOf(root: number): number[] {
  const children = new Map<number, number[]>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return [];
  }
  for (const entry of entries) {
    const stat = parseStat(read(`/proc/${entry}/stat`));
    if (!stat) continue;
    const list = children.get(stat.ppid) || [];
    list.push(Number(entry));
    children.set(stat.ppid, list);
  }
  const found: number[] = [];
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) || []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

/** The storage and restore pids a node recorded in its .PID file. */
function pidFile(dataDir: string): { storage: number; restore: number } {
  try {
    const data = JSON.parse(read(path.join(dataDir, ".PID")));
    return { storage: Number(data.activestorage) || -1, restore: Number(data.activerestore) || -1 };
  } catch {
    return { storage: -1, restore: -1 };
  }
}

function snapshot(pid: number, node: number, role: (argv: string[], pid: number) => Role): ProcRow | undefined {
  const status = read(`/proc/${pid}/status`);
  const stat = parseStat(read(`/proc/${pid}/stat`));
  if (!status || !stat) return undefined;
  const argv = read(`/proc/${pid}/cmdline`).split("\0");
  return {
    node,
    pid,
    role: role(argv, pid),
    rssKb: statusKb(status, "VmRSS"),
    anonKb: statusKb(status, "RssAnon"),
    cpuTicks: stat.cpuTicks,
  };
}

/**
 * One sample of every process of every node. `nodes` carries what the
 * harness knows: the main process pid and the data directory (for .PID).
 * Processes that exit mid-sample are skipped.
 */
export function sampleNetwork(nodes: { index: number; pid: number; dataDir: string }[]): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const node of nodes) {
    const known = pidFile(node.dataDir);
    const roleOf = (argv: string[], pid: number): Role =>
      classifyRole(argv, pid === node.pid, pid === known.storage, pid === known.restore);
    const main = snapshot(node.pid, node.index, roleOf);
    if (main) rows.push(main);
    for (const pid of descendantsOf(node.pid)) {
      const row = snapshot(pid, node.index, roleOf);
      if (row) rows.push(row);
    }
    // The storage engine is not always a child of the main process.
    if (known.storage > 0 && !rows.some((r) => r.node === node.index && r.pid === known.storage)) {
      const row = snapshot(known.storage, node.index, roleOf);
      if (row) rows.push(row);
    }
  }
  return rows;
}

export interface RoleMemory {
  /** how many processes of the role were sampled (across all nodes) */
  count: number;
  /** mean per process, MB */
  rssMb: number;
  anonMb: number;
  /** summed over every process of the role, MB */
  totalRssMb: number;
}

/** Memory per role: mean per process, and the total. */
export function memoryByRole(rows: ProcRow[]): Partial<Record<Role, RoleMemory>> {
  const out: Partial<Record<Role, RoleMemory>> = {};
  for (const role of ROLES) {
    const of = rows.filter((r) => r.role === role);
    if (!of.length) continue;
    out[role] = {
      count: of.length,
      rssMb: mean(of.map((r) => r.rssKb)) / 1024,
      anonMb: mean(of.map((r) => r.anonKb)) / 1024,
      totalRssMb: sum(of.map((r) => r.rssKb)) / 1024,
    };
  }
  return out;
}

/**
 * CPU seconds used per role between two samples. A process counts only if
 * it is in both samples (a worker that was replaced in between has no
 * meaningful delta), so the figure can under-count a churning pool but never
 * invents CPU.
 */
export function cpuSecondsByRole(before: ProcRow[], after: ProcRow[], ticksPerSecond = 100): Partial<Record<Role, number>> {
  const prior = new Map(before.map((r) => [`${r.node}:${r.pid}`, r]));
  const out: Partial<Record<Role, number>> = {};
  for (const row of after) {
    const was = prior.get(`${row.node}:${row.pid}`);
    if (!was || was.role !== row.role) continue;
    out[row.role] = (out[row.role] || 0) + Math.max(0, row.cpuTicks - was.cpuTicks) / ticksPerSecond;
  }
  return out;
}
