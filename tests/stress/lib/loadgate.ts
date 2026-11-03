/**
 * Load gate: a stress number measured on a busy machine says more about the
 * machine than about the code, so the tools wait for a quiet one first and
 * record the load around every run.
 */

import * as fs from "fs";

export interface LoadAverages {
  load1: number;
  load5: number;
  load15: number;
}

/** The three load averages from /proc/loadavg; zeros if it cannot be read. */
export function readLoad(): LoadAverages {
  try {
    const [a, b, c] = fs.readFileSync("/proc/loadavg", "utf8").split(" ").map(Number);
    return { load1: a, load5: b, load15: c };
  } catch {
    return { load1: 0, load5: 0, load15: 0 };
  }
}

export interface GateOptions {
  /** proceed once the 1 minute load average is below this */
  maxLoad: number;
  /** ... and has stayed below it for this many seconds */
  quietSeconds: number;
  /** give up waiting after this many seconds */
  timeoutSeconds: number;
  pollMs?: number;
  /** injectable for tests */
  read?: () => LoadAverages;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (load: LoadAverages, waitedSeconds: number) => void;
}

export interface GateResult {
  /** true if the machine was quiet for long enough, false on timeout */
  quiet: boolean;
  waitedSeconds: number;
  load: LoadAverages;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the 1 minute load average has been below `maxLoad` continuously
 * for `quietSeconds`. A reading above the threshold restarts the quiet
 * period. Never throws: on timeout it returns quiet:false and the caller
 * decides whether to go ahead (the tools do, and flag the run).
 */
export async function waitForQuiet(options: GateOptions): Promise<GateResult> {
  const read = options.read || readLoad;
  const now = options.now || Date.now;
  const sleep = options.sleep || realSleep;
  const pollMs = options.pollMs ?? 2000;
  const start = now();
  let quietSince: number | undefined;
  for (;;) {
    const load = read();
    const t = now();
    if (load.load1 < options.maxLoad) {
      if (quietSince === undefined) quietSince = t;
      if (t - quietSince >= options.quietSeconds * 1000) {
        return { quiet: true, waitedSeconds: (t - start) / 1000, load };
      }
    } else {
      quietSince = undefined;
    }
    if (t - start >= options.timeoutSeconds * 1000) {
      return { quiet: false, waitedSeconds: (t - start) / 1000, load };
    }
    if (options.onWait) options.onWait(load, (t - start) / 1000);
    await sleep(pollMs);
  }
}
