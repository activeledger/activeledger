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

import { EVENT_PREFIX } from "@activeledger/activestorage";
import type { HybridStore } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const UMID_SUFFIX = ":umid";
const META_SUFFIX = ":stream";

export interface PrunerOptions {
  store: Pick<HybridStore, "data" | "events">;
  /** `window.days` from the hybrid config */
  config: { window: { days: number } };
  /** This hybrid's public key PEM: `:umid` docs it relayed are kept forever */
  publicPem: string;
  /** Between runs once started. Default one hour. */
  intervalMs?: number;
  /** Documents read per page. Default 500. */
  pageSize?: number;
  now?: () => number;
  /** A timed run that failed. Default: ignored (the next run tries again). */
  onError?: (e: unknown) => void;
}

export interface PruneCounts {
  dryRun: boolean;
  /** Oldest time kept, ms */
  cutoff: number;
  umids: {
    scanned: number;
    /** Deleted, or would be with dryRun */
    pruned: number;
    /** A stream's meta points at it */
    keptCurrent: number;
    /** Relayed by this hybrid */
    keptRelayed: number;
    /** Inside the window */
    keptRecent: number;
    /** No readable `$datetime`, so its age is unknown */
    keptUndated: number;
  };
  events: {
    scanned: number;
    pruned: number;
  };
}

/**
 * The storage window. Kept: every stream's state, meta and volatile (never
 * touched here), the `:umid` doc each stream's `meta.umid` points to, and
 * the `:umid` docs whose `$relay` is this hybrid. Other `:umid` docs and
 * events are kept only inside `window.days`. Nothing else is deleted:
 * divergence records, attestations and the errors database are left alone.
 *
 * A `:umid` doc's age is its `$datetime` (the consensus time), an event's is
 * the milliseconds in its id.
 *
 * Safe against concurrent commits: every `:stream` meta written while a run
 * is in progress is watched, and a `:umid` doc is checked against the
 * current set of pointed-at umids immediately before it is deleted.
 */
export class Pruner {
  private timer?: NodeJS.Timeout;
  private running?: Promise<PruneCounts>;
  private readonly intervalMs: number;
  private readonly pageSize: number;
  private readonly now: () => number;

  constructor(private readonly opts: PrunerOptions) {
    this.intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
    this.pageSize = opts.pageSize ?? 500;
    this.now = opts.now ?? Date.now;
  }

  /** Run every `intervalMs` until stopped. Does not keep the process alive. */
  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.run().catch((e) => this.opts.onError?.(e));
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Concurrent calls share the run in progress. */
  public run(options: { dryRun?: boolean } = {}): Promise<PruneCounts> {
    if (this.running) return this.running;
    this.running = this.pass(!!options.dryRun).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(dryRun: boolean): Promise<PruneCounts> {
    const days = this.opts.config.window.days;
    if (!(typeof days === "number" && Number.isFinite(days) && days > 0)) {
      throw new Error("pruner: window.days must be a positive number");
    }
    const cutoff = this.now() - days * DAY_MS;
    const counts: PruneCounts = {
      dryRun,
      cutoff,
      umids: {
        scanned: 0,
        pruned: 0,
        keptCurrent: 0,
        keptRelayed: 0,
        keptRecent: 0,
        keptUndated: 0,
      },
      events: { scanned: 0, pruned: 0 },
    };

    const data = this.opts.store.data.level;
    const pointed = new Set<string>();

    // Watch metas written during the run before the scan starts, so none
    // falls between the scan and a delete
    const watch = (change: any) => {
      const id: string = change?.id ?? change?.doc?._id ?? "";
      if (id.endsWith(META_SUFFIX) && typeof change?.doc?.umid === "string") {
        pointed.add(change.doc.umid);
      }
    };
    const emitter = data.changes();
    emitter.on("change", watch);

    try {
      // One scan: the umids streams point at, and the :umid docs outside the
      // window. Which of those old ones is pointed at is settled after, when
      // every meta has been seen
      const candidates: string[] = [];
      await this.scan(data, "", undefined, async (doc) => {
        if (doc._id.endsWith(META_SUFFIX)) {
          if (typeof doc.umid === "string") pointed.add(doc.umid);
          return;
        }
        if (!doc._id.endsWith(UMID_SUFFIX)) return;
        counts.umids.scanned++;
        const umid = doc._id.slice(0, -UMID_SUFFIX.length);
        if (doc.umid?.$relay?.key === this.opts.publicPem) {
          counts.umids.keptRelayed++;
        } else {
          const at = Date.parse(doc.umid?.$datetime);
          if (!Number.isFinite(at)) counts.umids.keptUndated++;
          else if (at >= cutoff) counts.umids.keptRecent++;
          else candidates.push(umid);
        }
      });

      for (const umid of candidates) {
        // Pointed at by a stream, or by a commit since the scan
        if (pointed.has(umid)) {
          counts.umids.keptCurrent++;
          continue;
        }
        if (!dryRun) await data.del(umid + UMID_SUFFIX);
        counts.umids.pruned++;
      }
    } finally {
      emitter.off("change", watch);
    }

    // Events: ids are event:<ms>-..., so the window is a key range
    const events = this.opts.store.events.level;
    const old: string[] = [];
    await this.scan(events, EVENT_PREFIX, EVENT_PREFIX + cutoff, async (doc) => {
      counts.events.scanned++;
      const ms = Number(/^event:(\d+)/.exec(doc._id)?.[1]);
      if (Number.isFinite(ms) && ms < cutoff) old.push(doc._id);
    });
    for (const id of old) {
      if (!dryRun) await events.del(id);
      counts.events.pruned++;
    }

    return counts;
  }

  /**
   * Page through documents from `start` (inclusive) to `end` (exclusive),
   * straight from LevelMe so the key range is not rewritten.
   */
  private async scan(
    level: any,
    start: string,
    end: string | undefined,
    visit: (doc: any) => Promise<void>
  ): Promise<void> {
    let startkey = start;
    for (;;) {
      const page: any = await level.allDocs({
        startkey,
        ...(end !== undefined ? { endkey: end } : {}),
        limit: this.pageSize,
        include_docs: true,
      });
      const rows: any[] = page?.rows ?? [];
      for (const doc of rows) {
        if (doc && typeof doc._id === "string") await visit(doc);
      }
      if (rows.length < this.pageSize) return;
      // The next key after the last one read
      startkey = rows[rows.length - 1]._id + "\u0000";
    }
  }
}
