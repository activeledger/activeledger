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

// Method is copied around a lot need to normalise this.
// Just updated to filter out labled selfsign which should fix the SPI
// process instead of getting "unknown" errors
/**
 * Decides whether the origin node should run the expensive SPI recovery
 * lookup, given the errors the network returned for a transaction it
 * originated. Only genuine "Stream Position Incorrect" disagreement is a
 * signal this node might be desynced - any other error (e.g. a real
 * "Deterministic Stream Name Exists" collision) is an outcome we already
 * know and gains nothing from a lookup.
 *
 * requiring spiErrorCount > 0 matters: with a small errors.length (1 or
 * 2, common when not every node's response has come back yet)
 * Math.floor(length / 3) is 0, so "0 >= 0" used to be trivially true for
 * ANY error type - sending totally unrelated terminal errors through the
 * lookup for nothing, every time.
 *
 * A second, previously-hidden bug lived in the "am I the only one
 * that's wrong" check: `selfError?.indexOf(...) !== -1` evaluates to
 * `true` whenever selfError is undefined (optional chaining short-
 * circuits to undefined, and undefined !== -1) - so the lookup used to
 * trigger essentially every time the origin node itself had no error at
 * all, i.e. whenever it voted/committed fine while other nodes
 * disagreed - the single most common shape of a consensus failure. Only
 * ever treat a real "Stream Position Incorrect" match on selfError as a
 * trigger.
 *
 * @private
 * @static
 */
/**
 * Did a bulk write actually land?
 *
 * A repair that silently didn't happen is worse than one that fails
 * loudly, and every layer here reports failure differently:
 *
 *  - LevelMe.bulkDocs() returns false when its batch write throws (a
 *    full disk, for instance) rather than rejecting, and the self hosted
 *    HTTP layer turns that into { ok: false } with a 200 status;
 *  - ActiveRequest.send() resolves { data: null } for every transport
 *    fault, so a node that could not be reached at all also looks like a
 *    successful call;
 *  - an exception inside the store arrives as {}, because httpd
 *    serialises the Error for its 500 and ActiveRequest ignores status.
 *
 * So only { ok: true } is a write.
 *
 * @static
 * @param {*} response
 * @returns {boolean}
 */
/**
 * Should this node pull the network's revision over its own?
 *
 * Called on a node whose own vote failed with a position error or a
 * missing stream, to decide whether to run the SPI lookup that adopts
 * the majority revision. It says yes when some node did commit (so
 * there is a newer agreed state to catch up to), or when this node is
 * itself one of the nodes reporting a position error.
 *
 * The error test used to read `error?.indexOf(...) !== -1`, which is
 * true for a node with NO error at all (undefined !== -1), so every
 * healthy node was counted as disagreeing and a healthy local node set
 * the "it's me that's wrong" flag. That made the decision independent
 * of what the nodes actually reported.
 *
 * @static
 * @param {*} nodes
 * @param {string} homeReference
 * @param {boolean} spiError
 * @param {boolean} spi404Error
 * @returns {boolean}
 */
/**
 * Decide, per stream, which revision the network agrees on.
 *
 * Shared by both SPI paths, which carried two copies of this tally.
 *
 * The threshold is a count of votes, but the sample it is measured
 * against is whatever came back - so a stream that some nodes could not
 * report on is judged on the few responses that did arrive. A node
 * answers with silence for any stream it holds under a transaction
 * lock, and the streams SPI arbitrates are exactly the ones the
 * triggering transaction declared, so a short sample here is ordinary
 * rather than exotic. When it happens, a minority revision - including
 * the asking node's own stale one - can carry the vote. The winner then
 * equals what this node already holds, so nothing is rewritten, nothing
 * is logged, and the node stays behind while SPI reports success.
 *
 * The first fix for that abstained whenever ANY node could not report.
 * That was too blunt in both directions. On a hot stream some node is
 * nearly always mid-transaction, so streams every node held identically
 * still logged NOWINNER on every round - 218 times in two hours on one
 * production stream, about a copy nothing disagreed about. And the same
 * veto is why a genuinely diverged busy stream never healed: the one
 * condition that has to clear for repair to happen is the condition
 * traffic guarantees will not.
 *
 * The rule now is that silence does not vote and does not veto. A
 * revision must clear consensusReached AND be held by more nodes than
 * could not report, so nothing the unseen nodes hold could overturn it.
 * Three agreeing with one silent is decided; two agreeing with two
 * silent is not, because if both silent nodes disagreed the real picture
 * would be a 2-2 split, which is a fork and needs a human.
 *
 * Every vote counted still comes from a node that is provably not
 * moving, so a partial sample never puts an unstable revision into the
 * tally - only a smaller one. Abstaining leaves the node out of date for
 * now and it will try again on the next transaction, which is
 * recoverable; acting on a sample that could be overturned is not.
 *
 * @static
 * @param {any[]} networkStreams one entry per node, as knockAll returns
 * @param {number} consensusReached votes needed to carry a revision
 * @returns {{ winners: ..., abstained: ... }}
 */
export function spiConsensus(
  networkStreams: any[],
  consensusReached: number
): {
  winners: { [id: string]: { rev: string; votes: number; doc: any } };
  abstained: { [id: string]: string };
} {
  const tally: {
    [id: string]: { [rev: string]: { votes: number; doc: any } };
  } = {};
  // Nodes that hold the stream but could not report it this round
  const unreported: { [id: string]: number } = {};

  for (let i = networkStreams.length; i--; ) {
    const nodeStreams = networkStreams[i];
    // A node that failed to answer at all resolves to { error: true }
    if (!nodeStreams || !nodeStreams.length) {
      continue;
    }

    // One vote per node per stream. A node answers with a flat array
    // built from the requested id list, so anything that puts an id in
    // that list twice - or any future caller that does - would have had
    // a single node's answer counted twice and could carry a revision
    // on its own.
    const voted: { [id: string]: boolean } = {};

    for (let ii = nodeStreams.length; ii--; ) {
      const streamDoc = nodeStreams[ii];
      if (!streamDoc || !streamDoc._id) {
        continue;
      }

      if (streamDoc.locked) {
        if (!voted[streamDoc._id]) {
          voted[streamDoc._id] = true;
          unreported[streamDoc._id] = (unreported[streamDoc._id] || 0) + 1;
        }
        continue;
      }

      if (!streamDoc._rev || voted[streamDoc._id]) {
        continue;
      }
      voted[streamDoc._id] = true;

      if (!tally[streamDoc._id]) {
        tally[streamDoc._id] = {};
      }
      tally[streamDoc._id][streamDoc._rev]
        ? tally[streamDoc._id][streamDoc._rev].votes++
        : (tally[streamDoc._id][streamDoc._rev] = {
            votes: 1,
            doc: streamDoc,
          });
    }
  }

  const winners: {
    [id: string]: { rev: string; votes: number; doc: any };
  } = {};
  const abstained: { [id: string]: string } = {};

  // Every id anyone mentioned, reported or not
  const ids = Object.keys(tally);
  const lockedIds = Object.keys(unreported);
  for (let i = lockedIds.length; i--; ) {
    if (ids.indexOf(lockedIds[i]) === -1) {
      ids.push(lockedIds[i]);
    }
  }

  for (let g = ids.length; g--; ) {
    const id = ids[g];

    // A node that could not report does not vote - but it does not get to
    // veto the ones that could, either.
    //
    // This used to abstain the whole stream the moment ANY node answered
    // with the locked marker, however many others had agreed. On a hot
    // stream some node is nearly always mid-transaction, so a stream that
    // all four nodes held byte-identically still logged NOWINNER on every
    // single round - 218 times in two hours on one production stream,
    // against a copy nothing disagreed about. Worse, the same veto is why
    // a genuinely diverged busy stream never healed: the one condition
    // that has to clear for repair to happen is the condition traffic
    // guarantees will not.
    //
    // Every vote still comes from a node that is provably not moving, so
    // nothing unstable enters the tally. The only change is that silence
    // now counts as absence rather than as an objection, which is what
    // consensusReached already exists to handle. If the nodes that could
    // answer do not reach it between them, this still abstains.
    const silent = unreported[id] || 0;

    const revisions = tally[id] || {};
    let winner = "";
    let max = 0;
    let forked = false;

    const candidates = Object.keys(revisions);
    for (let x = candidates.length; x--; ) {
      const rev = candidates[x];
      if (revisions[rev].votes < consensusReached) {
        continue;
      }

      if (revisions[rev].votes > max) {
        max = revisions[rev].votes;
        winner = rev;
      } else if (revisions[rev].votes === max) {
        // Same support. A later position means the other side simply
        // applied something this one has not yet - adopting it loses
        // nothing, because the lagging copy has no history of its own.
        if (revPosition(rev) > revPosition(winner)) {
          winner = rev;
        } else if (
          revPosition(rev) === revPosition(winner) &&
          rev !== winner
        ) {
          // Same position, different content: not a lag, a genuine fork.
          // Each side committed something the other did not, at the same
          // point in the stream's history, so whichever is picked
          // silently destroys the other's transaction. Revisions are
          // content addressed (position-md5), so there is nothing here
          // to tell them apart on merit and no safe automatic answer.
          forked = true;
        }
      }
    }

    if (forked) {
      abstained[id] =
        "forked - two revisions at the same position, needs a human";
    } else if (winner && max <= silent) {
      // Enough nodes agreed to clear the threshold, but not enough to
      // outnumber the ones that said nothing. Silence is not evidence
      // either way, and a rewrite is destructive - force_rev overwrites
      // whatever is here - so a winner that could be overturned by the
      // nodes we could not see is not a winner worth acting on.
      //
      // Two agreeing with two silent is the case this catches: if both
      // silent nodes hold something else the real picture is a 2-2 split,
      // which is a fork and needs a human, not a coin toss. Three
      // agreeing with one silent is decided, because nothing the silent
      // node holds can change the answer.
      abstained[id] = `inconclusive - ${max} agreed on ${winner} but ${silent} node(s) could not report`;
    } else if (winner) {
      winners[id] = { rev: winner, votes: max, doc: revisions[winner].doc };
    } else if (silent) {
      abstained[id] = `no revision reached consensus, ${silent} node(s) could not report`;
    } else {
      abstained[id] = "no revision reached consensus";
    }
  }

  return { winners, abstained };
}

export function bulkWriteFailed(response: any): boolean {
  // Only the store's own confirmation counts. An exception inside the
  // store reaches us as {} - httpd serialises the Error, and
  // ActiveRequest does not look at the 500 status - and that used to
  // read as a repair that landed.
  return response?.ok !== true;
}

export function shouldTriggerSpiLookup(
  errors: string[] | undefined,
  selfError?: string
): boolean {
  const spiErrorCount =
    errors?.filter((e) => e.indexOf("Stream Position Incorrect") !== -1)
      .length || 0;
  return (
    // Other nodes telling me I am wrong (as I am origin) - the majority
    // disagreed
    (spiErrorCount > 0 &&
      spiErrorCount >= Math.floor((errors?.length || 0) / 3)) ||
    // However what about I am the only one that is wrong (As they may send via me)
    (selfError !== undefined &&
      selfError.indexOf("Stream Position Incorrect") !== -1)
  );
}

/**
 * The umid a given umid document replaced, for one stream.
 *
 * Reads refStreams.updated, matching on the stream id. A creation lives
 * in refStreams.new and carries no prev, which is what makes the start of
 * a stream a natural terminator.
 *
 * @private
 * @static
 */
export function previousUmidFor(
  umidDoc: any,
  streamId: string
): string | undefined {
  const updated = umidDoc?.streams?.updated;
  if (!Array.isArray(updated)) {
    return undefined;
  }
  for (const entry of updated) {
    if (!entry) continue;
    // Ids may carry a virtual prefix depending on where they were built.
    const id: string = entry.id || "";
    if (id === streamId || id.endsWith(streamId) || streamId.endsWith(id)) {
      return entry.prev || undefined;
    }
  }
  return undefined;
}


/**
 * Ledger position from a revision string ("39-<md5>" -> 39)
 */
export function revPosition(rev: string): number {
  const position = parseInt((rev || "").split("-")[0], 10);
  return isNaN(position) ? 0 : position;
}
