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
import { revPosition } from "@activeledger/activesync";
import { readDoc, splitRev } from "./lookup";
import type { ApplyOutcome, HybridStore, ItemProcessor } from "./types";
import type { Upstream } from "./upstream";

type IFeedItem = ActiveDefinitions.IFeedItem;

export interface ItemOrdererOptions {
  processor: ItemProcessor;
  store: Pick<HybridStore, "data">;
  /** Items sharing no streams run concurrently, up to this many. Default 4. */
  concurrency?: number;
  /**
   * How long an out-of-order item waits for the items before it. After
   * this it runs anyway and lookup fetches what it lacks. Default 5000ms.
   */
  waitMs?: number;
}

interface Pending {
  key: string;
  item: IFeedItem;
  from: Upstream;
  streams: Set<string>;
  forced: boolean;
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<ApplyOutcome>;
  resolve: (o: ApplyOutcome) => void;
}

/** The streams an item reads or writes */
function streamsOf(item: IFeedItem): Set<string> {
  const out = new Set<string>();
  for (const side of [item?.$revs?.$i, item?.$revs?.$o]) {
    for (const id of Object.keys(side || {})) out.add(id);
  }
  for (const id of Object.keys(item?.attestation?.revsOut || item?.revsOut || {})) {
    out.add(id.split(":")[0]);
  }
  return out;
}

/**
 * Step 5, ordering. Items that share streams apply in `$revs`-chain order:
 * an item whose streams are held locally at an earlier position than its
 * `$revs` waits in a holding buffer until the items before it have applied,
 * or until `waitMs` passes. Items that share no streams run concurrently,
 * up to `concurrency`; items sharing a stream never run at the same time.
 * A duplicate of a pending item gets the same outcome.
 */
export class ItemOrderer {
  private readonly buffer: Pending[] = [];
  private readonly running = new Set<Pending>();
  private readonly byKey = new Map<string, Pending>();
  private pumping = false;
  private again = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly options: ItemOrdererOptions) {}

  /** Items waiting or running */
  public get pending(): number {
    return this.buffer.length + this.running.size;
  }

  /** Resolves when nothing is waiting or running */
  public idle(): Promise<void> {
    if (!this.pending) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  public submit(item: IFeedItem, from: Upstream): Promise<ApplyOutcome> {
    const key = `${item?.outcome}:${item?.umid}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.promise;
    let resolve!: (o: ApplyOutcome) => void;
    const promise = new Promise<ApplyOutcome>((r) => (resolve = r));
    const p: Pending = { key, item, from, streams: streamsOf(item), forced: false, promise, resolve };
    this.byKey.set(key, p);
    this.buffer.push(p);
    void this.pump();
    return promise;
  }

  /** True when a stream the item needs is held locally behind its `$revs` */
  private async behind(item: IFeedItem): Promise<boolean> {
    for (const side of [item?.$revs?.$i, item?.$revs?.$o]) {
      for (const id of Object.keys(side || {})) {
        const { state } = splitRev((side as any)[id]);
        if (!state) continue;
        const local = await readDoc(this.options.store.data, id);
        // Unknown locally: lookup learns it, nothing to wait for
        if (!local || local._rev === state) continue;
        if (revPosition(local._rev) < revPosition(state)) return true;
      }
    }
    return false;
  }

  private sharesRunning(p: Pending): boolean {
    for (const r of this.running) {
      for (const id of p.streams) if (r.streams.has(id)) return true;
    }
    return false;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        const cap = Math.max(1, this.options.concurrency ?? 4);
        for (const p of [...this.buffer]) {
          if (this.running.size >= cap) break;
          if (this.sharesRunning(p)) continue;
          if (!p.forced && (await this.behind(p.item))) {
            this.arm(p);
            continue;
          }
          this.start(p);
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
    if (!this.pending) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private arm(p: Pending): void {
    if (p.timer) return;
    p.timer = setTimeout(() => {
      p.forced = true;
      void this.pump();
    }, this.options.waitMs ?? 5000);
  }

  private start(p: Pending): void {
    const i = this.buffer.indexOf(p);
    if (i !== -1) this.buffer.splice(i, 1);
    if (p.timer) clearTimeout(p.timer);
    this.running.add(p);
    this.options.processor
      .apply(p.item, p.from)
      .catch(
        (e): ApplyOutcome => ({
          umid: p.item?.umid,
          action: "dropped",
          vote: "no",
          warnings: [],
          reasons: [`apply failed: ${(e as Error)?.message || e}`],
        })
      )
      .then((o) => {
        this.running.delete(p);
        this.byKey.delete(p.key);
        p.resolve(o);
        void this.pump();
      });
  }
}
