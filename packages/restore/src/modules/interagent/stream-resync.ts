/*
 * MIT License (MIT)
 * Copyright (c) 2019 Activeledger
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
import { Provider } from "../provider/provider";
import { Helper } from "../helper/helper";

/**
 * A document as returned by another node's /a/stream endpoint
 */
export interface IResyncDocument {
  _id: string;
  _rev: string;
  [key: string]: unknown;
}

/**
 * Recover a stream this node holds at the wrong revision, by adopting the
 * revision the rest of the network agrees on.
 *
 * This is the fallback for the one case the rest of ActiveRestore cannot
 * handle. The interagent's only repair is insertUmid(): fetch the missing
 * :umid (transaction) document from a peer and replay its events. That
 * works when this node simply never recorded a transaction, but it is the
 * wrong tool for a node that MISSED a committed update to a stream:
 *
 *  - the umid record only exists on nodes that committed, and when the
 *    error document was raised by network/endpoints.ts's own SPI check it
 *    carries an empty $tx anyway, so there is nothing to replay even on a
 *    successful fetch;
 *  - so the fetch fails, the error document is marked processed and
 *    purged, and the stale stream is never looked at.
 *
 * The node is then permanently one revision behind on that stream. Because
 * the pre-execution position check in protocol/permissionsChecker.ts
 * compares meta._rev + ":" + state._rev against the transaction's $revs,
 * it votes "Stream Position Incorrect" on every subsequent transaction
 * touching that stream, forever, and nothing corrects it.
 *
 * Adopting by stream id (rather than replaying by umid) is what network's
 * SPI path already does for the live case; this is the same decision made
 * after the fact.
 */
export class StreamResync {
  /**
   * Collect the stream ids a transaction touched, from its inputs and
   * outputs, in the same way network/endpoints.ts's labelOrKey() does -
   * an entry is either keyed by its stream id, or labelled with the id in
   * $stream.
   *
   * @static
   * @param {*} transaction
   * @returns {string[]}
   */
  public static streamIdsFromTransaction(transaction: any): string[] {
    const seen: { [id: string]: boolean } = {};
    const ids: string[] = [];

    const add = (id: string) => {
      if (!seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    };

    const sides = [transaction?.$tx?.$i, transaction?.$tx?.$o];
    for (let side = sides.length; side--; ) {
      const io = sides[side] || {};
      const keys = Object.keys(io);

      for (let i = keys.length; i--; ) {
        const entry = io[keys[i]];
        const raw =
          (entry && typeof entry === "object" && entry.$stream) || keys[i];

        if (typeof raw !== "string") {
          continue;
        }

        // Ids can carry a namespace prefix; the stream id is the last 64
        // characters. Anything that isn't a full id (a bare label with no
        // $stream, for instance) cannot be looked up so is dropped.
        const id = raw.length > 64 ? raw.slice(-64) : raw;
        if (id.length === 64) {
          add(id);
          // The state document and its meta document diverge together and
          // must be repaired together.
          add(`${id}:stream`);
        }
      }
    }

    return ids;
  }

  /**
   * Given each node's response, decide which revision of each document the
   * network agrees on. A revision wins only if it independently meets
   * consensus; where two revisions somehow tie, the higher ledger position
   * wins, matching network/endpoints.ts's SPI tie-break.
   *
   * @static
   * @param {unknown[]} networkStreams
   * @returns {{ [id: string]: IResyncDocument }}
   */
  public static winningDocuments(networkStreams: unknown[]): {
    [id: string]: IResyncDocument;
  } {
    const tally: {
      [id: string]: { [rev: string]: { votes: number; doc: IResyncDocument } };
    } = {};

    for (let i = networkStreams.length; i--; ) {
      const nodeStreams = networkStreams[i];
      // A node that failed to answer resolves to { error: true }, not an
      // array - it gets no vote rather than counting as a disagreement.
      if (!Array.isArray(nodeStreams)) {
        continue;
      }

      for (let ii = nodeStreams.length; ii--; ) {
        const doc = nodeStreams[ii] as IResyncDocument;
        if (!doc || !doc._id || !doc._rev) {
          continue;
        }

        if (!tally[doc._id]) {
          tally[doc._id] = {};
        }

        tally[doc._id][doc._rev]
          ? tally[doc._id][doc._rev].votes++
          : (tally[doc._id][doc._rev] = { votes: 1, doc });
      }
    }

    const winners: { [id: string]: IResyncDocument } = {};
    const ids = Object.keys(tally);

    for (let i = ids.length; i--; ) {
      let winner: { votes: number; doc: IResyncDocument } | null = null;
      let forked = false;

      const revisions = Object.keys(tally[ids[i]]);
      for (let r = revisions.length; r--; ) {
        const candidate = tally[ids[i]][revisions[r]];

        if (!Helper.metConsensus(candidate.votes)) {
          continue;
        }

        if (
          !winner ||
          candidate.votes > winner.votes ||
          (candidate.votes === winner.votes &&
            StreamResync.position(candidate.doc._rev) >
              StreamResync.position(winner.doc._rev))
        ) {
          winner = candidate;
        } else if (
          winner &&
          candidate.votes === winner.votes &&
          candidate.doc._rev !== winner.doc._rev &&
          StreamResync.position(candidate.doc._rev) ===
            StreamResync.position(winner.doc._rev)
        ) {
          // Two revisions with equal support at the same position is a
          // fork, not a lag: each side committed something the other did
          // not, at the same point in the stream's history. Adopting
          // either silently destroys the other's transaction, and content
          // addressed revisions give nothing to choose between them on.
          forked = true;
        }
      }

      if (forked) {
        ActiveLogger.error(
          `Stream resync: ${ids[i]} has forked - two revisions at the same position. This needs a human, not a vote.`
        );
      } else if (winner) {
        winners[ids[i]] = winner.doc;
      }
    }

    return winners;
  }

  /**
   * Ledger position from a revision string ("39-<md5>" -> 39)
   *
   * @static
   * @param {string} rev
   * @returns {number}
   */
  public static position(rev: string): number {
    const position = parseInt((rev || "").split("-")[0], 10);
    return isNaN(position) ? 0 : position;
  }

  /**
   * Fetch the network's view of every stream a failed transaction touched
   * and adopt any revision this node is behind on.
   *
   * `incomplete` is the caller's signal to try again later rather than to
   * give up: it means some node could not report on a stream, so no
   * decision was safe to make this time. That is the normal state while
   * the transaction that caused the divergence is still in flight, since
   * it holds a lock on the very streams being arbitrated.
   *
   * @static
   * @param {*} transaction
   * @returns {Promise<{ rewrote: number; incomplete: boolean }>}
   */
  public static async resync(
    transaction: any
  ): Promise<{ rewrote: number; incomplete: boolean }> {
    const streams = StreamResync.streamIdsFromTransaction(transaction);

    if (!streams.length) {
      Helper.output("Stream resync: transaction names no streams");
      return { rewrote: 0, incomplete: false };
    }

    const networkStreams = await Provider.network.neighbourhood.knockAll(
      "stream",
      { $streams: streams },
      true
    );

    const winners = StreamResync.winningDocuments(networkStreams);
    const ids = Object.keys(winners);
    let rewrote = 0;

    for (let i = ids.length; i--; ) {
      try {
        if (await StreamResync.adopt(ids[i], winners[ids[i]])) {
          rewrote++;
        }
      } catch (error) {
        ActiveLogger.error(error, `Stream resync failed for ${ids[i]}`);
      }
    }

    // Any stream we asked about but could not decide is worth coming back
    // for. Silence from a node is not a verdict.
    let incomplete = false;
    for (let i = streams.length; i--; ) {
      if (!winners[streams[i]]) {
        incomplete = true;
        ActiveLogger.warn(
          `Stream resync: no decision for ${streams[i]} yet, will retry`
        );
        break;
      }
    }

    return { rewrote, incomplete };
  }

  /**
   * Write one agreed document over this node's copy, if this node's copy
   * is actually behind it.
   *
   * @private
   * @static
   * @param {string} id
   * @param {IResyncDocument} doc
   * @returns {Promise<boolean>} whether a write happened
   */
  private static async adopt(
    id: string,
    doc: IResyncDocument
  ): Promise<boolean> {
    let local: { _rev?: string } | null = null;

    try {
      local = await Provider.database.get(id);
    } catch {
      local = null;
    }

    // Already in agreement
    if (local && local._rev === doc._rev) {
      return false;
    }

    // Missing entirely. new_edits:false is the only mode that keeps the
    // network's revision on a create - new_edits:true would mint a fresh
    // "1-<md5>" and leave this node claiming position 1.
    if (!local || !local._rev) {
      ActiveLogger.warn(`Stream resync: creating ${id} @ ${doc._rev}`);
      await Provider.database.bulkDocs([doc], { new_edits: false });
      return true;
    }

    // Never move a stream backwards. If this node is AHEAD of what the
    // rest of the network agrees on, that is a different fault and one
    // that silently discarding local state would make unrecoverable -
    // report it and leave it for a human.
    if (StreamResync.position(local._rev) >= StreamResync.position(doc._rev)) {
      ActiveLogger.error(
        `Stream resync: refusing to move ${id} back from ${local._rev} to ${doc._rev}`
      );
      return false;
    }

    // Present but behind. new_edits:true + force_rev is the only
    // combination levelme allows to overwrite a divergent document -
    // new_edits:false throws "Revision Mismatch" and aborts.
    ActiveLogger.warn(
      `Stream resync: ${id} local ${local._rev} -> network ${doc._rev}`
    );
    await Provider.database.bulkDocs([doc], {
      new_edits: true,
      force_rev: doc._rev,
    });

    return true;
  }
}
