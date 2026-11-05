import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * How long the host keeps a transaction after the client has its answer.
 *
 * releaseHoldSeconds: the whole entry stays (default 60). Peers may vote up to a
 * minute late (the broadcast timeouts are 60 s), and a late vote for an entry
 * that was already deleted would look like a new transaction and be run again.
 *
 * releaseTailSeconds: after that the entry is destroyed but its record is kept
 * (default 120), to answer a peer that asks late. Every transaction held costs
 * memory for both periods together, so at a few hundred transactions a second this
 * is a large part of the host's footprint.
 *
 * Read when a transaction finishes, so a value that is not a number of zero or
 * more (including a flag given as text) falls back to the default.
 */
const seconds = (key: string, fallback: number): number => {
  const value = Number(ActiveOptions.get<number | string>(key, fallback));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const releaseHoldMs = (): number => seconds("releaseHoldSeconds", 60) * 1000;
export const releaseTailMs = (): number => seconds("releaseTailSeconds", 120) * 1000;
