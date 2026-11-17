/**
 * What `activeledger prune` can remove from a node's own stores, and how it
 * tells how old a row is.
 *
 * Only the node-local stores that grow without bound are covered: the events
 * database (umid index rows, failure rows, contract events) and the errors
 * database and its archive. The ledger database is never a target.
 *
 * The age of a row comes from its id:
 *   umid:<ms>,<umid>          umid index row
 *   fail:<ms>,<umid>          failure index row
 *   event:<ms>-<n>,<umid>     contract event
 *   <umid>:<ms>               error document (64 hex characters, then the time it was logged)
 * `<ms>` is the time in milliseconds, 13 digits for any date from 2001 to
 * 2286, which is what makes a plain key order the same as time order for the
 * first three. An id that does not look like one of these is never removed.
 */

export type PruneKind = "umid" | "fail" | "event" | "error";

export const PRUNE_KINDS: PruneKind[] = ["umid", "fail", "event", "error"];

/** One page of a prune, as the storage server is asked for it */
export interface PruneRequest {
  kind: PruneKind;
  /** Remove rows older than this (ms since the epoch) */
  before: number;
  /** Carry on after this id: the `next` of the previous page */
  after?: string;
  /** The most rows to remove in this page (default 5,000) */
  limit?: number;
  /** Count what would go, remove nothing */
  dryRun?: boolean;
  /** error only: remove only documents already marked processed (default true) */
  requireProcessed?: boolean;
}

export interface PrunePage {
  /** Rows removed (or, in a dry run, that would be) in this page */
  removed: number;
  /** Rows looked at in this page */
  scanned: number;
  /** Rows looked at and left alone: too new, not yet processed, or not an id this recognises */
  kept: number;
  /** Where the next page starts. Absent once everything has been looked at */
  next?: string;
  done: boolean;
}

/** Most rows one page removes. A page has to finish well inside the server's idle timeout. */
export const DEFAULT_PAGE_LIMIT = 5000;
export const MAX_PAGE_LIMIT = 20000;
/** Longest a page looks for rows before it hands back a cursor */
export const PAGE_BUDGET_MS = 2000;
/** A cutoff newer than this long ago is refused by the server, so a mistake cannot take what a node is still using */
export const MIN_AGE_MS = 60 * 60 * 1000;

const TIME_KEYED = /^(umid|fail):(\d{13}),/;
const EVENT = /^event:(\d{13})[-,]/;
const ERROR = /^[0-9a-f]{64}:(\d{13})$/;

/**
 * When a row was written, from its id. `undefined` for an id that is not of
 * this kind (it is then left alone), including a time that is not 13 digits.
 */
export function idTime(kind: PruneKind, id: string): number | undefined {
  let match: RegExpExecArray | null = null;
  if (kind === "umid" || kind === "fail") {
    match = TIME_KEYED.exec(id);
    if (!match || match[1] !== kind) return undefined;
    return Number(match[2]);
  }
  if (kind === "event") {
    match = EVENT.exec(id);
    return match ? Number(match[1]) : undefined;
  }
  match = ERROR.exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * The ids a kind can have, as a range for a scan: `gte` and `lt`. Time keyed
 * kinds are one prefix, so their rows are in time order and a scan can stop at
 * the first row that is not old enough. Errors have no such order.
 */
export function idRange(kind: PruneKind): { gte: string; lt: string; ordered: boolean } {
  switch (kind) {
    case "umid":
      return { gte: "umid:", lt: "umid;", ordered: true };
    case "fail":
      return { gte: "fail:", lt: "fail;", ordered: true };
    case "event":
      return { gte: "event:", lt: "event;", ordered: true };
    default:
      return { gte: "0", lt: "g", ordered: false };
  }
}

/** A request the server will act on, or why not */
export function checkPruneRequest(body: unknown, now: number = Date.now()): { ok: true; request: PruneRequest } | { ok: false; error: string } {
  const b = body as Partial<PruneRequest> | null;
  if (!b || typeof b !== "object") return { ok: false, error: "a prune request is an object" };
  if (!PRUNE_KINDS.includes(b.kind as PruneKind)) return { ok: false, error: `kind must be one of ${PRUNE_KINDS.join(", ")}` };
  if (typeof b.before !== "number" || !Number.isFinite(b.before) || b.before <= 0) return { ok: false, error: "before must be a time in milliseconds" };
  if (b.before > now - MIN_AGE_MS) return { ok: false, error: "before must be at least an hour ago" };
  if (b.after !== undefined && typeof b.after !== "string") return { ok: false, error: "after must be an id" };
  let limit = DEFAULT_PAGE_LIMIT;
  if (b.limit !== undefined) {
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1) return { ok: false, error: "limit must be a whole number of at least 1" };
    limit = Math.min(b.limit, MAX_PAGE_LIMIT);
  }
  return {
    ok: true,
    request: {
      kind: b.kind as PruneKind,
      before: b.before,
      after: b.after,
      limit,
      dryRun: b.dryRun === true,
      requireProcessed: b.requireProcessed !== false,
    },
  };
}
