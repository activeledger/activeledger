/*
 * MIT License (MIT)
 * Copyright (c) 2026 Activeledger
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

import { ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";

/**
 * Same "skip anything with a : in its _id" filter Activecore's own
 * subscriptions.ts uses (dontSkip()) - umid/volatile/stream meta docs
 * aren't activity stream state changes.
 */
function isStateDocChange(change: { doc: { _id: string; $activeledger?: { delete?: boolean; rewrite?: boolean } } }): boolean {
  return (
    change.doc._id.indexOf(":") === -1 &&
    (!change.doc.$activeledger || (!change.doc.$activeledger.delete && !change.doc.$activeledger.rewrite))
  );
}

/**
 * One watcher per subscribe connection (matches Activecore's own
 * per-connection pattern in subscriptions.ts, not a regression) - opens a
 * live changes feed against the real datastore and calls back only for
 * changes to streams in `streamIds`. A future optimisation could share one
 * underlying feed across connections; not needed for v1's correctness.
 */
export class ChangesWatcher {
  private feed: ActiveDefinitions.IActiveDSChanges | null = null;

  /**
   * @param since Where to resume the changes feed from - a DB sequence
   * (as previously handed back via onChange's seq param) to replay
   * anything missed while disconnected, or "now" for a fresh subscription
   * with no history. Comes from the client's Last-Event-ID on reconnect.
   */
  constructor(private db: ActiveDSConnect, private streamIds: Set<string>, private since: string | number = "now") {}

  public start(
    onChange: (doc: Record<string, unknown> & { _id: string; _rev: string }, seq: string | number) => void,
    onError: (error: unknown) => void
  ): void {
    const result = this.db.changes({ live: true, since: this.since, include_docs: true });
    // The interface's return type is `Promise<any> | IActiveDSChanges` - live:true always takes the sync branch (dsconnect.ts's changes()).
    this.feed = result as ActiveDefinitions.IActiveDSChanges;

    this.feed.on("change", (change: { doc: Record<string, unknown> & { _id: string; _rev: string }; seq: string | number }) => {
      if (!isStateDocChange(change as any)) return;
      if (!this.streamIds.has(change.doc._id)) return;
      onChange(change.doc, change.seq);
    });

    this.feed.on("error", onError);
  }

  public stop(): void {
    this.feed?.cancel();
    this.feed = null;
  }
}
