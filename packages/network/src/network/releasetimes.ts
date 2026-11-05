import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * How long the host keeps a transaction after the client has its answer.
 *
 * releaseHoldSeconds: the whole entry stays (default 60). Peers may vote up to a
 * minute late (the broadcast timeouts are 60 s), and a late vote for an entry
 * that was already deleted would look like a new transaction and be run again.
 *
 * releaseTailSeconds: after that the entry is destroyed but its record is kept
 * (default 10), to answer a peer that asks late. Anything that could still use the
 * entry has already timed out by then (the broadcast timeouts are 60 s), and a
 * longer tail only held memory: in a four minute test at about 600 to 700
 * transactions a second a 10 s tail gave about 21% more throughput, 21% less host
 * CPU per transaction and a third less host memory than the old 120 s.
 *
 * Read when a transaction finishes, so a value that is not a number of zero or
 * more (including a flag given as text) falls back to the default.
 */
const seconds = (key: string, fallback: number): number => {
  const value = Number(ActiveOptions.get<number | string>(key, fallback));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const releaseHoldMs = (): number => seconds("releaseHoldSeconds", 60) * 1000;
export const releaseTailMs = (): number => seconds("releaseTailSeconds", 10) * 1000;
