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
import { IActiveHttpIncoming } from "@activeledger/httpd";

/**
 * Single stream read. Deliberately NOT a port of Activecore's getStream()
 * (packages/core/src/controllers/streams.ts) - that has a real bug
 * (`delete results._id, results._rev;` is a comma expression, only the
 * first delete actually runs, so its response is missing _id but keeps
 * _rev) discovered this session while building the nano client against
 * it. New code doesn't get to inherit that bug.
 */
export async function getStream(incoming: IActiveHttpIncoming, db: ActiveDSConnect): Promise<unknown> {
  try {
    const doc = await db.get(incoming.url[2]);
    return { stream: doc };
  } catch {
    return { stream: null };
  }
}

/**
 * Batch read, open (no auth - ledger data is public by design, only the
 * *push/subscribe* channel is permissioned per the user's own framing).
 * Body is a plain JSON array of stream ids, matching Activecore's
 * getStreams() request shape so nano's MiniSpiClient needs no changes here.
 */
export async function getStreams(incoming: IActiveHttpIncoming, db: ActiveDSConnect): Promise<unknown> {
  const ids: string[] = Array.isArray(incoming.body) ? incoming.body : [];
  if (ids.length === 0) {
    return { streams: [] };
  }
  const result = await db.allDocs({ keys: ids, include_docs: true });
  const streams = (result?.rows ?? [])
    .map((row: { doc?: unknown }) => row.doc)
    .filter((doc: unknown) => doc !== undefined && doc !== null);
  return { streams };
}
