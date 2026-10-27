/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { EVENT_PREFIX } from "@activeledger/activestorage";
import type { EventSink, HybridEvent } from "./types";

/**
 * Event types the hybrid raises itself. Stored with phase "hybrid", which is
 * how the filter tells them from contract events. A contract event that
 * happens to use one of these names is stored as the hybrid's own, so it is
 * never served under a pinned `where` (the fail-closed direction).
 */
export const HYBRID_EVENT_TYPES = [
  "tx.committed",
  "tx.failed",
  "divergence",
  "adopt.undeclared",
];

/** Phase stored on the hybrid's own events */
export const HYBRID_PHASE = "hybrid";

/** Phase stored on contract events written through the log */
export const CONTRACT_PHASE = "commit";

/** Anything with `post`, as EmbeddedDSConnect has */
interface IPost {
  post(doc: {}): Promise<any>;
}

/**
 * Writes events into the events database, in the shape the supernode's
 * contract events have (`packages/query` EventEngine): `{name, data, phase,
 * contract}` under `event:<ms>-<seq>,<umid>`. `eventsSince` reads them back
 * in key order and `/events` serves them without `_id` and `_rev`, as the
 * supernode storage process does.
 *
 * The sequence is zero padded so two events in the same millisecond still
 * sort in the order they were raised.
 */
export class EventLog implements EventSink {
  private seq = 0;
  private lastMs = 0;

  constructor(
    private readonly db: IPost,
    private readonly now: () => number = Date.now
  ) {}

  /** The id the next event would get (exposed for tests) */
  public nextId(umid?: string): string {
    let ms = this.now();
    // Never go backwards: a clock step back would otherwise sort a new
    // event before ones a client already holds.
    if (ms < this.lastMs) ms = this.lastMs;
    if (ms !== this.lastMs) {
      this.lastMs = ms;
      this.seq = 0;
    }
    this.seq++;
    return `${EVENT_PREFIX}${ms}-${String(this.seq).padStart(6, "0")},${umid || "hybrid"}`;
  }

  public async emit(event: HybridEvent): Promise<void> {
    if (!event || typeof event.type !== "string" || !event.type) {
      throw new Error("event: a type is required");
    }
    const own = HYBRID_EVENT_TYPES.includes(event.type);
    const doc: any = {
      _id: this.nextId(event.umid),
      name: event.type,
      data: event.payload ?? {},
      phase: own ? HYBRID_PHASE : CONTRACT_PHASE,
    };
    if (event.contract !== undefined) doc.contract = event.contract;
    if (event.umid !== undefined) doc.umid = event.umid;
    const r = await this.db.post(doc);
    // EmbeddedDSConnect resolves (never rejects) with the error on failure
    if (r && (r.error || r.reason) && !r.ok && !r.id) {
      throw new Error(`event not written: ${r.reason || r.error}`);
    }
  }
}

/** A client's (or the operator's) filter */
export interface EventFilterSpec {
  /** Any of these contracts */
  contracts?: string[];
  /** Every one of these top-level payload fields equal to the value */
  where?: { [field: string]: string };
}

/** Thrown for a malformed client filter; the API answers 400 */
export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

const hasOwn = (o: unknown, k: string) =>
  typeof o === "object" && o !== null && Object.prototype.hasOwnProperty.call(o, k);

/** A contract reference matches by exact name or by the id before `@version` */
const contractMatches = (eventContract: unknown, wanted: string[]): boolean => {
  if (typeof eventContract !== "string" || !eventContract) return false;
  const base = eventContract.split("@")[0];
  return wanted.some((w) => w === eventContract || w === base);
};

/** Equality on a primitive; objects, arrays and absent fields never match */
const fieldMatches = (payload: unknown, field: string, want: string): boolean => {
  if (!hasOwn(payload, field)) return false;
  const v = (payload as any)[field];
  if (typeof v === "string") return v === want;
  if (typeof v === "number" || typeof v === "boolean") return String(v) === want;
  return false;
};

/**
 * The `/events` filter: the operator's pinned filter AND the client's. A
 * client can only narrow, never widen, because an event must pass both.
 *
 * - `contracts`: the event's `contract` must be listed (any of). An event
 *   with no contract fails a contract filter.
 * - `where`: every field must be a top-level property of the payload
 *   (`data`) and equal to the value. Missing means excluded (fail closed).
 * - With a pinned `where`, the hybrid's own events (`tx.committed`,
 *   `tx.failed`, `divergence`, ...) are never served: only contract events.
 *
 * Works on stored event documents (or the same without `_id`/`_rev`), so
 * the replay after `Last-Event-ID` and the live tail use the same test.
 */
export class EventFilter {
  constructor(
    private readonly pinned: EventFilterSpec = {},
    private readonly client: EventFilterSpec = {}
  ) {}

  /**
   * Parse a client's query: `contract` (repeatable) and `where` as
   * `field:value` (repeatable, all must hold). Throws `FilterError`.
   */
  public static parseQuery(params: URLSearchParams): EventFilterSpec {
    const spec: EventFilterSpec = {};
    const contracts = params.getAll("contract");
    if (contracts.length) {
      if (contracts.some((c) => !c)) throw new FilterError("contract: expected a value");
      spec.contracts = contracts;
    }
    const wheres = params.getAll("where");
    if (wheres.length) {
      // No prototype, so a field named __proto__ is just a field
      spec.where = Object.create(null) as { [field: string]: string };
      for (const w of wheres) {
        const i = w.indexOf(":");
        if (i <= 0) throw new FilterError("where: expected field:value");
        const field = w.slice(0, i);
        const value = w.slice(i + 1);
        if (hasOwn(spec.where, field) && spec.where[field] !== value) {
          throw new FilterError(`where: two values for ${field}`);
        }
        spec.where[field] = value;
      }
    }
    for (const k of params.keys()) {
      if (k !== "contract" && k !== "where") throw new FilterError(`${k}: unknown filter`);
    }
    return spec;
  }

  /** True when this event may be served */
  public allows(event: any): boolean {
    if (!event || typeof event !== "object") return false;
    return this.passes(event, this.pinned, true) && this.passes(event, this.client, false);
  }

  private passes(event: any, spec: EventFilterSpec, pinned: boolean): boolean {
    if (spec.contracts && !contractMatches(event.contract, spec.contracts)) return false;
    const where = spec.where ? Object.keys(spec.where) : [];
    if (where.length) {
      if (pinned && isOwnEvent(event)) return false;
      for (const field of where) {
        if (!fieldMatches(event.data, field, (spec.where as any)[field])) return false;
      }
    }
    return true;
  }
}

/** The hybrid's own events: written by EventLog with phase "hybrid" */
export function isOwnEvent(event: any): boolean {
  return event?.phase === HYBRID_PHASE || HYBRID_EVENT_TYPES.includes(event?.name);
}

/** The pinned filter from config, as an EventFilterSpec */
export function pinnedFilter(config: Pick<ActiveDefinitions.IHybridConfig, "events">): EventFilterSpec {
  const e = config.events;
  if (!e) return {};
  const spec: EventFilterSpec = {};
  if (e.contracts) spec.contracts = [...e.contracts];
  if (e.where && Object.keys(e.where).length) spec.where = { ...e.where };
  return spec;
}
