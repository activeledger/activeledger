import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";

/**
 * Young-generation size for contract worker processes.
 *
 * A worker's V8 heap carries about 100 MB of young generation slack above
 * what it actually uses (heapTotal 120-137 MB against heapUsed about 42 MB),
 * and with one worker per core that is the largest single block of memory a
 * node holds. --max-semi-space-size caps the young generation, so the slack
 * is never allocated. It is applied to workers only: the host, storage and
 * restore processes are launched elsewhere and never see it.
 *
 * The worker's own memory guard (max_memory, checked against process RSS in
 * process.ts) is independent of this and unchanged; a smaller heap simply
 * reaches it later.
 */

/**
 * Default `worker_semi_space` in MB. 0 means no flag, V8's own sizing.
 *
 * Off, from measurement. On a 4 node, 16 client run of a light contract the
 * flag at 2 or 4 MB cut node RSS by about 800 MB (-24%) with throughput and
 * p99 inside the run-to-run spread. On a contract that does real work per
 * transaction it did not hold: with 4 MB, 214 -> 168 tx/s, p99 118 -> 152 ms
 * and worker CPU per transaction 57 -> 89 ms, because a small young
 * generation scavenges far more often once a contract allocates heavily. So
 * it is a choice for light-contract deployments, not a safe default.
 */
export const DEFAULT_WORKER_SEMI_SPACE_MB = 0;

/**
 * Largest value accepted. V8's own default maximum is 16 MB; anything far
 * past that is a typo for a setting that exists to make heaps smaller.
 */
export const MAX_WORKER_SEMI_SPACE_MB = 64;

/**
 * Reads `worker_semi_space` (MB) and returns the value to use: 0 for no
 * flag. Anything that is not a whole number from 1 to 64, or an explicit
 * 0 / false, logs a warning and falls back to no flag, so a bad value can
 * never stop workers starting.
 */
export const workerSemiSpaceMb = (): number => {
  const raw = ActiveOptions.get<unknown>(
    "worker_semi_space",
    DEFAULT_WORKER_SEMI_SPACE_MB
  );

  if (raw === 0 || raw === "0" || raw === false || raw === "false") {
    return 0;
  }

  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
  if (value >= 1 && value <= MAX_WORKER_SEMI_SPACE_MB) {
    return value;
  }

  ActiveLogger.warn(
    `worker_semi_space "${String(
      raw
    )}" is not a whole number of MB from 1 to ${MAX_WORKER_SEMI_SPACE_MB} (or 0 for none), starting workers without it`
  );
  return 0;
};

/**
 * Node arguments for a worker process: whatever the host itself was started
 * with (fork's own default), plus the configured V8 flags.
 */
export const workerExecArgv = (
  inherited: string[] = process.execArgv
): string[] => {
  const mb = workerSemiSpaceMb();
  return mb > 0
    ? [...inherited, `--max-semi-space-size=${mb}`]
    : [...inherited];
};
