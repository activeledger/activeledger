#!/usr/bin/env node

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

import * as fs from "fs";
// @ts-ignore
import * as PouchDB from "pouchdb";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { Sledgehammer } from "./sledgehammer";
import { Contract } from "./contract";
import { FollowChanges } from "./changes";

// Initalise CLI Options
ActiveOptions.init();

// Possibly Pathed to the config
if (ActiveOptions.get<string>("path", "")) {
  ActiveOptions.set(
    "config",
    ActiveOptions.get<string>("path", "") +
      ActiveOptions.get<string>("config", "config.json")
  );
}

// Auto Fetch Identity
if (!ActiveOptions.get<string | boolean>("identity", false)) {
  ActiveOptions.set(
    "identity",
    ActiveOptions.get<string>("path", ".") + "/.identity"
  );
}

// Check for config
if (!fs.existsSync(ActiveOptions.get<string>("config", "config.json")))
  throw ActiveLogger.fatal(
    "No Config File Found (" +
      ActiveOptions.get<string>("config", "config.json") +
      ")"
  );

// Check for identity
if (!fs.existsSync(ActiveOptions.get<string>("identity", "")))
  throw ActiveLogger.fatal(
    "No Identity File Found (" + ActiveOptions.get<string>("identity", "") + ")"
  );

// Parse Config
ActiveOptions.parseConfig();

// Extend Config
ActiveOptions.extendConfig()
  .then(() => {
    // Self Hosted?
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      // Get Database
      let db = ActiveOptions.get<any>("db", {});

      // Set Url
      db.url = "http://127.0.0.1:" + db.selfhost.port;

      // We can also update the path to override the default couch install
      db.path = db.selfhost.dir || "./.ds";

      // Set Database
      ActiveOptions.set("db", db);
    }

    // Use activenetwork to manage comms (with knock all)
    let network: ActiveNetwork.Home = new ActiveNetwork.Home();

    // Live Database Connection
    let db = new PouchDB(
      ActiveOptions.get<any>("db", {}).url +
        "/" +
        ActiveOptions.get<any>("db", {}).database
    );

    if (!ActiveOptions.get<boolean>("full", false)) {
      // Error Database Connection
      let dbe = new PouchDB(
        ActiveOptions.get<any>("db", {}).url +
          "/" +
          ActiveOptions.get<any>("db", {}).error
      );

      // Listen to activeledger errors database
      let errorFeed = new FollowChanges(dbe);

      // Code & Reason
      // 950 = Stream not found
      // 960 = State not found
      // 1000 = Failed Vote
      // 1200 = * Stream position incorrect
      // 1210 = Read only steam not found
      // 1520 = Failed to save (I may be the only one who voted)
      let errorCodes = [950, 960, 1000, 1200, 1210, 1510];

      // Bind On Change Event
      // Manage on feed notifcation to subsribers
      errorFeed.on("change", (change: any) => {
        // Have we Processed
        if (!change.doc.processed) {
          // Check error codes
          if (errorCodes.indexOf(change.doc.code) !== -1) {
            // Compare $nodes to see if enough true in consensus
            let nodes = Object.keys(change.doc.transaction.$nodes);
            let i = nodes.length;
            let votes = 0;

            // loop nodes and count votes
            while (i--) {
              if (change.doc.transaction.$nodes[nodes[i]].vote) votes++;
            }

            // If Votes reached consensus without me continue
            // this node is also listed inside the above nodes so count works as expected
            if (
              (votes /
                ActiveOptions.get<Array<any>>("neighbourhood", []).length) *
                100 >=
              ActiveOptions.get<any>("consensus", {}).reached
            ) {
              dataCheck(change);
            } else {
              // we can ignore everyone processed this as bad
              // What if we are ahead? (1200 code known to be the case)
              if (change.doc.code == 1200) {
                dataCheck(change);
              } else {
                // Ignore for now
                haveProcessed(change.doc);
              }
            }
          } else {
            haveProcessed(change.doc);
          }
        }
      });

      // Process data integrity check
      let dataCheck: Function = (change: any): void => {
        // Pause to process (Double sledgehammer)
        errorFeed.pause();

        ActiveLogger.info("Data Check - Blocking for Network");

        // Sledgehammer can also be to fast
        // Lets have a bit of delay to allow the rest of the network
        // To process changes if there were any!
        setTimeout(() => {
          ActiveLogger.info("Data Check - Resuming");

          // Consensus was reached, Lets all the network what they think about the document
          // we have to check rev keys for both inputs and outputs
          let revs: string[] = Object.keys(
            change.doc.transaction.$revs.$i || {}
          )
            .concat(Object.keys(change.doc.transaction.$revs.$o || {}))
            .concat(Object.values(change.doc.transaction.$tx.$r || {}));

          // Loop revs as we need :stream as well
          let i = revs.length;
          while (i--) {
            revs.push(`${revs[i]}:stream`);
          }

          console.log({ $streams: revs });

          // Ask Network
          network.neighbourhood
            .knockAll("stream", { $streams: revs }, true)
            .then((responses: any) => {
              // Loop response
              let i = responses.length;

              // Map Reduce style reduction
              let reduction: any = {};

              while (i--) {
                if (!responses[i].error) {
                  // We need to loop allthhe returned documents
                  let streams = responses[i];
                  let ii = streams.length;
                  while (ii--) {
                    // Now we need to map reduce for data concensu id=>rev=>count

                    // Id exists?
                    if (!reduction[streams[ii]._id])
                      reduction[streams[ii]._id] = {};

                    // rev exists?
                    if (!reduction[streams[ii]._id][streams[ii]._rev])
                      reduction[streams[ii]._id][streams[ii]._rev] = 0;

                    // Add to Revision
                    reduction[streams[ii]._id][streams[ii]._rev]++;
                  }
                }
              }
              // Now we need to loop the reduction see which stream / rev reaches consensus
              let streams = Object.keys(reduction);
              i = streams.length;

              // Hold all the promises to update when all done
              let all = [];

              while (i--) {
                let stream = reduction[streams[i]];

                // Now we need to loop revisions
                let revs = Object.keys(stream);
                let ii = revs.length;

                while (ii--) {
                  let revCount = stream[revs[ii]];

                  if (
                    (revCount /
                      ActiveOptions.get<Array<any>>("neighbourhood", [])
                        .length) *
                      100 >=
                    ActiveOptions.get<any>("consensus", {}).reached
                  ) {
                    let stream = streams[i];
                    let rev = revs[ii];
                    // This stream + revision is correct!
                    ActiveLogger.info(`WW🐔D - ${stream}@${rev}`);

                    // Now fetch local version of this stream
                    all.push(
                      new Promise((resolve, reject) => {
                        db.get(stream)
                          .then((doc: any) => {
                            // Now compare our revision to the consensus one
                            // if (doc._rev == rev) {
                            // Really shouldn't be here but just in case lets mark as processed
                            // Actually if we get 2 errors and we "catch up" we need to mark the old or new one asprocessed
                            //  haveProcessed(change.doc);
                            // } else {
                            dataFix(doc, stream, rev, false)
                              .then(resolve)
                              .catch(reject);
                            // }
                          })
                          .catch((e: Error) => {
                            // We may not actualy have the file! So we still need to process
                            dataFix({ _id: stream }, stream, rev, true)
                              .then(resolve)
                              .catch(reject);
                          });
                      })
                    );
                  } else {
                    // TODO : Problem
                    // What to do if no consensus?
                    // Maybe nothing because what if a knock failed due to network?
                    // However we also need to periodically fetch commands
                    // Lets at least resume
                    all.push(true);
                  }
                }
              }

              // Tidy up & Sledghammer if needed when everything is done
              Promise.all(all)
                .then(() => {
                  haveProcessed(change.doc);
                  // Lets just hammer time
                  // Run the sledgehammer!
                  Sledgehammer.smash()
                    .then(bits => {
                      ActiveLogger.info("Smashing Completed");
                      // Resume for now
                      errorFeed.resume();
                    })
                    .catch(e => {
                      ActiveLogger.error(e, "Hammer Broke");
                      // Resume for now
                      errorFeed.resume();
                      // Ignore errors for now
                      ActiveLogger.info(e);
                    });
                })
                .catch((e: Error) => {
                  ActiveLogger.error(e, "All Datafix had errors");
                });
            })
            .catch((e: Error) => {
              // Ignore Errors
              // Resume just in case
              errorFeed.resume();
            });
        }, 6000);
      };

      // Process Flag
      let haveProcessed: Function = (doc: any): Promise<any> => {
        return new Promise((resolve, reject) => {
          doc.processed = true;
          doc.processedAt = new Date();
          dbe
            //.post(doc)
            .put(doc)
            .then((result: any) => {
              // Allow Resumse
              errorFeed.resume();
              // Do we need to do something?
              resolve(true);
            })
            .catch((e: Error) => {
              // Allow Resumse
              errorFeed.resume();
              // We may get conflicts (multiple streams per transaction so multiple may say haveProccesed)
              // As we don't really care right now return resolve
              resolve(true);
            });
        });
      };

      // Lets fix a document!
      let dataFix: Function = (
        doc: any,
        stream: string,
        rev: string,
        volatile: boolean
      ): Promise<Boolean> => {
        return new Promise((resolve, reject) => {
          // TODO : Create the "nice" approach
          // We can do 2 things here. If we are behind consensus (but still have a histroic consensus point)
          // we can attempt to "catch up" based on the data and could even run the smart contracts.
          // However if we are ahead of consensus we need to sledgehammer approach. As the sledgehammer approach works for both
          // we will start with that

          // Sledgehammer Mode
          // Lets knock all of them for this
          network.neighbourhood
            .knockAll("stream", { $stream: stream, $rev: rev }, true)
            .then((responses: any) => {
              // Should we check them all? They should all be the same so use first for now
              // Due to our identity cheat we cannot select first as it may error. So loop for first nonoe error
              let i = responses.length;
              while (i--) {
                if (!responses[i].error) {
                  let correct = responses[i];

                  // Make sure it is defined or not an empty array
                  if (correct && !Array.isArray(correct)) {
                    // Update document set with correct data and mark for replication deletetion
                    doc.$activeledger = {
                      delete: true,
                      rewrite: correct
                    };

                    // Update
                    db.put(doc)
                      .then((response: any) => {
                        ActiveLogger.info(response);

                        // Detect if this could be a contract that needs compiling
                        if (
                          correct.namespace &&
                          correct.contract &&
                          correct.compiled
                        ) {
                          // Potential false positives, Will need to manage in the future
                          Contract.rebuild(correct);
                        }

                        // Do we need volatile to be created (stream was non-existant)
                        // Only need to do 1 volatile so check on stream
                        if (volatile && doc._id.indexOf(":stream")) {
                          db.put({
                            _id: doc._id.replace(":stream", ":volatile"),
                            _rev: doc._rev
                          })
                            .then(() => {
                              resolve(true);
                            })
                            .catch(() => {
                              resolve(false);
                              //reject("Failed to create volatile");
                            });
                        } else {
                          resolve(true);
                        }
                      })
                      .catch((e: Error) => {
                        // Resume for now
                        // errorFeed.resume();
                        // Ignore errors for now
                        ActiveLogger.info(e, "error");
                        ActiveLogger.info(doc, "error");
                        resolve(false);
                      });

                    // Only need to process one
                    break;
                  }
                }
              }
            })
            .catch((e: Error) => {
              // Ignore Errors
              resolve(false);
            });
        });
      };

      // Start Feeding
      errorFeed.start();
    } else {
      // We are doing a full restore from nothing
      ActiveLogger.info("Starting Quick Full Restore");

      // We need to get _all_docs from all the nodes (eith start / end key ) it is ok if we miss 1  or 2 with inserts as the sledgehammer will fix that later

      // Nodes
      let neighbourhood = network.neighbourhood.get();
      let nodes = Object.keys(neighbourhood);
      let i = nodes.length;

      // Promise All
      let promises: Array<Promise<any>> = [];

      // Loop all nodes to get their lists
      while (i--) {
        let node = neighbourhood[nodes[i]];
        // Don't lookup self (As it should be blank!)
        if (node.reference !== ActiveNetwork.Home.reference) {
          promises.push(asyncRecursiveRebuild(node));
        }
      }

      // Wait for all node loops to finalize
      Promise.all(promises)
        .then(response => {
          // Holds consusus of stream
          let expandCompare: any = {};

          // Which stream has which revision
          let consensusReached: Array<any> = [];

          // Expand on stream information
          for (let index = 0; index < response.length; index++) {
            // Loop and build map (expand)
            let list = response[index].streams;
            let i = list.length;

            while (i--) {
              // Do we have this stream
              if (expandCompare[list[i].id]) {
                // Do we have this rev
                if (expandCompare[list[i].id][list[i].rev]) {
                  // Add
                  expandCompare[list[i].id][list[i].rev]++;
                } else {
                  // Start
                  expandCompare[list[i].id][list[i].rev] = 1;
                }
              } else {
                expandCompare[list[i].id] = {
                  [list[i].rev]: 1
                };
              }
            }
          }

          // Now loop and show ones which reach consensus
          let streams = Object.keys(expandCompare);
          let i = streams.length;

          while (i--) {
            if (streams[i] != "undefined") {
              // No Idea
              let stream = expandCompare[streams[i]];

              let revs = Object.keys(stream);
              let ii = revs.length;

              // Loop Streams Revisions
              while (ii--) {
                let rev = stream[revs[ii]];

                // Have we got one that reaches consensus
                if (
                  (rev /
                    ActiveOptions.get<Array<any>>("neighbourhood", []).length) *
                    100 >=
                  ActiveOptions.get<any>("consensus", {}).reached
                ) {
                  consensusReached.push({
                    stream: streams[i],
                    rev: revs[ii]
                  });
                  break;
                }
              }
            }
          }

          // Time to fetch the consensus data

          // documents to upload
          let documents: Array<any> = [];

          // volatile documents to upload
          let volatile: Array<any> = [];
          let promises: Array<Promise<any>> = [];

          // Loop Consensus and knock for the data
          i = consensusReached.length;
          while (i--) {
            promises.push(
              network.neighbourhood.knockAll(
                "stream",
                {
                  $stream: consensusReached[i].stream,
                  $rev: consensusReached[i].rev
                },
                true
              )
            );
          }

          // Wait for all the knocks to  return
          Promise.all(promises)
            .then(responses => {
              let i = responses.length;

              // Loop the response (only need 1 none erroring)
              while (i--) {
                let response = responses[i];

                let ii = response.length;
                while (ii--) {
                  if (!response[ii].error) {
                    // Push Document
                    documents.push(response[ii]);

                    // Only add 1 volatile
                    if (response[ii]._id.indexOf(":stream") === -1) {
                      volatile.push({ _id: `${response[ii]._id}:volatile` });

                      // Detect if this could be a contract that needs compiling
                      if (
                        response[ii].namespace &&
                        response[ii].contract &&
                        response[ii].compiled
                      ) {
                        // Potential false positives, Will need to manage in the future
                        Contract.rebuild(response[ii]);
                      }
                    }
                    // Only need to process one none erroring
                    break;
                  }
                }
              }

              // Upload the streams into the database
              // Upload documents and allow us to set revision
              db.bulkDocs(documents, { new_edits: false })
                .then(() => {
                  // Upload volatile but let database set new edits
                  db.bulkDocs(volatile, { new_edits: true })
                    .then(() => {
                      ActiveLogger.info("Quick Restore Completed");
                    })
                    .catch((e: Error) => {
                      // Ignore Errors
                      ActiveLogger.debug(e);
                    });
                })
                .catch((e: Error) => {
                  // Ignore Errors
                  ActiveLogger.debug(e);
                });
            })
            .catch((e: Error) => {
              // Ignore Errors
              ActiveLogger.debug(e);
            });
        })
        .catch((e: Error) => {
          // Ignore Errors
          ActiveLogger.debug(e);
        });
    }
  })
  .catch(e => {
    ActiveLogger.fatal(e, "Config Extension Issues");
  });

/**
 * Fetches all streams on the specific node
 *
 * @param {ActiveNetwork.Neighbour} nodes
 * @returns
 */
async function asyncRecursiveRebuild(nodes: ActiveNetwork.Neighbour) {
  // Output to return
  let output: Array<any> = [];

  // Accesible within loop encapsulation
  let results: any;

  do {
    // If results not empty we have a start key
    if (results) {
      let id = results.data[results.data.length - 1].id;
      results = await nodes.knock(`all/${id}`);
    } else {
      // Start from 0
      results = await nodes.knock("all");
    }
    // Combine result with output
    output = output.concat(results.data);
  } while (results.data.length);

  // Return the list with the reference
  return { reference: nodes.reference, streams: output };
}
