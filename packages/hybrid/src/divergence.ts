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
import type { HybridStore } from "./types";

type IDivergenceRecord = ActiveDefinitions.IDivergenceRecord;

/**
 * Divergence records: written locally (events DB) when this hybrid's result
 * differs from the supernodes'. Not gossiped in v1.
 *
 * Key: `divergence:<ms>,<umid>`, with `<ms>` zero-padded so the keys sort by
 * time, the same shape as the supernode's `umid:<ms>,<umid>` cursors.
 */

const PREFIX = "divergence:";

const pad = (ms: number) => String(Math.max(0, Math.floor(ms))).padStart(13, "0");

/** The events-DB key of a record */
export const divergenceKey = (record: Pick<IDivergenceRecord, "umid" | "at">): string => {
  const ms = Date.parse(record.at);
  return `${PREFIX}${pad(Number.isFinite(ms) ? ms : Date.now())},${record.umid}`;
};

/** Write a record; resolves with its key */
export async function writeDivergence(
  store: Pick<HybridStore, "events">,
  record: IDivergenceRecord
): Promise<string> {
  const _id = divergenceKey(record);
  const r = await store.events.post({ _id, ...record });
  if (r && (r.error || r.reason) && !r.ok && !r.id) {
    throw new Error(`divergence record ${_id} not written: ${r.reason || r.error}`);
  }
  return _id;
}

/**
 * Records at or after `since` (a Date, epoch ms or anything Date.parse
 * takes), oldest first. Without `since`, every record.
 */
export async function listDivergences(
  store: Pick<HybridStore, "events">,
  since?: Date | number | string
): Promise<IDivergenceRecord[]> {
  let ms = 0;
  if (since instanceof Date) ms = since.getTime();
  else if (typeof since === "number") ms = since;
  else if (typeof since === "string" && since) ms = Date.parse(since);
  if (!Number.isFinite(ms)) throw new Error(`invalid since: ${String(since)}`);

  const r = await store.events.allDocs({
    startkey: `${PREFIX}${pad(ms)}`,
    // allDocs swaps the last character for a high one, so this spans the prefix
    endkey: `${PREFIX}x`,
    include_docs: true,
  });
  const out: IDivergenceRecord[] = [];
  for (const row of r?.rows ?? []) {
    const doc = row?.doc ?? row;
    if (!doc || typeof doc._id !== "string" || !doc._id.startsWith(PREFIX)) continue;
    const { _id, _rev, ...record } = doc;
    out.push(record as IDivergenceRecord);
  }
  return out;
}
