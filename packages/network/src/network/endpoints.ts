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

import {
  ActiveOptions,
  ActiveDSConnect,
  ActiveGZip,
  ActiveCacheManager,
} from "@activeledger/activeoptions";
import { ActiveClone } from "@activeledger/activeutilities";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Host } from "./host";
import { Home } from "./home";
import { Maintain } from "./maintain";
import { IStreams } from "@activeledger/activedefinitions/lib/definitions";
import { Locker } from "./locker";

const MAX_COUNTERS = 10;

/**
 * Endpoints used to manage Network Neighbourhood
 * TODO convert host.Knock to local calls.
 *
 * @export
 * @class Endpoints
 */
export class Endpoints {
  /**
   * Control how oftern to rebase
   *
   * @static
   * @type {number}
   */
  public static rebaseThrottle: number = 0;

  /**
   * Handles all external requests being submitted into the network
   * This means we can validate & verify and rate limit on only 1 exposed endpoint
   * This endpoint accepts url and body requests. Url is recommended for just http logging
   *
   * @static
   * @param {Host} host
   * @param {*} body
   * @returns {Promise<any>}
   */
  public static ExternalInitalise(
    host: Host,
    body: any,
    ip: string,
    db: ActiveDSConnect
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      // Inline var function as a temp implemtnation of batching
      const process = (body: any) => {
        return new Promise(async (resolve, reject) => {
          // Check Transaction (Basic Validation Tests)
          if (body && ActiveDefinitions.LedgerTypeChecks.isEntry(body)) {
            let tx = body as ActiveDefinitions.LedgerEntry;
            const now = new Date();

            if (tx.$datetime) {
              this.successfulFailure(`$datetime cannot be preset`);
            }

            // Check transaction hasn't expired
            if (tx.$tx.$expire) {
              if (new Date(tx.$tx.$expire) <= now) {
                return resolve(
                  this.successfulFailure(
                    `Transaction Expired : ${tx.$tx.$expire}`
                  )
                );
              } else {
                // Check and return transaction exists in a consensus friendly way
                tx.$umid = ActiveCrypto.Hash.getHash(JSON.stringify(tx));

                if (await db.exists(`${tx.$umid}:umid`)) {
                  // Can you this as its not an internal error to throw
                  return resolve(
                    this.successfulFailure(`Transaction Exists : ${tx.$umid}`)
                  );
                }

                // Now safe to set datetime
                tx.$datetime = now;
              }
            } else {
              // Set Date
              tx.$datetime = now;
              // Set Umid
              tx.$umid = ActiveCrypto.Hash.getHash(JSON.stringify(tx));
            }

            // Make sure $sigs exists
            if (!tx.$sigs) {
              return resolve(this.successfulFailure(`$sigs not found`));
            }

            // Set Origin
            tx.$origin = host.reference;

            // Ip Address sending the transaction
            tx.$remoteAddr = ip;

            // Make broadcast default, Unless single node network
            // if (host.neighbourhood.count() < 4) {
            //   tx.$broadcast = false;
            // } else if (!tx.$territoriality && !tx.$broadcast) {

            // Temp Disabled
            if (!tx.$territoriality && !tx.$broadcast) {
              tx.$broadcast = true;
            }

            // Default all to broadcast
            // $territoriality temporarily disabled until firewall check added
            //tx.$broadcast = true;

            // Will merge with above for testing here (TODO: Make it work with broadcast)
            // fail to be broadcast if it is unanimous the performance trade off
            // allows for the replay from an SPI fix to be done easier
            // if (tx.$unanimous && tx.$broadcast) {
            //   // Actually on broadcast is better we can delay our response to the network
            //   tx.$broadcast = true;
            // }

            ActiveLogger.debug("Client Sent TX : " + tx.$umid);
            // If we got here everything is ok to send into internal
            // Now sending direct reducing http overhead
            const resendable = (
              initTx: ActiveDefinitions.LedgerEntry,
              counter = 0
            ) => {
              Endpoints.DirectInternalInitalise(host, initTx)
                .then(async (response: any) => {
                  if (response.status == "200" && !response.data?.error) {
                    // Do something with the success response before returning
                    let tx: ActiveDefinitions.LedgerEntry = response.data;

                    if (!tx) {
                      // We got 200 response but no data? (This needs to be solved, we do have inittx we can resend)
                      // Is the problem because counter, then ++? Shouldn't be though
                      // retry!
                      delete (initTx as any).$nodes;
                      delete (initTx as any).$revs;
                      delete (initTx as any).$streams;
                      // Should be seen as a new tx
                      // initTx.$umid = ActiveCrypto.Hash.getHash(
                      //   JSON.stringify(initTx) + counter
                      // );
                      // Keep the same umid will get nodes cached vote response
                      // Otherwise sending as new umid could double transact
                      ActiveLogger.warn(
                        initTx.$tx,
                        `SPI NOTX (Empty Response) Resending ${counter}`
                      );
                      setTimeout(() => {
                        // Unadjusted umid
                        if (!response.dontRelease) {
                          host.release(initTx.$umid);
                        }
                        resendable(initTx, ++counter);
                      }, 50);
                      return;
                    }

                    // Build Summary
                    let summary: ActiveDefinitions.ISummary = {
                      total: 0,
                      vote: 0,
                      commit: 0,
                    };

                    // Any data to send back to the client
                    let responses = [] as any[];

                    // Is something deleting initTx/tx after this explict check
                    if (tx?.$nodes) {
                      // Get nodes to count
                      let nodes = Object.keys(tx.$nodes);
                      for (let i = nodes.length; i--;) {
                        summary.total++;
                        if (tx.$nodes[nodes[i]].vote) summary.vote++;
                        if (tx.$nodes[nodes[i]].commit) summary.commit++;

                        // Manage Errors (Hides node on purpose)
                        if (tx.$nodes[nodes[i]]?.error) {
                          if (summary.errors) {
                            summary.errors.push(
                              tx.$nodes[nodes[i]].error as string
                            );
                          } else {
                            summary.errors = [
                              tx.$nodes[nodes[i]].error as string,
                            ];
                          }
                        }

                        // Did this node have data to send to the client
                        if (tx.$nodes[nodes[i]].return) {
                          responses.push(tx.$nodes[nodes[i]].return);
                        }

                        // Any updated streams we may not know about
                        if (!tx.$streams && tx.$nodes[nodes[i]].streams) {
                          tx.$streams = tx.$nodes[nodes[i]].streams as IStreams;
                        }
                      }

                      if (
                        !summary.commit &&
                        summary.total > 1 &&
                        summary.errors &&
                        counter <= MAX_COUNTERS
                      ) {
                        ActiveLogger.warn(
                          summary,
                          `SPI Checking - Origin Node, Is it wrong? umid: ${tx.$umid}`
                        );
                        if (
                          Endpoints.shouldTriggerSpiLookup(
                            summary.errors,
                            tx.$nodes[Home.reference].error
                          )
                        ) {
                          ActiveLogger.warn(
                            `SPI Checked - Origin Node, Wrong. Starting lookup umid: ${tx.$umid}`
                          );
                          // Now if same i/o going to different nodes it can mix this up
                          // however we need a delay to at least know the record has been written!
                          setTimeout(async () => {
                            let rewroteSomething = false;
                            const streams = [
                              ...new Set([
                                ...this.labelOrKey(tx.$tx.$i),
                                ...this.labelOrKey(tx.$tx.$o),
                              ]),
                            ];

                            // Should probably still wait on locks with priority to hold
                            if (streams.length) {
                              const rewrote = ActiveCacheManager.fetch(
                                "rewrote",
                                1500
                              );

                              // loop and add :stream
                              for (let i = streams.length; i--;) {
                                //if (!rewrote.has(streams[i])) {
                                streams.push(`${streams[i]}:stream`);
                                //} else {
                                // Remove from streams
                                //  streams.splice(i, 1);
                                //}
                              }

                              // Has contract data recently been checked
                              //if (
                              //  !rewrote.has(
                              //    `${tx.$tx.$contract.substring(0, 64)}:data`
                              //  )
                              //) {
                              // and contract:data
                              streams.push(
                                `${tx.$tx.$contract.substring(0, 64)}:data`
                              );
                              //}

                              // Maybe all got spliced away?
                              if (streams.length) {
                                const networkStreams =
                                  await host.neighbourhood.knockAll("stream", {
                                    $streams: streams,
                                    // So a peer holding these under THIS
                                    // transaction can answer properly if it
                                    // has already voted against it
                                    $umid: tx.$umid,
                                  });

                                // Optimise this loop once we know we have 50+% (or config) (TODO - Make static calc)
                                const consensusReached = Math.ceil(
                                  (ActiveOptions.get<any>("consensus", {})
                                    .reached /
                                    100) *
                                  host.neighbourhood.count() -
                                  1 // -1 here if we want to exclude this node
                                );

                                if (networkStreams.length >= consensusReached) {


                                  // One shared, tested tally - see Endpoints.spiConsensus(). It
                                  // abstains on any stream some node could not report, rather than
                                  // deciding it from a partial sample.
                                  const agreed = Endpoints.spiConsensus(
                                    networkStreams,
                                    consensusReached
                                  );

                                  const undecided = Object.keys(agreed.abstained);
                                  for (let a = undecided.length; a--;) {
                                    if (!rewrote.has(undecided[a])) {
                                      ActiveLogger.warn(
                                        `SPI NOWINNER #1 - ${undecided[a]} (${agreed.abstained[undecided[a]]})`
                                      );
                                    }
                                  }

                                  const docs = Object.keys(agreed.winners);
                                  for (let g = docs.length; g--;) {
                                    if (rewrote.has(docs[g])) {
                                      continue;
                                    }

                                    const winningDoc = agreed.winners[docs[g]].doc;
                                    ActiveLogger.warn(
                                      `SPI ${agreed.winners[docs[g]].votes} >= ${consensusReached} for ${docs[g]}@${agreed.winners[docs[g]].rev}`
                                    );

                                    rewrote.set(winningDoc._id, winningDoc._rev);
                                    const dblCheck = await host.dbConnection.get(winningDoc._id);
                                    if (dblCheck._rev !== winningDoc._rev) {
                                      ActiveLogger.error(
                                        `SPI REWRITING #1 ${winningDoc._id} @ ${winningDoc._rev} NOT ${dblCheck._rev} : ${tx.$umid} CACHE : ${rewrote.get(winningDoc._id)}`
                                      );
                                      // bulkDocs resolves false (it does not throw) when the
                                      // underlying batch write fails - a full disk being the obvious
                                      // way. Taking the repair on trust meant the node carried on
                                      // believing it had caught up while still holding the old
                                      // revision, and said nothing.
                                      const written = await host.dbConnection.bulkDocs([winningDoc], {
                                        new_edits: true,
                                        force_rev: winningDoc._rev,
                                      });
                                      if (Endpoints.bulkWriteFailed(written)) {
                                        ActiveLogger.error(
                                          `SPI REWRITE FAILED #1 ${winningDoc._id} @ ${winningDoc._rev} : ${tx.$umid} - this node is still out of date`
                                        );
                                        rewrote.delete(winningDoc._id);
                                      } else {
                                        rewroteSomething = true;
                                      }
                                    }
                                  }

                                  // Shouldn't need to check umid not found 950 error here, As this was the origin node
                                  // and its position indexes were incorrect.

                                  //  need TO ONLY run this if SPI rewrites occured?
                                  // also need to attach orignal umid to reference against! As this is double spend potential
                                  // retry!

                                  if (rewroteSomething) {
                                    delete (initTx as any).$nodes;
                                    delete (initTx as any).$revs;
                                    delete (initTx as any).$streams;
                                    // Adjusted umid, send original, release before we modify shared object
                                    if (!response.dontRelease) {
                                      host.release(initTx.$umid);
                                    }
                                    // Should be seen as a new tx
                                    initTx.$umid = ActiveCrypto.Hash.getHash(
                                      JSON.stringify(initTx) + counter
                                    );
                                    ActiveLogger.warn(
                                      initTx,
                                      `SPI (Rewrite) Resending #1 ${counter}`
                                    );
                                    setTimeout(() => {
                                      resendable(initTx, ++counter);
                                    }, 50);
                                    return;
                                  } else {
                                    // Return to calling client! All ok so release
                                    if (!response.dontRelease) {
                                      host.release(tx.$umid);
                                    }
                                    const output = Endpoints.buildClientResponse(
                                      tx,
                                      summary,
                                      responses
                                    );

                                    ActiveLogger.warn(
                                      output,
                                      `SPI Failed to find an issue returning to client`
                                    );

                                    return resolve({
                                      statusCode: 200,
                                      content: output,
                                    });
                                  }
                                } else {
                                  ActiveLogger.warn(
                                    `SPI Skipped not enough returned for consensus yet (${networkStreams.length}/${consensusReached})`
                                  );
                                  // Maybe retry  somehow? They could be spi lock failures
                                  //
                                  // Releasing as well as responding. The
                                  // sibling branch above does both; this one
                                  // did neither, because it threw before it
                                  // got here - so the transaction's streams
                                  // stayed locked until Locker's three minute
                                  // sweep, on a network already short of
                                  // responding nodes.
                                  if (!response.dontRelease) {
                                    host.release(tx.$umid);
                                  }

                                  return resolve({
                                    statusCode: 200,
                                    content: Endpoints.buildClientResponse(
                                      tx,
                                      summary,
                                      responses
                                    ),
                                  });

                                }
                              }
                            }
                          }, 100);
                          return;
                        } else {
                          if (
                            //counter <= MAX_COUNTERS &&
                            // can probably do this for all nodes
                            summary.errors?.some(
                              (e) =>
                                // TODO can we combine IBL01 to Busy Locks?
                                //e.indexOf("Stream Position Incorrect") !== -1 ||
                                e.indexOf("Busy Locks") !== -1 ||
                                e.indexOf("IBL01") !== -1
                            ) &&
                            !initTx.$nolock
                          ) {
                            // If position incorrect maybe force update check instead of waiting on restore!
                            // This happens because the "middle" node voted for the other one and when this got its turn
                            // from the queue it is now out of date.
                            // We can resend it, But we don't want to keep resending it
                            // Reset as if it was new
                            delete (initTx as any).$nodes;
                            delete (initTx as any).$revs;
                            delete (initTx as any).$streams;
                            // Adjusted umid, send original, release before we modify shared object
                            if (!response.dontRelease) {
                              host.release(initTx.$umid);
                            }
                            initTx.$umid = ActiveCrypto.Hash.getHash(
                              JSON.stringify(initTx) + counter
                            );
                            ActiveLogger.warn(
                              initTx.$tx,
                              `SPI Resending #2 ${counter} in 5s`
                            );
                            setTimeout(() => {
                              resendable(initTx, ++counter);
                            }, 50);
                            return;
                          }
                        }
                      }
                    }

                    // Just release coming to the end
                    if (!response.dontRelease) {
                      host.release(tx.$umid);
                    }

                    // We have the entire network $tx object. This isn't something we want to return
                    return resolve({
                      statusCode: 200,
                      content: Endpoints.buildClientResponse(
                        tx,
                        summary,
                        responses
                      ),
                    });
                  } else {
                    // Release here?
                    // if (!response.dnr) {
                    //   host.release(initTx.$umid);
                    // }
                    // If we had to be rebroadcasted this isn't an error
                    if (response.rebroadcasted) {
                      return resolve({
                        statusCode: 200,
                        content: response.data,
                      });
                    } else {
                      // Just return untouched
                      return resolve({
                        statusCode: response.status,
                        content: response.data,
                      });
                    }
                  }
                })
                .catch((error) => {
                  // Safe to release right now (dnr shouldn't be here to check)
                  host.release(initTx.$umid);
                  if (error?.status == 100 && error.error) {
                    if (
                      counter <= MAX_COUNTERS &&
                      error.error === "Busy Locks" &&
                      !initTx.$nolock
                    ) {
                      // same umid safe here but probably still in memory
                      delete (initTx as any).$nodes;
                      delete (initTx as any).$revs;
                      delete (initTx as any).$streams;
                      initTx.$umid = ActiveCrypto.Hash.getHash(
                        JSON.stringify(initTx) + counter
                      );
                      // As same umid should be safe here lets keep it
                      // Need to resend it in with diff umid, maybe a flag to "delete from memory instead"
                      ActiveLogger.warn(
                        initTx.$tx,
                        `SPI Resending #3 ${counter}`
                      );
                      setTimeout(() => {
                        resendable(initTx, ++counter);
                      }, 250);
                      return;
                    } else {
                      return resolve(
                        this.successfulFailure(error.error || error, 0)
                      );
                    }
                  } else {
                    ActiveLogger.error(error, "Sent 500 Response (1000)");
                    return reject({
                      statusCode: 500,
                      // A raw Error instance JSON.stringifies to "{}" (message/stack
                      // aren't own enumerable properties), so the client would get an
                      // empty body on genuine exceptions even though it's logged fine
                      // above - normalise it to a plain object first.
                      content:
                        error instanceof Error
                          ? { error: error.message }
                          : error,
                    });
                  }
                });
            };
            resendable(tx);
          } else {
            ActiveLogger.error("Sent 500 Response (1200)");
            return reject({
              statusCode: 500,
              content: "Invalid Transaction",
            });
          }
        });
      };

      // Not supporting mutiple transactions yet
      if (body.$multi) {
        // We can either send them all at once or in seq depends on transaction lets default to all at once
        const results = [] as any[];
        if (body.$seq) {
          for (let i = body.$multi.length; i--;) {
            results.push(await process(body.$multi[i]));
            // deal with catch problem
          }
          const response = [];
          for (let i = results.length; i--;) {
            response.push(results[i].content);
          }
          resolve({
            statusCode: 200,
            content: response,
          });
        } else {
          for (let i = body.$multi.length; i--;) {
            results.push(process(body.$multi[i]));
          }
          const results2 = (await Promise.all(results)) as any[];
          const response = [];
          for (let i = results2.length; i--;) {
            response.push(results2[i].content);
          }
          resolve({
            statusCode: 200,
            content: response,
          });
        }
      } else {
        // Single normal tx process here for now
        process(body).then(resolve).catch(reject);
      }
    });
  }

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
   *  - CouchDB answers _bulk_docs with an array of per document results,
   *    where a rejected document carries an "error" property.
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
  public static spiConsensus(
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
          if (Endpoints.revPosition(rev) > Endpoints.revPosition(winner)) {
            winner = rev;
          } else if (
            Endpoints.revPosition(rev) === Endpoints.revPosition(winner) &&
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

  /**
   * Ledger position from a revision string ("39-<md5>" -> 39)
   *
   * @static
   * @param {string} rev
   * @returns {number}
   */
  public static revPosition(rev: string): number {
    const position = parseInt((rev || "").split("-")[0], 10);
    return isNaN(position) ? 0 : position;
  }

  /**
   * The response a client gets back for a finished transaction.
   *
   * Built in one place because it was built in three, and one of them
   * referred to a `const output` belonging to a sibling block. The name
   * still resolved - to another `output` declared later in an enclosing
   * scope - so TypeScript said nothing and the branch threw
   * "Cannot access 'output' before initialization" at runtime, from inside
   * a setTimeout callback where the rejection is unhandled: the client's
   * promise never settles and the transaction's locks are never released.
   *
   * @static
   */
  public static buildClientResponse(
    tx: ActiveDefinitions.LedgerEntry,
    summary: ActiveDefinitions.ISummary,
    responses: unknown[]
  ): ActiveDefinitions.LedgerResponse {
    const output: ActiveDefinitions.LedgerResponse = {
      $umid: tx.$umid,
      $summary: summary,
      $streams: tx.$streams,
    };

    if (responses.length) {
      output.$responses = responses;
    }

    if (ActiveOptions.get<boolean>("debugToClient", false)) {
      output.$debug = tx;
    }

    return output;
  }

  public static shouldSelfRepairPosition(
    nodes: any,
    homeReference: string,
    spiError: boolean,
    spi404Error: boolean
  ): boolean {
    // Means 404 most likely so check
    if (!spiError) {
      return spi404Error;
    }

    let posCount = 0;
    let myPos = false;

    const references = Object.keys(nodes || {});
    for (let i = references.length; i--; ) {
      const node = nodes[references[i]] || {};

      // Did they commit at all? Someone has newer state to catch up to
      if (node.commit) {
        return true;
      }

      const nodeError = node.error;
      if (
        typeof nodeError === "string" &&
        nodeError.indexOf("Stream Position Incorrect") !== -1
      ) {
        posCount++;
        if (references[i] === homeReference) {
          myPos = true;
        }
      }
    }

    return posCount >= 1 && myPos;
  }

  public static bulkWriteFailed(response: any): boolean {
    if (response === false || response === null || response === undefined) {
      return true;
    }

    if (Array.isArray(response)) {
      return response.some((result) => result && result.error);
    }

    return response.ok === false;
  }

  public static shouldTriggerSpiLookup(
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

  public static labelOrKey(txIO: any): string[] {
    // Get reference for input or output
    const keys = Object.keys(txIO || {});
    const out: string[] = [];

    for (let i = keys.length; i--;) {
      // Stream label or self
      const addr = this.filterPrefix(txIO[keys[i]].$stream || keys[i]);
      if (addr.length === 64) {
        out.push(addr);
      }
      //out.push(this.filterPrefix(txIO[keys[i]].$stream || keys[i]));
    }
    return out;
  }

  public static filterPrefix(streamId: string): string {
    // If id length more than 64 trim the start
    if (streamId.length > 64) {
      streamId = streamId.slice(-64);
    }

    // Return just the id
    return streamId;
  }

  /**
   * Exposes an endpoint to run through the ADAC encryption
   *
   * @static
   * @param {Host} host
   * @param {*} body
   * @param {boolean} encHeader
   * @param {ActiveDSConnect} db
   * @returns {Promise<any>}
   */
  public static ExternalEncrypt(
    host: Host,
    body: any,
    encHeader: boolean,
    db: ActiveDSConnect
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (encHeader) {
        let secureTx = new ActiveCrypto.Secured(db, host.neighbourhood.get(), {
          reference: Home.reference,
          public: Buffer.from(Home.publicPem, "base64").toString("utf8"),
          private: Home.identity.pem,
        });

        // Walk all properties
        secureTx
          .encrypt(body as any)
          .then((results) => {
            resolve({
              statusCode: 200,
              content: results,
            });
          })
          .catch((error) => {
            ActiveLogger.error(error, "Sent 500 Response (1300)");
            reject({
              statusCode: 500,
              content: error,
            });
          });
      } else {
        ActiveLogger.error("Sent 500 Response (1400)");
        reject({
          statusCode: 500,
          content: "Must be sent over X-Activeledger-Encrypt",
        });
      }
    });
  }

  /**
   * Handle transaction request internally in the ledger. This is how all requests
   * will be submitted into each node's protocol process. Post convertor has already
   * dealt with the validation of the data
   *
   * @static
   * @param {Host} host
   * @param {*} body
   * @returns {Promise<any>}
   */
  public static InternalInitalise(
    host: Host,
    body: any,
    remoteAddr: string,
    retried = false,
    isP2P = false
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Is the network stable?
      // if (host.getStatus() != NeighbourStatus.Stable) {
      //   ActiveLogger.error("Sent 500 Response (1500)");
      //   return resolve({
      //     statusCode: 500,
      //     content: "Network Not Stable",
      //   });
      // }

      // Cast Body
      let tx = body as ActiveDefinitions.LedgerEntry;

      if (!retried) {
        // Make sure we can also SPI retry so clear if previous node retried
        tx.$spiRetry = false;
      }

      // Send into host pool
      host
        .pending(tx, remoteAddr, true, retried, isP2P)
        .then(async (ledger: any) => {
          let canRetry = false;
          let resolved = false;
          // If it isn't $unanimous then we can reply right away
          //if ((!tx.$unanimous && !tx.$broadcast) || retried) {
          if (!tx.$unanimous || retried) {
            resolved = true;
            resolve({
              statusCode: ledger.status,
              content: ledger.data,
            });
          }

          // Runs the risk of breaking the network
          // Maybe go back to restore for this?
          // Only safe to run if we can get a lock
          // downside of not doing this is the node can be out of date for a while
          // we can alkways keep trying to get a lock or for when it ISN't locked
          const rewrote = ActiveCacheManager.fetch("rewrote", 500);

          if (ledger?.data?.$nodes && !rewrote.has(tx.$umid)) {
            // rewrote.set(tx.$umid, 1);
            // Phase 1
            // Now if we have an error position incorrect we should just "fix it" assuming there was a commit
            // Phase 2
            // Then later on we can check against other nodes and if we all agree then no need to process

            // Error hasn't actually passed through here correctly
            // That does need to be traced we could check for vote: false
            // but then that will create a lot of unnessary checks

            // Only checking Stream(s) not found here external init could cause problems with people senfing fakes

            if (
              ledger?.data?.$nodes[Home.reference] &&
              ledger.data.$nodes[Home.reference].error
            ) {
              const spiError =
                ledger.data.$nodes[Home.reference].error.indexOf(
                  "Position Incorrect"
                ) !== -1;
              const spi404Error =
                ledger.data.$nodes[Home.reference].error.indexOf(
                  "Stream(s) not found"
                ) !== -1;

              if (spiError || spi404Error) {
                // Now we know it needed rewriting stop next checks
                rewrote.set(tx.$umid, 1);

                ActiveLogger.warn(
                  tx.$umid,
                  "SPI NON Origin - Position Incorrect or 404"
                );

                // They may not have commited I maybe the only one!
                if (
                  Endpoints.shouldSelfRepairPosition(
                    ledger.data.$nodes,
                    Home.reference,
                    spiError,
                    spi404Error
                  )
                ) {
                  ActiveLogger.warn(tx.$umid, "SPI NON Origin - Must Check");

                  // TODO - Resolve this copy paste
                  //setTimeout(async () => {
                  const streams = [
                    ...new Set([
                      ...this.labelOrKey(ledger.data.$tx.$i),
                      ...this.labelOrKey(ledger.data.$tx.$o),
                    ]),
                  ];

                  if (streams.length) {
                    // The dedup attempt below (rewrote/break) was disabled in favour
                    // of the plain unconditional push further down - the "break isn't
                    // breaking" bug only applied to that disabled approach.
                    //const rewrote: any = {};
                    // const rewrote = CacheManager.fetch("rewrote", 10000);

                    // loop and add :stream
                    for (let i = streams.length; i--;) {
                      // Stop it checking a stream multiple times from different umids
                      //if (!rewrote.has(streams[i])) {
                      streams.push(`${streams[i]}:stream`);
                      //} else {
                      // Remove from streams
                      //  streams.splice(i, 1);
                      //}
                    }

                    // Has contract data recently been checked
                    //if (
                    //  !rewrote.has(
                    //    `${ledger.data.$tx.$contract.substring(0, 64)}:data`
                    //  )
                    //) {
                    // and contract:data
                    streams.push(
                      `${ledger.data.$tx.$contract.substring(0, 64)}:data`
                    );
                    //}

                    if (streams.length) {
                      // Now if the network writes it, we may read to soon
                      // we don't want a big delay will never catch up
                      // we are also not locked at this point either.

                      const tmp = async () => {
                        const networkStreams =
                          await host.neighbourhood.knockAll("stream", {
                            $streams: streams,
                            $umid: tx.$umid,
                          });

                        // Optimise this loop once we know we have 50+% (or config) (TODO - Make static calc)
                        const consensusReached = Math.ceil(
                          (ActiveOptions.get<any>("consensus", {}).reached /
                            100) *
                          host.neighbourhood.count() -
                          1 // -1 here if we want to exclude this node
                        );

                        if (networkStreams.length < consensusReached) {
                          ActiveLogger.warn(
                            `SPI Skipped not enough returned for consensus yet (${networkStreams.length}/${consensusReached})`
                          );
                          // Maybe retry tmp somehow? They could be spi lock failures
                          return;
                        }

                        // now find the ones that match
                        // One shared, tested tally - see Endpoints.spiConsensus(). It
                        // abstains on any stream some node could not report, rather than
                        // deciding it from a partial sample.
                        const agreed = Endpoints.spiConsensus(
                          networkStreams,
                          consensusReached
                        );

                        const undecided = Object.keys(agreed.abstained);
                        for (let a = undecided.length; a--;) {
                          if (!rewrote.has(undecided[a])) {
                            ActiveLogger.warn(
                              `SPI NOWINNER #2 - ${undecided[a]} (${agreed.abstained[undecided[a]]})`
                            );
                          }
                        }

                        const docs = Object.keys(agreed.winners);
                        for (let g = docs.length; g--;) {
                          if (rewrote.has(docs[g])) {
                            continue;
                          }

                          const winningDoc = agreed.winners[docs[g]].doc;
                          ActiveLogger.warn(
                            `SPI ${agreed.winners[docs[g]].votes} >= ${consensusReached} for ${docs[g]}@${agreed.winners[docs[g]].rev}`
                          );

                          // Set umid so we can know to push a 950 error to check
                          rewrote.set(tx.$umid, true);
                          rewrote.set(winningDoc._id, winningDoc._rev);
                          const dblCheck = await host.dbConnection.get(winningDoc._id);
                          if (dblCheck._rev !== winningDoc._rev) {
                            ActiveLogger.error(
                              `SPI REWRITING #2 ${winningDoc._id} @ ${winningDoc._rev} NOT ${dblCheck._rev} : ${tx.$umid} CACHE : ${rewrote.get(winningDoc._id)}`
                            );

                            // if spi404Error, bulkdocs doesn't set the rev, create it first and allow it to fail
                            if (!dblCheck._rev) {
                              try {
                                await host.dbConnection.put(winningDoc);
                                ActiveLogger.warn(`SPI 404 - Create Base for ${winningDoc._id}`);
                              } catch {
                                ActiveLogger.error(`SPI 404 - Failed to create ${winningDoc._id}`);
                              }
                            }

                            // See SPI #1 above - a false return is a failed write, not a
                            // completed repair.
                            const written = await host.dbConnection.bulkDocs([winningDoc], {
                              new_edits: true,
                              force_rev: winningDoc._rev,
                            });
                            if (Endpoints.bulkWriteFailed(written)) {
                              ActiveLogger.error(
                                `SPI REWRITE FAILED #2 ${winningDoc._id} @ ${winningDoc._rev} : ${tx.$umid} - this node is still out of date`
                              );
                              rewrote.delete(winningDoc._id);
                            } else {
                              canRetry = true;
                            }
                          }
                        }

                        // We should also check to see if this failing umid did actually save (Assume only if SPI rewrite is called)
                        // As it wont be saving it and new doc also should do the same. I think even SPI #1 should do this
                        // Don't have access to protocol/shared.ts#storeError
                        if (rewrote.has(tx.$umid)) {
                          ActiveLogger.warn(tx.$umid, `SPI Adding 950 Checker`);
                          // No need to await but help with catching errors flow
                          await host.dbErrorConnection.post({
                            _id: `${tx.$umid}:${Date.now()}`,
                            code: 950,
                            processed: false,
                            umid: tx.$umid,
                            transaction: {
                              $broadcast: true,
                              $tx: {},
                              $revs: {},
                            },
                            reason: 'Vote Failure - "SPI#2 UMID not found',
                          });
                        }
                        // No more changes can release
                        // If running here DNR wouldn't of made it
                        if (!ledger.dontRelease) {
                          host.release(tx.$umid);
                        }

                        // Look into don't release above make sure its purpose valid
                        // At this point (or before actually, where we have winner or not)
                        // send a KnockAll to "unlock" the streams so they can continue processing. (Hence eh longer timeout)
                        
                      };

                      if (resolved) {
                        setTimeout(async () => {
                          ActiveLogger.warn(`SPI WAITING - ${tx.$umid}`);
                          tmp();
                          // This timer is key, If cannot find a good value will need to implement locking and retrying
                        }, 500);
                      } else {
                        ActiveLogger.warn(`SPI NOW - ${tx.$umid}`);
                        await tmp();

                        // should work anyway with non broadcast
                        // if (canRetry && (tx.$unanimous || !tx.$broadcast)) {
                        if (canRetry && tx.$unanimous) {
                          ActiveLogger.warn(
                            tx.$umid,
                            `SPI RETRY as it was unanimous and written`
                          );
                          tx.$spiRetry = true;
                          this.InternalInitalise(host, tx, remoteAddr, true)
                            .then(resolve)
                            .catch(reject);
                        } else {
                          ActiveLogger.warn(tx.$umid, `SPI Delay resolved`);
                          return resolve({
                            statusCode: ledger.status,
                            content: ledger.data,
                          });
                        }
                      }
                    } else {
                      if (!ledger.dontRelease) {
                        host.release(tx.$umid);
                      }
                    }
                  } else {
                    if (!ledger.dontRelease) {
                      host.release(tx.$umid);
                    }
                  }
                  // Faster they're processing without us
                  // Need the delay big files stops the response!
                  //}, 200);
                } else {
                  if (!ledger.dontRelease) {
                    host.release(tx.$umid);
                  }
                }
              } else {
                if (!ledger.dontRelease) {
                  host.release(tx.$umid);
                }
              }
            } else {
              if (!ledger.dontRelease) {
                host.release(tx.$umid);
              }

              // most likely a broadcast empty response
              if (!resolved) {
                resolve({
                  statusCode: ledger.status,
                  content: ledger.data,
                });
              }
            }
          } else {
            if (!ledger.dontRelease) {
              host.release(tx.$umid);
            }
          }
        })
        .catch((error: any) => {
          ActiveLogger.error(tx, "Transaction error");
          ActiveLogger.error(error, "Sent 500 Response (1600)");
          // DNR shouldn't be here
          host.release(tx.$umid);
          return reject({
            statusCode: 500,
            content: error,
          });
        });
    });
  }

  /**
   * Instead of HTTP to internal initalise Activeledger now uses a direct
   * call with a promise wrapper. Other notes still use InternalInitalise
   *
   * @private
   * @static
   * @param {Host} host
   * @param {ActiveDefinitions.LedgerEntry} tx
   * @returns {Promise<any>}
   */
  private static DirectInternalInitalise(
    host: Host,
    tx: ActiveDefinitions.LedgerEntry
  ): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Is the network stable?
      // if (host.getStatus() != NeighbourStatus.Stable)
      //   return reject({
      //     status: 100,
      //     error: "Network Not Stable",
      //   });

      // Targetted territoriality mapper
      if (tx.$territoriality) {
        // Cannot work with broadcast
        if (tx.$broadcast) {
          return reject({
            status: 100,
            error: "Territoriality not supported in broadcast mode",
          });
        }

        // Get the sending node details
        let sending = host.terriMap(tx.$territoriality);

        // Do we know this territory node address
        if (sending) {
          // If not ourselves intercept
          if (sending !== host.reference) {
            ActiveLogger.info("Rebroadcasting to : " + sending);
            // We need to rebroadcast to sending node
            let rebroadcast = host.neighbourhood.get(sending);
            // Send and wait on their response
            rebroadcast
              .knock("", tx, true, 0, false)
              .then((ledger) => {
                // Add rebroadcast flag
                ledger.rebroadcasted = true;
                resolve(ledger);
              })
              .catch((error) => {
                reject(error);
              });
            // Safe to return
            return;
          }
        } else {
          return reject("Unknown territory");
        }
      }

      // Send into host pool
      host
        .pending(tx, Home.host)
        .then((ledger) => resolve(ledger))
        .catch((error) => {
          ActiveLogger.fatal(tx, "last tx sent in");
          ActiveLogger.fatal(error, "error that is bubbling");
          // DNR shouldn't be here
          host.release(tx.$umid);
          reject(error);
        });
    });
  }

  /**
   * Show the status of this host home node and its network
   *
   * @static
   * @param {Host} host
   * @param {string} requester
   * @returns {Promise<any>}
   */
  public static status(host: Host, requester: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // Everyone can see this endpoint, Other Nodes just need 200 for now
      let neighbour = host.neighbourhood.get(requester);
      if (requester != "NA") {
        // Increase Count
        Endpoints.rebaseThrottle++;

        // Is this a live request
        if (neighbour && !neighbour.graceStop) {
          resolve({
            statusCode: 200,
          });
        } else {
          resolve({
            statusCode: 403,
          });
        }

        // When should we rebase
        if (
          Endpoints.rebaseThrottle >
          ActiveOptions.get<number>("rebaseThrottle", 8)
        ) {
          // However we can trigger a "rebase" of the ordering if this comes from a node we think is offline
          Maintain.rebaseNeighbourhood();
          Endpoints.rebaseThrottle = 0;
        }
      } else {
        // Prevent circular (Added since no longer creating new left / right using reference for easy identity)
        // Status shouldn't be called much in comparison
        let neighbourhood = host.neighbourhood.get();
        let keys = host.neighbourhood.keys();
        let i = keys.length;
        let neighbours: { [index: string]: object } = {};

        // Loop and build (reduced output now)
        // Hide Host & Port for now (May enable for authenticated requests)
        while (i--) {
          let neighbour = neighbourhood[keys[i]];
          if (!neighbour.graceStop) {
            neighbours[neighbour.reference] = {
              isHome: neighbour.isHome,
            };
          }
        }

        // Send to browser
        resolve({
          statusCode: 200,
          content: {
            status: host.getStatus(),
            reference: host.reference,
            left: Home.left.reference,
            right: Home.right.reference,
            neighbourhood: {
              neighbours: neighbours,
            },
            pem: Home.publicPem,
          },
        });
      }
    });
  }

  /**
   * Return stream information stored on this node
   *
   * @static
   * @param {ActiveDSConnect} db
   * @param {*} body
   * @returns {Promise<any>}
   */
  public static streams(
    db: ActiveDSConnect,
    body: any,
    host?: Host
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (body.$streams) {
        // Restrict Access to any volatile requests
        // Ids, not promises - they are read together in one call below.
        const fetchStream: string[] = [];

        // Streams this node holds but cannot report on right now
        const unavailable: { _id: string; locked: boolean }[] = [];

        for (let i = body.$streams.length; i--;) {
          // Check that :volatile doesn't exist
          if (body.$streams[i].indexOf(":volatile") !== -1) {
            // End exectuion
            return reject({
              statusCode: 403,
              content: "Request not allowed",
            });
          }

          const holdValue = body.$streams[i].replace(":stream", "");

          // Read only - this endpoint takes no lock of its own.
          //
          // It used to Locker.hold(holdValue, "SPI") for a second per
          // request. host.ts's hold() refuses a transaction if ANY of its
          // streams is already held, by anything, including "SPI" - so a
          // stream that several peers were asking about had a read lock on
          // it more or less continuously, and the transaction that wanted
          // to write it was pushed into the busy-locks queue over and over.
          // Observed on a live network as a contract update running for 30
          // seconds to its TTL, against a background of
          // "Lock busy ... requested by SPI", while SPI was only ever
          // trying to read.
          //
          // Nothing needed the lock. Two nodes reconciling the same stream
          // at once each rewrite their OWN copy to the revision the
          // majority voted for, so the writes are idempotent and cannot
          // race each other.
          // A stream this node is writing cannot be sampled safely, with
          // one exception: the transaction holding it is the SAME one the
          // asking node is running SPI for, AND this node has already voted
          // against it. A node that voted no never reaches commit(), so its
          // copy is not going to move and reading it is safe.
          //
          // That exception is the whole point. A broadcast contract update
          // locks its output stream on every node, so when the origin's own
          // vote fails and it runs SPI, every peer is holding the very
          // stream it needs to ask about - and answers "locked". The origin
          // abstains on a sample its own transaction spoiled, and a node
          // that is the origin of the transaction it is behind on can never
          // heal. With this, the three peers that rejected it answer with
          // their real revision, the origin gets a clean majority, and it
          // corrects itself inside the same failed round.
          //
          // The vote check is not optional. Without it this reads a stream
          // a peer may be committing, and a commit writes the state
          // document and its :stream meta in one batch while SPI fetches
          // them as two requests - so a mid-commit sample can pair
          // state@43 with meta@21. Writing that pair locally makes
          // meta._rev:state._rev permanently wrong, which is a worse fault
          // than the one being fixed and is not repairable by SPI.
          //
          // What actually makes a locked stream safe to report is one
          // thing only: the holder will never write it. A node that voted
          // no never reaches commit(), so its copy cannot move.
          //
          // This used to demand something stricter and unrelated - that
          // the lock be held by the ASKER'S OWN transaction - because that
          // was the case it was written for (a broadcast contract update
          // whose origin lags, where every peer holds the very stream the
          // origin needs to ask about). But whose transaction holds the
          // lock says nothing about whether this node's copy is stable.
          // Two nodes can each be sitting on a rejected transaction for
          // the same stream and both were refusing to answer, for no
          // reason beyond not having been asked by the right umid.
          //
          // So ask the question that carries the safety: whoever holds
          // this lock, have I voted against THEM? Streams held by a
          // transaction this node is still voting on, or has voted yes on
          // and may commit, are refused exactly as before.
          const holder = Locker.holder(holdValue);
          const holderWillNotCommit = !!holder && !!host?.willNotCommit(holder);

          if (Locker.has(holdValue) && !holderWillNotCommit) {
            // Held by a transaction, so this node cannot report the stream
            // right now. Saying nothing is indistinguishable from "I do not
            // have it", and the caller votes on whatever comes back - so
            // the stream is under-reported and a minority revision can
            // carry the vote. Answer with a marker instead. It has no
            // _rev, so an older node's tally ignores it exactly as it
            // ignored the silence.
            //
            // Note this is reachable precisely when it hurts most. Only
            // streams named in $i/$o are locked, so the streams SPI is
            // asked to arbitrate are exactly the ones the triggering
            // transaction declared, and that transaction is still in
            // flight on every node when SPI runs.
            unavailable.push({ _id: body.$streams[i], locked: true });
          } else {
            fetchStream.push(body.$streams[i]);
          }
        }

        if (fetchStream.length) {
          // ONE read for the whole sample, not one per stream.
          //
          // This used to be Promise.all() over a db.get() per id, and db is
          // an HTTP client - so a sample of a stream plus its :stream meta
          // was two independent requests to the data store, concurrent but
          // unordered. A commit lands both documents in a single leveldb
          // batch, so a batch completing between those two responses hands
          // back state@43 paired with meta@21. Writing that pair makes
          // meta._rev:state._rev permanently wrong and SPI cannot repair
          // it - the torn read the lock check above exists to avoid.
          //
          // allDocs({keys}) is one request, and inside the store it is one
          // driver.getMany() over all the keys, which cannot straddle a
          // batch write. It is also N-1 fewer round trips per sample on a
          // path that runs for every transaction that fails its position
          // check.
          //
          // include_docs is set for CouchDB's benefit; LevelMe's keys
          // branch returns the documents either way.
          db.allDocs({ keys: fetchStream, include_docs: true })
            .then((result: any) => {
              // CouchDB and LevelMe both answer { rows: [{ doc }] } here.
              // A key the node does not hold still occupies a row, with no
              // doc - the ._id check below drops those, exactly as the
              // previous code dropped a failed get().
              const docs = (result?.rows || []).map((row: any) => row?.doc).filter(Boolean);
              // Could just pass docs but that will send unnecessary data at this point
              const streams = [];
              for (let i = docs.length; i--;) {
                // Make sure not an error
                if (docs[i]._id) {
                  // streams.push({
                  //   _id: docs[i]._id,
                  //   _rev: docs[i]._rev,
                  // });
                  streams.push(docs[i]);

                  // Problem, it seems when unlocking they select wrong one next?
                  // const holdValue = docs[i]._id.replace(":stream", "");
                  // Locker.release(holdValue, "SPI");
                  // ActiveLogger.info(`SPI EPS FETCH RELEASE ${holdValue}`);
                }
              }
              return resolve({
                statusCode: 200,
                content: streams.concat(unavailable as any),
              });
            })
            .catch(() => {
              // Don't mind an error so lets say everyting is ok
              return resolve({
                statusCode: 200,
                content: unavailable,
              });
            });
        } else {
          return resolve({
            statusCode: 200,
            content: unavailable,
          });
        }
      } else {
        if (body.$stream && body.$rev) {
          // Restrict Access to any volatile requests
          // Check that :volatile doesn't exist
          if (body.$stream.indexOf(":volatile") !== -1) {
            // End exectuion
            return reject({
              statusCode: 403,
              content: "Request not allowed",
            });
          }

          // Get the specific
          db.get(body.$stream, {
            _rev: body.$rev,
          })
            .then((results: any) => {
              // Make sure matching rev
              if (results._rev != body.$rev) {
                results = [];
              }
              return resolve({
                statusCode: 200,
                content: results,
              });
            })
            .catch(() => {
              // Don't mind an error so lets say everyting is ok
              return resolve({
                statusCode: 200,
                content: [],
              });
            });
        } else {
          // Bad Request
          ActiveLogger.error("Sent 500 Response (1610)");
          return reject({
            statusCode: 500,
            content: "Internal Server Error",
          });
        }
      }
    });
  }

  /**
   * Return all stream information
   *
   * @static
   * @param {ActiveDSConnect} db
   * @param {*} [start]
   * @returns {Promise<any>}
   */
  public static all(db: ActiveDSConnect, start?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      // Setup Search Options
      let options: any = { limit: 500 };
      if (start) {
        options.startkey = start;
        options.skip = 2; // Skip meta and volatile
      }

      db.allDocs(options)
        .then((response: any) => {
          resolve({
            statusCode: 200,
            content: response.rows
              .map(Endpoints.allMap)
              .filter(Endpoints.allFilter),
          });
        })
        .catch(() => {
          // Problem on the server
          reject({ error: 3 });
        });
    });
  }

  /**
   * Gets UMID Document
   *
   * @static
   * @param {ActiveDSConnect} db
   * @param {string} umid
   * @returns {Promise<any>}
   */
  public static umid(db: ActiveDSConnect, umid: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // Fetch and return
      db.get(umid + ":umid")
        .then((response: any) => {
          resolve({
            statusCode: 200,
            content: response,
          });
        })
        .catch(() => {
          // Problem on the server
          reject({ error: 2 });
        });
    });
  }

  /**
   * Map the list documents
   *
   * @private
   * @static
   * @param {*} row
   * @returns
   */
  private static allMap(row: any) {
    return { id: row.id, rev: row.value.rev };
  }

  /**
   * Filter out the volatile streams
   *
   * @private
   * @static
   * @param {*} row
   */
  private static allFilter(row: any) {
    return !(row.id.indexOf(":volatile") !== -1);
  }

  /**
   * Signed for mail (post) validator and convertor
   *
   * @static
   * @param {Host} host
   * @param {*} body
   * @param {boolean} encryptHeader
   * @returns {Promise<any>}
   */
  public static postConvertor(
    host: Host,
    body: string | Buffer,
    encryptHeader: boolean
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      let data: Buffer;

      // Handle Decryption if needed
      if (encryptHeader) {
        ActiveLogger.info("Encrypted Transaction Inbound");
        try {
          data = Buffer.from(host.decrypt(body as string), "base64");
        } catch {
          ActiveLogger.error("Sent 500 Response (1700)");
          return reject({
            statusCode: 500,
            content: "Decryption Error",
          });
        }
      } else {
        data = typeof body === "string" ? Buffer.from(body) : body;
      }

      try {
        const bodyObject = await ActiveClone.deserialize(data);
        
        // Internal Transaction Messaging (Encrypted & Signing Security)
        if (bodyObject && (bodyObject as any).$neighbour && (bodyObject as any).$packet) {
          const bodyObj = bodyObject as any;
          // We don't encrypt to ourselves
          if (bodyObj.$neighbour.reference != host.reference) {
            // Decrypt Transaction First
            if (
              bodyObj.$enc ||
              ActiveOptions.get<any>("security", {}).encryptedConsensus
            ) {
              bodyObj.$packet = await ActiveClone.deserialize(
                Buffer.from(host.decrypt(bodyObj.$packet), "base64")
              );
            }
          }

          // Verify Signature
          if (
            bodyObj.$neighbour.signature ||
            ActiveOptions.get<any>("security", {}).signedConsensus
          ) {
            if (
              !host.neighbourhood
                .get(bodyObj.$neighbour.reference)
                .verifySignature(
                  bodyObj.$neighbour.signature,
                  bodyObj.$packet
                )
            ) {
              // Bad Message
              ActiveLogger.error("Sent 500 Response (1800)");
              return reject({
                statusCode: 500,
                content: "Security Challenge Failure",
              });
            }
          }

          // Open signed post
          return resolve({
            from: bodyObj.$neighbour.reference,
            body: bodyObj.$packet,
          });
        } else {
          // Resolve as just the object
          resolve({ body: bodyObject });
        }
      } catch (e) {
        ActiveLogger.error(e, "Deserialization Error");
        return reject({
          statusCode: 500,
          content: "Deserialization Error",
        });
      }
    });
  }

  /**
   * Make sure the object is as expected not somehow a Buffer still from testing
   * we have seen {$neighbour,$packet} still encoded in Buffer form.
   *
   * @private
   * @param {unknown} obj
   * @param { { type: string; data: number[] }} obj
   * @returns {unknown}
   */
  private static async makeSureNotBuffer(obj: unknown): Promise<unknown>;
  private static async makeSureNotBuffer(obj: {
    type: string;
    data: number[];
  }): Promise<unknown> {
    if (obj.type === "Buffer" && obj.data?.length) {
      // This shouldn't be like that
      // Question is why and where this happens. This solution comes across in research
      // as a global coverage as so far "$i undefined" has has a Buffer with $i instead!
      // Appears to be compressed then turned into a buffer string that gets parsed
      // so probably writer converting but It isn't everytime?
      //ActiveLogger.error(tmp, "Buffer Found");
      if (obj.data[0] == 0x1f && obj.data[1] == 0x8b) {
        return JSON.parse(
          (await ActiveGZip.ungzip(Buffer.from(obj.data))).toString()
        );
      }
      return JSON.parse(Buffer.from(obj.data).toString());
    }
    // It should be normal just return!
    return obj;
  }

  /**
   * Creates a 200 return body with local error
   *
   * @private
   * @static
   * @param {string} error
   * @returns {*}
   */
  private static successfulFailure(error: string, counter: number = 0): any {
    return {
      statusCode: 200,
      content: {
        $umid: "",
        $summary: {
          total: 1,
          vote: 0,
          commit: 0,
          errors: [error],
          counter,
        },
        $streams: {
          new: [],
          updated: [],
        },
      },
    };
  }
}
