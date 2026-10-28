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

import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { UpstreamError } from "./http-upstream";
import { ApplyOutcome, NodeState } from "./types";
import { Upstream } from "./upstream";

/** `umid:<ms>,<umid>` or `fail:<ms>,<umid>` -> `<ms>,<umid>`, the order they share */
export const cursorKey = (cursor: string): string => cursor.replace(/^(umid|fail):/, "");

/** True when `cursor` is at or past `head` (an empty head is an empty ledger) */
export const atOrPast = (cursor: string, head: string): boolean =>
  !head || cursorKey(cursor) >= cursorKey(head);

export interface FeedManagerOptions {
  /** Supernodes in preference order; the feed uses the first that works */
  upstreams: Upstream[];
  state: NodeState;
  /** Applies one item and resolves when it is settled */
  apply: (item: ActiveDefinitions.IFeedItem, from: Upstream) => Promise<ApplyOutcome>;
  /** Called after each item with the cursor to resume from */
  saveCursor: (cursor: string) => Promise<void>;
  /** Wait before retrying all upstreams, doubling to the maximum */
  backoffMs?: { min: number; max: number };
  /** How long to sit out while the node is outdated before looking again */
  outdatedPauseMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Wait between passes over the items dropped for a transient reason */
  retryMs?: number;
  /** Attempts in all (the first included) before a dropped item is given up */
  retryAttempts?: number;
  /** Most items held for a retry; the oldest are given up past it */
  retryLimit?: number;
  /** Told about each outcome, e.g. to relay on a yes vote later */
  onOutcome?: (outcome: ApplyOutcome, cursor: string) => void;
  /** The `minVersion` a heartbeat named, so a raised one is seen without a restart */
  onMinVersion?: (minVersion: string) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Keeps the node following the ledger: one feed at a time from the first
 * upstream that works, reconnecting with backoff, never applying items while
 * the node is outdated, and keeping `state` current for `/health`.
 *
 * "At the head" is confirmed when a heartbeat names a head the node has
 * already applied (so a quiet ledger does not read as lagging).
 */
export class FeedManager {
  private abort?: AbortController;
  private running?: Promise<void>;
  private cursor = "";
  private headSeen = "";
  private retries: { item: ActiveDefinitions.IFeedItem; from: Upstream; attempts: number }[] = [];

  constructor(private readonly options: FeedManagerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The newest head any heartbeat has named */
  public get head(): string {
    return this.headSeen;
  }

  public start(cursor: string): void {
    if (this.running) return;
    this.cursor = cursor;
    this.options.state.cursor = cursor;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    // One promise for both loops: if the feed loop dies the retry loop is
    // aborted with it, and a later start() begins clean
    this.running = (async () => {
      try {
        await Promise.all([this.loop(signal), this.retryLoop(signal)]);
      } finally {
        this.abort?.abort();
        this.running = undefined;
      }
    })();
  }

  public async stop(): Promise<void> {
    this.abort?.abort();
    await this.running;
  }

  /** Mark the head confirmed when we have applied everything up to it */
  private confirm(head: string): void {
    this.headSeen = head;
    if (atOrPast(this.cursor, head)) this.options.state.headConfirmedAt = this.now();
  }

  private mark(upstream: Upstream, ok: boolean): void {
    const host = upstream.id;
    // The state starts with "host:port" and an upstream's id adds its
    // transport ("host:port:http"), so match either, and do not add a second
    // entry for the same supernode
    const entry = this.options.state.upstreams.find(
      (u) => u.host === host || host.startsWith(`${u.host}:`)
    );
    if (entry) entry.ok = ok;
    else this.options.state.upstreams.push({ host, ok });
  }

  /** Keep a transiently dropped item for another attempt */
  private hold(item: ActiveDefinitions.IFeedItem, from: Upstream, outcome: ApplyOutcome, attempts: number): boolean {
    if (!outcome.retry || attempts >= (this.options.retryAttempts ?? 5)) return false;
    this.retries.push({ item, from, attempts });
    const limit = this.options.retryLimit ?? 200;
    if (this.retries.length > limit) {
      const gone = this.retries.splice(0, this.retries.length - limit);
      ActiveLogger.warn(`Retry queue full: giving up on ${gone.length} dropped item(s)`);
    }
    return true;
  }

  /** Every so often, offer the dropped items to the processor again, oldest first */
  private async retryLoop(signal: AbortSignal): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    while (!signal.aborted) {
      await sleep(this.options.retryMs ?? 30000, signal);
      if (signal.aborted) return;
      if (!this.retries.length || this.options.state.reason === "outdated") continue;
      const batch = this.retries;
      this.retries = [];
      for (const entry of batch) {
        if (signal.aborted) return;
        let outcome: ApplyOutcome;
        try {
          outcome = await this.options.apply(entry.item, entry.from);
        } catch (e) {
          ActiveLogger.warn(`Retry of ${entry.item?.umid} failed: ${(e as Error)?.message || e}`);
          continue;
        }
        if (this.hold(entry.item, entry.from, outcome, entry.attempts + 1)) continue;
        // Settled, or out of attempts: say so, so the first drop is not the last word
        this.options.onOutcome?.(outcome, this.cursor);
      }
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    const { min, max } = this.options.backoffMs ?? { min: 1000, max: 30000 };
    let wait = min;

    while (!signal.aborted) {
      if (this.options.state.reason === "outdated") {
        // No feed is open to carry a heartbeat, so ask: a lowered minimum
        // must be seen to resume
        for (const upstream of this.options.upstreams) {
          const head = await (async () => upstream.head())().catch(() => undefined);
          if (head?.minVersion) {
            this.options.onMinVersion?.(head.minVersion);
            break;
          }
        }
        await sleep(this.options.outdatedPauseMs ?? 5000, signal);
        continue;
      }

      let progressed = false;
      for (const upstream of this.options.upstreams) {
        if (signal.aborted) return;
        try {
          await upstream.feed(
            this.cursor,
            async (cursor, item) => {
              // Nothing is applied once we know we are too old to judge it
              if (this.options.state.reason === "outdated") throw new FeedPaused();
              const outcome = await this.options.apply(item, upstream);
              this.cursor = cursor;
              this.options.state.cursor = cursor;
              progressed = true;
              await this.options.saveCursor(cursor);
              this.options.onOutcome?.(outcome, cursor);
              this.hold(item, upstream, outcome, 1);
              if (atOrPast(cursor, this.headSeen)) this.options.state.headConfirmedAt = this.now();
            },
            signal,
            (head, _time, minVersion) => {
              this.mark(upstream, true);
              this.confirm(head);
              if (minVersion) this.options.onMinVersion?.(minVersion);
            }
          );
          if (signal.aborted) return;
          this.mark(upstream, true);
          // The upstream ended the stream cleanly: go round again from here
          break;
        } catch (e) {
          if (e instanceof FeedPaused) break;
          this.mark(upstream, false);
          const refused = e instanceof UpstreamError && e.refused;
          ActiveLogger.warn(
            refused
              ? `${upstream.id} refused the feed (not registered, retired or banned)`
              : `${upstream.id} feed ended: ${(e as Error).message}`
          );
          // Try the next upstream straight away
        }
      }

      if (signal.aborted) return;
      wait = progressed ? min : Math.min(max, wait * 2);
      await sleep(wait, signal);
    }
  }
}

class FeedPaused extends Error {}
