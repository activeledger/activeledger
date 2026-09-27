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

/** The prefix every event document's _id carries in the events database. */
export const EVENT_PREFIX = "event:";

/** Something that can list documents by key range, as LevelMe can. */
interface IAllDocs {
  allDocs(options: {
    startkey?: string;
    endkey?: string;
    include_docs?: boolean;
  }): Promise<unknown>;
}

/**
 * The events recorded after `lastEventId`, oldest first, for a client
 * resuming an event stream with a Last-Event-ID header.
 *
 * Returned as [id, event] pairs, where id is the SSE id (the _id without its
 * "event:" prefix) and event is the document without _id and _rev - the same
 * shape the live feed sends.
 *
 * Every event strictly after `lastEventId` is included. The replay used to
 * skip the first row unconditionally, on the assumption that it was always
 * the event the client last saw. That only held when the id matched a stored
 * event exactly: resuming from anything else (an id from another node, one
 * compacted away, a client's own bookmark) silently dropped the first event
 * the client had actually missed.
 *
 * @param db The events database
 * @param lastEventId The last SSE id the client received
 */
export async function eventsSince(
  db: IAllDocs,
  lastEventId: string
): Promise<Array<[string, Record<string, unknown>]>> {
  const after = EVENT_PREFIX + lastEventId;
  const result = (await db.allDocs({
    startkey: after,
    // The first key past every "event:..." id, so the range stays inside the
    // event documents.
    endkey: "event;",
    include_docs: true,
  })) as { rows: Array<Record<string, unknown>> };

  const events: Array<[string, Record<string, unknown>]> = [];
  for (const row of result.rows) {
    const docId = row._id as string;
    if (!docId || !docId.startsWith(EVENT_PREFIX) || docId <= after) {
      continue;
    }
    const { _id, _rev, ...event } = row;
    events.push([docId.slice(EVENT_PREFIX.length), event]);
  }
  return events;
}
