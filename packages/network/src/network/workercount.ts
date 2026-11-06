/**
 * How many contract workers a node starts, from the `cpus` setting.
 *
 * The setting is a number of workers ("6", 6) or a percentage of the physical
 * cores ("50%"). A percentage is rounded to the nearest whole worker, and a
 * node always has at least one, so a one core machine at 25% still runs one.
 * Anything that is not a positive number (unset, 0, text, negative) means the
 * default.
 */
export const workerCount = (
  setting: unknown,
  physicalCores: number,
  fallback = physicalCores
): number => {
  const cores = Math.max(1, Math.floor(Number(physicalCores)) || 1);
  const text = String(setting ?? "").trim();

  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) {
    const share = Number(percent[1]);
    return share > 0 ? Math.max(1, Math.round((cores * share) / 100)) : fallback;
  }

  const count = /^\d+(?:\.\d+)?$/.test(text) ? Math.floor(Number(text)) : 0;
  return count >= 1 ? count : fallback;
};

/**
 * Without a `cpus` setting a node runs workers for half of its physical cores
 * (at least one). The host, storage and restore processes need cores of their
 * own, and a worker for every core only adds context switching: in four node
 * tests on one machine, a worker per core or more collapsed under load where
 * fewer held steady.
 */
export const DEFAULT_WORKER_COUNT = (physicalCores: number): number =>
  workerCount("50%", physicalCores);
