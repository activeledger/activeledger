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
import { ActiveCrypto } from "@activeledger/activecrypto";
import { bulkWriteFailed, previousUmidFor } from "./spi";

/**
 * The answers other nodes give. Transport-agnostic: a supernode asks its
 * neighbourhood over HTTP, a hybrid asks supernodes and peers over HTTP or P2P.
 */
export interface PeerSource {
  /** Every reachable peer's `<umid>:umid` document; a peer that cannot answer is left out or empty */
  umid(umid: string): Promise<any[]>;
}

/** The local copy of the ledger, as much of ActiveDSConnect as sync needs */
export interface SyncStore {
  get(id: string): Promise<any>;
  bulkDocs(docs: any[], options?: { new_edits: boolean; force_rev?: string }): Promise<any>;
}

export interface SyncContext {
  store: SyncStore;
  /** The events database */
  events: { post(doc: any): Promise<any> };
  peers: PeerSource;
  /** How far back one walk goes. Default 100 */
  walkLimit?: number;
  /** Pause between hops. Default 50ms */
  hopDelayMs?: number;
  /**
   * Keep walking through umids that are already held, instead of stopping at
   * the first one. A held umid is only read, never fetched or replayed. For a
   * full restore, which has to find a gap in the middle of a chain; SPI keeps
   * the default because it is repairing the newest hops.
   */
  continuePastHeld?: boolean;
}

export const UMID_WALK_LIMIT = 100;
export const UMID_WALK_HOP_DELAY_MS = 50;

/**
 * Fetch a transaction's umid document from the network and adopt it,
 * replaying the events it carried.
 *
 * SPI rewrites a node's STATE. The umid of the transaction that produced
 * that state, and the events its contract raised, are separate documents
 * this node never wrote because it never ran that commit. Until now the
 * only thing that backfilled them was activerestore's interagent, driven
 * by the 950 error document SPI writes - so the repair depended on a
 * whole second process being alive. That process was disabled outright
 * on any node set up on a non-default port, and has been observed dead
 * for days in production. Neither shows up as a fault: state converges,
 * the node looks healthy, and only the event feed quietly stops.
 *
 * Doing it here removes that dependency for the common case. The 950 is
 * still written, so a durable retry survives a crash or an unreachable
 * peer - restore then finds the work already done (its own
 * verifyUmidNotFound check) and marks it processed. Belt and braces,
 * with no double write.
 *
 * Safe from the network layer in a way stream repair is not: umid and
 * event documents are append-only and keyed by umid, so no transaction
 * ever rewrites one and there is nothing to race. That is exactly the
 * argument interagent gives for why it must NOT repair streams from
 * outside the Locker protocol, and it does not apply here.
 *
 * @static
 * @param {SyncContext} ctx
 * @param {string} umid
 * @returns {Promise<boolean>} true if the umid is now present locally
 */
export async function backfillUmid(
  ctx: SyncContext,
  umid: string
): Promise<boolean> {
  if (!umid) {
    return false;
  }

  // Already have the umid? Still replay its events before returning.
  //
  // Holding the umid does NOT imply holding its events: they are separate
  // documents written by separate paths, and EventEngine.emit() is
  // fire-and-forget, so an event write can fail silently while the umid
  // lands. An earlier version of this returned here, and a node was
  // observed holding umid=true with events=0/1 - correct history, empty
  // feed, and no error anywhere to say so.
  //
  // Safe to repeat, because each event keeps its original _id, so this is
  // idempotent by construction. That is also what makes running both this
  // and restore over the same 950 harmless.
  try {
    const local = await ctx.store.get(`${umid}:umid`);
    if (local && local._id) {
      await replaySpiEvents(ctx, local);
      return true;
    }
  } catch {
    // Not found is the normal path here
  }

  let responses: any[];
  try {
    responses = await ctx.peers.umid(umid);
  } catch {
    ActiveLogger.warn(`SPI UMID ${umid} - could not reach the network`);
    return false;
  }

  // Group identical answers and take the most supported, rather than
  // trusting whichever node replied first. Hashing the whole document
  // means two nodes only agree if they agree on the events too.
  const grouped: { [hash: string]: { count: number; doc: any } } = {};
  for (let i = responses.length; i--; ) {
    const response = responses[i];
    if (!response?.umid?.$umid) {
      continue;
    }
    const hash = ActiveCrypto.Hash.getHash(JSON.stringify(response));
    grouped[hash]
      ? grouped[hash].count++
      : (grouped[hash] = { count: 1, doc: response });
  }

  const hashes = Object.keys(grouped);
  if (!hashes.length) {
    ActiveLogger.warn(`SPI UMID ${umid} - no node could supply it`);
    return false;
  }

  const winner =
    grouped[hashes.sort((a, b) => grouped[b].count - grouped[a].count)[0]].doc;

  try {
    // new_edits:false only ever ADDS a document we do not have, keeping
    // the network's revision. It cannot overwrite anything.
    const written = await ctx.store.bulkDocs([winner], {
      new_edits: false,
    });
    if (bulkWriteFailed(written)) {
      ActiveLogger.error(`SPI UMID ${umid} - write failed, left for restore`);
      return false;
    }
  } catch (error) {
    ActiveLogger.error(error, `SPI UMID ${umid} - write threw, left for restore`);
    return false;
  }

  ActiveLogger.warn(`SPI UMID ADDED ${umid}`);
  await replaySpiEvents(ctx, winner);
  return true;
}

/**
 * Replay the events a backfilled umid carried.
 *
 * Reuses each event's original _id rather than minting a new one, so a
 * second attempt is idempotent and a subscriber tracking Last-Event-ID
 * sees the same identity a node that ran the transaction itself would
 * have produced.
 *
 * One event failing must not cost the others or the umid - the umid is
 * already written by this point, and a missing event is recoverable
 * where a lost umid is not.
 *
 * @private
 * @static
 */
export async function replaySpiEvents(
  ctx: SyncContext,
  umidDoc: any
): Promise<void> {
  const events = umidDoc?.events;
  if (!Array.isArray(events) || !events.length) {
    return;
  }

  await Promise.all(
    events.map(async (event: any) => {
      try {
        await ctx.events.post(event);
      } catch (error) {
        ActiveLogger.error(
          error,
          `SPI UMID ${umidDoc?.umid?.$umid} - failed to replay event ${event?._id}`
        );
      }
    })
  );
  ActiveLogger.warn(
    `SPI UMID ${umidDoc?.umid?.$umid} - replayed ${events.length} event(s)`
  );
}

/**
 * Recover every umid a stream is missing, by walking its history
 * backwards.
 *
 * SPI can adopt a stream's current revision, but that leaves a node with
 * correct state and no record of how it got there - no umids, and none
 * of the events those transactions raised. backfillUmid() fixes the most
 * recent one, because the :stream meta names it. Everything before that
 * was unreachable: nothing could enumerate what had been skipped.
 *
 * It can now, because each umid records what it replaced. refStreams
 * .updated carries `prev` per stream - the umid that transaction
 * superseded - so the history is a linked list walked one hop at a time:
 *
 *   :stream meta  ->  umid U0  --prev-->  U1  --prev-->  U2  ...
 *
 * The alternative was a list of transactions per stream, which is what
 * meta.txs was and why it was abandoned: it grew without limit on any
 * busy stream. A backward pointer is one field per stream per
 * transaction whatever the history length, and this walk fetches only
 * the hops actually missing rather than scanning a global index and
 * discarding almost all of it.
 *
 * Stops at the first umid already held (the common case is one or two
 * hops), at a creation, at a broken chain, or at UMID_WALK_LIMIT.
 *
 * @static
 * @param {SyncContext} ctx
 * @param {string} streamId the stream being repaired
 * @param {string} fromUmid the network's current umid for that stream
 * @returns {Promise<{ recovered: string[]; stoppedAt: string }>}
 */
export async function walkUmidHistory(
  ctx: SyncContext,
  streamId: string,
  fromUmid: string
): Promise<{
  recovered: string[];
  stoppedAt: string;
  /**
   * True when the walk ran out of history to recover rather than out of
   * road - it reached a umid already held, or the creation of the stream.
   * Anything else left history behind, and the caller has to decide what
   * to do about that. Returned as a flag rather than left for the caller
   * to match on stoppedAt's prose, which is written for humans.
   */
  complete: boolean;
  /** The umid it could not get past, when it did not finish. */
  frontier?: string;
}> {
  const walkLimit = ctx.walkLimit ?? UMID_WALK_LIMIT;
  const hopDelayMs = ctx.hopDelayMs ?? UMID_WALK_HOP_DELAY_MS;
  const recovered: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = fromUmid;

  while (cursor) {
    if (seen.has(cursor)) {
      // A chain should never loop. If one does, stop rather than spin -
      // and say so, because it means something upstream is wrong.
      return { recovered, stoppedAt: "loop detected", complete: false, frontier: cursor };
    }
    seen.add(cursor);

    if (recovered.length >= walkLimit) {
      ActiveLogger.warn(
        `SPI WALK ${streamId} - stopped at ${walkLimit}, a full restore is the right tool from here`
      );
      return { recovered, stoppedAt: "limit reached", complete: false, frontier: cursor };
    }

    // Do we already have it? Everything before it is here too, because a
    // node only gains umids by walking this same chain or by committing
    // in order - so this is where the walk stops, and it is what keeps
    // the common case cheap.
    let held = false;
    try {
      const local = await ctx.store.get(`${cursor}:umid`);
      held = !!(local && local._id);
    } catch {
      held = false;
    }

    if (held && ctx.continuePastHeld) {
      let local: any;
      try {
        local = await ctx.store.get(`${cursor}:umid`);
      } catch {
        return { recovered, stoppedAt: "held umid could not be read", complete: false, frontier: cursor };
      }
      cursor = previousUmidFor(local, streamId);
      continue;
    }

    // Call backfillUmid even when held, and stop afterwards rather than
    // before. Holding the umid does NOT imply holding its events - they
    // are separate documents and EventEngine.emit() is fire-and-forget,
    // so an event can be missing under a umid that is present. An earlier
    // version of this returned on `held` without calling through, which
    // silently removed the replay that ran before the walk existed.
    // Replaying is idempotent (events keep their original _id), so the
    // one extra pass at the terminus costs nothing but closes that hole.
    const ok = await backfillUmid(ctx, cursor);
    if (!ok) {
      return { recovered, stoppedAt: `could not recover ${cursor}`, complete: false, frontier: cursor };
    }
    if (held) {
      return { recovered, stoppedAt: "reached a umid already held", complete: true };
    }
    recovered.push(cursor);

    // Read the hop we just adopted to find the one before it.
    let doc: any;
    try {
      doc = await ctx.store.get(`${cursor}:umid`);
    } catch {
      return { recovered, stoppedAt: "adopted umid could not be read back", complete: false, frontier: cursor };
    }

    cursor = previousUmidFor(doc, streamId);

    // Deliberately after a successful hop, not before the first one: a
    // walk with nothing to do costs nothing at all, and the common case
    // is exactly that.
    if (cursor) {
      await new Promise((resolve) =>
        setTimeout(resolve, hopDelayMs)
      );
    }
  }

  return { recovered, stoppedAt: "start of stream", complete: true };
}
