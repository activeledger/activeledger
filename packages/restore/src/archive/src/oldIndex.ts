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
import {
  ActiveOptions,
  ActiveDSConnect,
  ActiveChanges
} from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { Sledgehammer } from "./sledgehammer";
import { Contract } from "./contract";

/* 
====================================
Benchmarking Setup
====================================
*/
const holder = function() {
  const benchmarking = {
    1: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    2: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    3: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    4: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    5: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    6: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    7: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    8: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    9: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    10: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    11: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    12: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    13: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    14: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    15: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    16: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    17: {
      start: 0,
      name: "Vote Count",
      result: 0
    },
    18: {
      start: 0,
      name: "Vote Count",
      result: 0
    }
  };

  let baseline: number;
  let start: number;

  /* 
====================================
END Benchmarking Setup
====================================
*/

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
      "No Identity File Found (" +
        ActiveOptions.get<string>("identity", "") +
        ")"
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
      let db: ActiveDSConnect = new ActiveDSConnect(
        ActiveOptions.get<any>("db", {}).url +
          "/" +
          ActiveOptions.get<any>("db", {}).database
      );

      if (!ActiveOptions.get<boolean>("full", false)) {
        // Error Database Connection
        let dbe = new ActiveDSConnect(
          ActiveOptions.get<any>("db", {}).url +
            "/" +
            ActiveOptions.get<any>("db", {}).error
        );

        // Listen to activeledger errors database
        let errorFeed = new ActiveChanges("Restore", dbe, 1);

        // Code & Reason
        // 950 = Stream not found
        // 960 = State not found
        // 1000 = Failed Vote (Similar to 1505 different report time)
        //      = Removed, Don't need to check on contract rejects, code errors. As they should all error with
        //      = the same matching input / output data which is thrown by the code below. If this was just an error on this node
        //      = the next pass on the stream will throw a 1200 anyway. This could happen with a contract mismatch.
        // 1200 = * Stream position incorrect
        // 1210 = Read only steam not found
        // 1505 = I voted no, Maybe I was wrong (Similar to 1000 different report time)
        //      = May also be safe to remove same reasons as 1000.
        // 1510 = Failed to save (I may be the only one who voted)
        // 1600 = Failed to commit before timeout (broadcast)
        // 1610 = Failed to get a response back in a rebroadcast while tx was in memory
        let errorCodes = [950, 960, 1200, 1210, 1510, 1600, 1610];

        // Bind On Change Event
        // Manage on feed notifcation to subsribers
        errorFeed.on("change", (change: any) => {
          // Pause to process (Double sledgehammer)
          errorFeed.pause();
          // Have we Processed
          if (!change.doc.processed) {
            // Check error codes
            if (errorCodes.indexOf(change.doc.code) !== -1) {
              // If I am wrong cannot rely on the data in the body
              // If vote failure I won't have any of the node responses (I maybe wrong)
              // If its broadcast we can't rely on the data for
              if (
                change.doc.code != 1510 &&
                change.doc.code != 1000 &&
                !change.doc.transaction.$broadcast
              ) {
                // Compare $nodes to see if enough true in consensus
                let nodes = Object.keys(change.doc.transaction.$nodes);
                let votes = 0;

                // loop nodes and count votes
                let i = nodes.length;

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
                // What if all nodes voted no. Data check will verify this. They may have voted no because my revision is wrong
                dataCheck(change);
              }
            } else {
              haveProcessed(change.doc);
            }
          } else {
            errorFeed.resume();
            benchmarkOutput("1");
            /* ActiveLogger.info("In MS: " + (Date.now() - start).toString());
          baseline = (Date.now() - start) / 1000;
          ActiveLogger.info(
            "======================= BASELINE (1) ======================="
          );
          ActiveLogger.info(baseline.toString());
          ActiveLogger.info(
            "======================= BASELINE (1) END =======================\n"
          ); */
          }
        });

        // Process data integrity check
        let dataCheck: Function = (change: any): void => {
          // Pause to process (Double sledgehammer)
          // errorFeed.pause();

          start = Date.now();

          ActiveLogger.info("Data Check - Blocking for Network - Benchmarking");

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

            // Get new streams from the UMID on the network
            // This could possubly make the above rev definition redundant (except $r)
            network.neighbourhood
              .knockAll("umid/" + change.doc.umid, null, true)
              .then((responses: any) => {
                // Loop Responses
                let allStreams = [];
                let umidDoc: any;
                let attemptUmidDoc = false;

                benchmarking["2"].start = Date.now();
                let i = responses.length;

                while (i--) {
                  if (!responses[i].error) {
                    // Merge each nodes new / updated opinion
                    allStreams = [
                      ...responses[i].streams.new,
                      ...responses[i].streams.updated
                    ];

                    // Have a cached version of a document (Should we compare?)
                    umidDoc = responses[i];
                  } else {
                    // The error could be us!
                    if (!attemptUmidDoc) {
                      // Set flag to attempt to add umid
                      attemptUmidDoc = true;
                    }
                  }
                }
                benchmarking["2"].result = Date.now() - benchmarking["2"].start;

                benchmarking["3"].start = Date.now();
                // Now merge them into the main object
                i = allStreams.length;
                while (i--) {
                  // Get reference stream check and add to global references
                  let stream = allStreams[i].id;
                  if (!revs[stream]) {
                    revs.push(stream);
                  }
                }
                benchmarking["3"].result = Date.now() - benchmarking["3"].start;

                // Loop revs as we need :stream as well

                benchmarking["4"].start = Date.now();
                i = revs.length;
                while (i--) {
                  revs.push(`${revs[i]}:stream`);
                }
                benchmarking["4"].result = Date.now() - benchmarking["4"].start;

                // Output Possible Changes
                ActiveLogger.info(revs, "$stream revisions");

                // Ask Network about Streams
                network.neighbourhood
                  .knockAll("stream", { $streams: revs }, true)
                  .then((responses: any) => {
                    // Loop response

                    // Map Reduce style reduction
                    let reduction: any = {};

                    benchmarking["5"].start = Date.now();
                    // let i = responses.length;
                    for (let i = responses.length; i--; ) {
                      if (!responses[i].error) {
                        // We need to loop allthhe returned documents
                        let streams = responses[i];
                        benchmarking["6"].start = Date.now();
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
                          // Increments based on responses from other nodes
                          reduction[streams[ii]._id][streams[ii]._rev]++;
                        }
                        benchmarking["6"].result =
                          Date.now() - benchmarking["6"].start;
                      }
                    }
                    benchmarking["5"].result =
                      Date.now() - benchmarking["5"].start;

                    // Now we need to loop the reduction see which stream / rev reaches consensus
                    let streams = Object.keys(reduction);

                    // Hold all the promises to update when all done
                    let all: any = [];

                    benchmarking["7"].start = Date.now();
                    streams.forEach((streamIndex) => {
                      let stream = reduction[streamIndex];

                      // Now we need to loop revisions
                      let revs = Object.keys(stream);

                      benchmarking["8"].start = Date.now();

                      revs.forEach((revIndex) => {
                        let revCount = stream[revIndex];

                        if (
                          (revCount /
                            (ActiveOptions.get<Array<any>>("neighbourhood", [])
                              .length -
                              1)) *
                            100 >=
                          ActiveOptions.get<any>("consensus", {}).reached
                        ) {
                          let stream = streamIndex;
                          let rev = revIndex;
                          // This stream + revision is correct!
                          ActiveLogger.info(`WW🐔D - ${stream}@${rev}`);

                          // Now fetch local version of this stream
                          all.push(
                            new Promise((resolve, reject) => {
                              db.get(stream)
                                .then((doc: any) => {
                                  // Now compare our revision to the consensus one
                                  if (doc._rev == rev) {
                                    resolve(false);
                                  } else {
                                    dataFix(doc, stream, rev, false)
                                      .then(resolve)
                                      .catch(reject);
                                  }
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
                      });
                      benchmarking["8"].result =
                        Date.now() - benchmarking["8"].start;
                    });
                    benchmarking["7"].result =
                      Date.now() - benchmarking["7"].start;

                    // Tidy up & Sledghammer if needed when everything is done
                    Promise.all(all)
                      .then((results: unknown[]) => {
                        haveProcessed(change.doc);
                        // If all is asll false no sledghammer it could be a false negative
                        if (results.some((e: boolean) => e)) {
                          // Lets just hammer time
                          // Run the sledgehammer!
                          Sledgehammer.smash()
                            .then((bits) => {
                              ActiveLogger.info("Smashing Completed");
                              // Add umid
                              if (attemptUmidDoc) {
                                insertUmid(umidDoc);
                              }
                              // Resume for now
                              errorFeed.resume();
                              benchmarkOutput("2");
                              /* baseline = (Date.now() - start) / 1000;
                            ActiveLogger.info(
                              "In MS: " + (Date.now() - start).toString()
                            );
                            ActiveLogger.info(
                              "======================= BASELINE (2) ======================="
                            );
                            ActiveLogger.info(baseline.toString());
                            ActiveLogger.info(
                              "======================= BASELINE (2) END =======================\n"
                            ); */
                            })
                            .catch((e) => {
                              ActiveLogger.error(e, "Hammer Broke");
                              // Resume for now
                              errorFeed.resume();
                              benchmarkOutput("3");

                              /* baseline = (Date.now() - start) / 1000;
                            ActiveLogger.info(
                              "In MS: " + (Date.now() - start).toString()
                            );
                            ActiveLogger.info(
                              "======================= BASELINE (3) ======================="
                            );
                            ActiveLogger.info(baseline.toString());
                            ActiveLogger.info(
                              "======================= BASELINE (3) END =======================\n"
                            ); */

                              // Ignore errors for now
                              ActiveLogger.info(e);
                            });
                        } else {
                          ActiveLogger.warn("Data Check - False Positive");
                          // Add umid
                          if (attemptUmidDoc) {
                            insertUmid(umidDoc);
                          }
                        }
                      })
                      .catch((e: Error) => {
                        ActiveLogger.error(e, "All Datafix had errors");
                      });
                  });
              })
              .catch((e: Error) => {
                // Ignore Errors
                // Resume just in case
                errorFeed.resume();
                benchmarkOutput("4");
                /* baseline = (Date.now() - start) / 1000;
              ActiveLogger.info("In MS: " + (Date.now() - start).toString());
              ActiveLogger.info(
                "======================= BASELINE (4) ======================="
              );
              ActiveLogger.info(baseline.toString());
              ActiveLogger.info(
                "======================= BASELINE (4) END =======================\n"
              ); */
              });
          }, 6000);
        };

        // Attempts to add umid into activeledger
        let insertUmid = (umidDoc: any): void => {
          // May have been a bad TX so no umid
          if (umidDoc) {
            db.bulkDocs([umidDoc], { new_edits: false })
              .then(() => {
                ActiveLogger.info("UMID Added");
              })
              .catch((e) => {
                ActiveLogger.info(e || umidDoc, "UMID Failed");
              });
          }
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
                benchmarkOutput("5");
                /* baseline = (Date.now() - start) / 1000;
              ActiveLogger.info("In MS: " + (Date.now() - start).toString());
              ActiveLogger.info(
                "======================= BASELINE (5) ======================="
              );
              ActiveLogger.info(baseline.toString());
              ActiveLogger.info(
                "======================= BASELINE (5) END =======================\n"
              ); */
                // Do we need to do something?
                resolve(true);
              })
              .catch((e: Error) => {
                // Allow Resumse
                errorFeed.resume();
                /* baseline = (Date.now() - start) / 1000;
              ActiveLogger.info("In MS: " + (Date.now() - start).toString());
              ActiveLogger.info(
                "======================= BASELINE (6) ======================="
              );
              ActiveLogger.info(baseline.toString());
              ActiveLogger.info(
                "======================= BASELINE (6) END =======================\n"
              ); */
                benchmarkOutput("6");
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

                benchmarking["9"].start = Date.now();
                for (let i = responses.length; i--; ) {
                  if (!responses[i].error) {
                    let correct = responses[i];

                    // Did document not exist? (Got deleted)
                    if (
                      doc.error &&
                      doc.status &&
                      doc.message &&
                      doc.docId &&
                      doc.status == 404 &&
                      doc.message == "missing"
                    ) {
                      doc._id = doc.docId;
                    }

                    // TODO:
                    // Make sure it is defined or not an empty array
                    if (correct && !Array.isArray(correct)) {
                      // Internal, We can purge and put
                      if (ActiveOptions.get<any>("db", {}).selfhost) {
                        db.purge(doc)
                          .then(() => {
                            db.bulkDocs([correct], { new_edits: false })
                              .then(() => {
                                resolve(true);
                              })
                              .catch((e: Error) => {
                                // Ignore errors for now
                                ActiveLogger.info(e, "Error Message");
                                ActiveLogger.info(doc, "Document ");
                                resolve(false);
                              });
                          })
                          .catch((e: Error) => {
                            // Ignore errors for now
                            ActiveLogger.info(e, "Error Message");
                            ActiveLogger.info(doc, "Document ");
                            resolve(false);
                          });
                      } else {
                        // Update document set with correct data and mark for replication deletetion
                        doc.$activeledger = {
                          delete: true,
                          rewrite: correct
                        };

                        // Update
                        db.put(doc)
                          .then(() => {
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
                                  resolve(true);
                                });
                            } else {
                              resolve(true);
                            }
                          })
                          .catch((e: Error) => {
                            // Ignore errors for now
                            ActiveLogger.info(e, "Error Message");
                            ActiveLogger.info(doc, "Document ");
                            resolve(false);
                          });
                      }
                      // Only need to process one
                      break;
                    }
                  }
                }
                benchmarking["9"].result = Date.now() - benchmarking["9"].start;
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

        // Promise All
        let promises: Array<Promise<any>> = [];

        // Loop all nodes to get their lists
        benchmarking["10"].start = Date.now();
        let i = nodes.length;
        while (i--) {
          let node = neighbourhood[nodes[i]];
          // Don't lookup self (As it should be blank!)
          if (node.reference !== ActiveNetwork.Home.reference) {
            promises.push(asyncRecursiveRebuild(node));
          }
        }
        benchmarking["10"].result = Date.now() - benchmarking["10"].start;

        // Wait for all node loops to finalize
        Promise.all(promises)
          .then((response) => {
            // Holds consusus of stream
            let expandCompare: any = {};

            // Which stream has which revision
            let consensusReached: Array<any> = [];

            // Expand on stream information
            benchmarking["18"].start = Date.now();
            for (let index = 0; index < response.length; index++) {
              // Loop and build map (expand)
              let list = response[index].streams;

              // TODO:

              benchmarking["11"].start = Date.now();
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
              benchmarking["11"].result = Date.now() - benchmarking["11"].start;
            }
            benchmarking["18"].result = Date.now() - benchmarking["18"].start;

            // Now loop and show ones which reach consensus
            let streams = Object.keys(expandCompare);

            benchmarking["12"].start = Date.now();
            let i = streams.length;
            while (i--) {
              if (streams[i] != "undefined") {
                // No Idea
                let stream = expandCompare[streams[i]];

                let revs = Object.keys(stream);

                // Loop Streams Revisions
                benchmarking["13"].start = Date.now();
                let ii = revs.length;
                while (ii--) {
                  let rev = stream[revs[ii]];

                  // Have we got one that reaches consensus
                  if (
                    (rev /
                      ActiveOptions.get<Array<any>>("neighbourhood", [])
                        .length) *
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
                benchmarking["13"].result =
                  Date.now() - benchmarking["13"].start;
              }
            }
            benchmarking["12"].result = Date.now() - benchmarking["12"].start;

            // Time to fetch the consensus data

            // documents to upload
            let documents: Array<any> = [];

            // volatile documents to upload
            let volatile: Array<any> = [];
            let promises: Array<Promise<any>> = [];

            // Loop Consensus and knock for the data
            benchmarking["14"].start = Date.now();
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
            benchmarking["14"].result = Date.now() - benchmarking["14"].start;

            // Wait for all the knocks to  return
            Promise.all(promises)
              .then((responses) => {
                // Loop the response (only need 1 none erroring)
                let i = responses.length;
                benchmarking["15"].start = Date.now();
                while (i--) {
                  let response = responses[i];

                  benchmarking["16"].start = Date.now();
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
                  benchmarking["16"].result =
                    Date.now() - benchmarking["16"].start;
                }
                benchmarking["15"].result = benchmarking["15"].start;

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
    .catch((e) => {
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
    benchmarking["17"].start = Date.now();

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

    benchmarking["17"].result = Date.now() - benchmarking["17"].start;

    // Return the list with the reference
    return { reference: nodes.reference, streams: output };
  }

  function benchmarkOutput(entry: string) {
    ActiveLogger.info("=========================== BASELINE - " + entry);
    ActiveLogger.info(`1: ${benchmarking[1].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`2: ${benchmarking[2].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`3: ${benchmarking[3].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`4: ${benchmarking[4].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`5: ${benchmarking[5].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`6: ${benchmarking[6].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`7: ${benchmarking[7].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`8: ${benchmarking[8].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`9: ${benchmarking[9].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`10: ${benchmarking[10].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`11: ${benchmarking[11].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`12: ${benchmarking[12].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`13: ${benchmarking[13].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`14: ${benchmarking[14].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`15: ${benchmarking[15].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`16: ${benchmarking[16].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`17: ${benchmarking[17].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info(`18: ${benchmarking[18].result}`);
    ActiveLogger.info("---------------------------");
    ActiveLogger.info("=========================== BASELINE - END " + entry);
  }
};
