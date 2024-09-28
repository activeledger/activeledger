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
} from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Host } from "./host";
import { Home } from "./home";
import { Maintain } from "./maintain";
import { IStreams } from "@activeledger/activedefinitions/lib/definitions";

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

            if(tx.$datetime) {
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
            if (!tx.$territoriality && !tx.$broadcast) {
              tx.$broadcast = true;
            }

            // If we got here everything is ok to send into internal
            // Now sending direct reducing http overhead
            const resendable = (
              initTx: ActiveDefinitions.LedgerEntry,
              counter = 0
            ) => {
              Endpoints.DirectInternalInitalise(host, initTx)
                .then((response: any) => {
                  if (response.status == "200" && !response.data?.error) {
                    // Do something with the success response before returning
                    let tx: ActiveDefinitions.LedgerEntry = response.data;

                    // Build Summary
                    let summary: ActiveDefinitions.ISummary = {
                      total: 0,
                      vote: 0,
                      commit: 0,
                    };

                    // Any data to send back to the client
                    let responses = [];

                    // Get nodes to count
                    let nodes = Object.keys(tx.$nodes);
                    for (let i = nodes.length; i--; ) {
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

                    ActiveLogger.warn(summary, "How did it")
                    if (
                      !summary.commit &&
                      counter <= 20 &&
                      summary.errors?.some(
                        (e) =>
                          //e.indexOf("Stream Position Incorrect") !== -1 ||
                          e.indexOf("Busy Locks") !== -1 ||
                          e.indexOf("IBL01") !== -1
                      )
                    ) {
                      // If position incorrect maybe force update check instead of waiting on restore!
                      // This happens because the "middle" node voted for the other one and when this got its turn
                      // from the queue it is now out of date.
                      // We can resend it, But we don't want to keep resending it
                      // Reset as if it was new
                      delete (initTx as any).$nodes;
                      delete (initTx as any).$revs;
                      delete (initTx as any).$streams;
                      initTx.$counter = ++counter;
                      ActiveLogger.warn(
                        initTx,
                        `SPI Resending ${counter} in 5s`
                      );
                      setTimeout(() => {
                        resendable(initTx, counter);
                      }, 5000);
                      return;
                    } else {
                      (summary as any).counter = counter;
                      if (
                        (initTx as any).$sei < 5 &&
                        summary.errors?.some(
                          (e) => e.indexOf("Stream Position Incorrect") !== -1
                        )
                      ) {
                        // Now we can find one of the servers and send to them instead
                        for (let i = nodes.length; i--; ) {
                          if (
                            tx.$nodes[nodes[i]] &&
                            tx.$nodes[nodes[i]].error &&
                            (tx.$nodes[nodes[i]].error as string).indexOf(
                              "Stream Position Incorrect"
                            ) !== -1
                          ) {
                            // We need to rebroadcast to sending node
                            let rebroadcast = host.neighbourhood.get(nodes[i]);
                            // Send and wait on their response
                            delete (initTx as any).$nodes;
                            delete (initTx as any).$revs;
                            delete (initTx as any).$streams;
                            (initTx as any).$sei = (initTx as any).$sei + 1 || 0;
                            initTx.$counter = ++counter;
                            ActiveLogger.warn(
                              initTx,
                              "(SEI) Rebroadcasting to : " + nodes[i]
                            );
                            rebroadcast
                              .knock("", initTx, true, 0, false)
                              .then((ledger) => {
                                // Add rebroadcast flag
                                ActiveLogger.warn(ledger, "SEI RETURNED AS");

                                if (ledger.data.$summary) {
                                  resolve({
                                    statusCode: 200,
                                    content: ledger.data,
                                  });
                                } else {
                                  // May have to build it depending on its rreturn route
                                  let tx = ledger.data;

                                  if(!tx) {
                                    return this.successfulFailure(`Internal Queue Busy - Try Again`);
                                  }

                                  // Build Summary
                                  let summary: ActiveDefinitions.ISummary = {
                                    total: 0,
                                    vote: 0,
                                    commit: 0,
                                  };

                                  // TODO make this reusable have to rebuild output again

                                  // Any data to send back to the client
                                  let responses = [];

                                  // Get nodes to count
                                  let nodes = Object.keys(tx.$nodes);
                                  for (let i = nodes.length; i--; ) {
                                    summary.total++;
                                    if (tx.$nodes[nodes[i]].vote)
                                      summary.vote++;
                                    if (tx.$nodes[nodes[i]].commit)
                                      summary.commit++;

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
                                      responses.push(
                                        tx.$nodes[nodes[i]].return
                                      );
                                    }

                                    // Any updated streams we may not know about
                                    if (
                                      !tx.$streams &&
                                      tx.$nodes[nodes[i]].streams
                                    ) {
                                      tx.$streams = tx.$nodes[nodes[i]]
                                        .streams as IStreams;
                                    }
                                  }

                                  let output: ActiveDefinitions.LedgerResponse =
                                    {
                                      $umid: tx.$umid,
                                      $summary: summary,
                                      $streams: tx.$streams,
                                    };

                                  // Optional Responses to add
                                  if (responses.length) {
                                    output.$responses = responses;
                                  }

                                  resolve({
                                    statusCode: 200,
                                    content: output,
                                  });
                                }
                              })
                              .catch((error) => {
                                ActiveLogger.error(
                                  error,
                                  "Sent 500 Response (SEI)"
                                );

                                reject({ statusCode: 500, content: error });
                              });
                            return;
                          }
                        }
                      }
                    }

                    // If in broadcast there is a slim chance that commit rebroadcast will be missed so do a total/vote check
                    // commit may already be caught (as above) however this is a double check and extra broadcasts always be helpful#

                    // TODO : Has this been fixed elsewhere? Deterministic stream collision fails it here
                    // I think in willfair commiting false has removed the need for this.

                    // if (tx.$broadcast && summary.vote) {
                    //   // TODO - Reusable, not copied from protocol/process
                    //   // Allow for full network consensus
                    //   const percent = tx.$unanimous
                    //     ? 100
                    //     : ActiveOptions.get<any>("consensus", {}).reached;

                    //   // Return if consensus has been reached
                    //   if ((summary.vote / summary.total) * 100 >= percent || false) {
                    //     // If reach all that voted yes should have committed
                    //     summary.commit = summary.vote;
                    //   }
                    // }

                    // We have the entire network $tx object. This isn't something we want to return
                    let output: ActiveDefinitions.LedgerResponse = {
                      $umid: tx.$umid,
                      $summary: summary,
                      $streams: tx.$streams,
                    };

                    // Optional Responses to add
                    if (responses.length) {
                      // Just pick one for now (should be same?)
                      // I imagine its because commit is called early now so less filter chance
                      //output.$responses = [responses[0]];
                      output.$responses = responses;
                      // TODO fix (it wasn't broken just happened to be an array returned)
                    }

                    // Append Debug View
                    if (ActiveOptions.get<boolean>("debug", false)) {
                      output.$debug = tx;
                    }

                    return resolve({
                      statusCode: 200,
                      content: output,
                    });
                  } else {
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
                  if (error?.status == 100 && error.error) {
                    if (counter <= 30 && error.error === "Busy Locks") {
                      initTx.$counter = ++counter;
                      ActiveLogger.warn(
                        initTx,
                        `SPI Resending ${counter} in 5s`
                      );
                      setTimeout(() => {
                        resendable(initTx, counter);
                      }, 3000);
                    } else {
                      return resolve(
                        this.successfulFailure(error.error || error, 0)
                      );
                    }
                  } else {
                    console.log(error);
                    ActiveLogger.error(error, "Sent 500 Response (1000)");
                    return reject({
                      statusCode: 500,
                      content: error,
                    });
                  }
                });
            };
            tx.$counter = 0;
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
        // Multiple
        // return resolve(
        //   this.successfulFailure("Multiple Transaction Not Implemented")
        // );

        // We can either send them all at once or in seq depends on transaction lets default to all at once
        const results = [] as any[];
        if (body.$seq) {
          for (let i = body.$multi.length; i--; ) {
            results.push(await process(body.$multi[i]));
            // deal with catch problem
          }
          const response = [];
          for (let i = results.length; i--; ) {
            response.push(results[i].content);
          }
          resolve({
            statusCode: 200,
            content: response,
          });
        } else {
          for (let i = body.$multi.length; i--; ) {
            results.push(process(body.$multi[i]));
          }
          const results2 = (await Promise.all(results)) as any[];
          const response = [];
          for (let i = results2.length; i--; ) {
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
  public static InternalInitalise(host: Host, body: any): Promise<any> {
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
      // Send into host pool
      host
        .pending(tx, true)
        .then((ledger: any) => {
          return resolve({
            statusCode: ledger.status,
            content: ledger.data,
          });
        })
        .catch((error: any) => {
          ActiveLogger.error(tx, "Transaction error");
          ActiveLogger.error(error, "Sent 500 Response (1600)");
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
                console.log(JSON.stringify(tx));
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
        .pending(tx)
        .then((ledger) => resolve(ledger))
        .catch((error) => {
          JSON.stringify(tx);
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
  public static streams(db: ActiveDSConnect, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (body.$streams) {
        // Restrict Access to any volatile requests
        let i = body.$streams.length;
        let fetchStream = [];

        while (i--) {
          // Check that :volatile doesn't exist
          if (body.$streams[i].indexOf(":volatile") !== -1) {
            // End exectuion
            return reject({
              statusCode: 403,
              content: "Request not allowed",
            });
          }

          // Fetch Request (Catch error here and forward on as an object to process in .all)
          fetchStream.push(
            db.get(body.$streams[i]).catch((error) => {
              return { _error: error };
            })
          );
        }

        // Wait for all streams to be returned
        Promise.all(fetchStream)
          .then((docs: any) => {
            // Could just pass docs but that will send unnecessary data at this point
            let i = docs.length;
            let streams = [];
            while (i--) {
              // Make sure not an error
              if (docs[i]._id) {
                streams.push({
                  _id: docs[i]._id,
                  _rev: docs[i]._rev,
                });
              }
            }
            return resolve({
              statusCode: 200,
              content: streams,
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
          reject({});
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
          reject({});
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
    body: string,
    encryptHeader: boolean
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      // Is this an encrypted external transaction that need passing.
      if (encryptHeader) {
        // Decrypt & Parse
        ActiveLogger.info("Encrypted Transaction Inbound");
        try {
          // Decrypt
          resolve(
            JSON.parse(Buffer.from(host.decrypt(body), "base64").toString())
          );
        } catch {
          // Error trying to decrypt
          ActiveLogger.error("Sent 500 Response (1700)");
          return reject({
            statusCode: 500,
            content: "Decryption Error",
          });
        }
      } else {
        // body should now be a json string to be converted, However check
        // that it still isn't in its Buffer form!
        let bodyObject;
        try {
          bodyObject = (await this.makeSureNotBuffer(JSON.parse(body))) as any;
        } catch (e) {
          throw e;
        }
        // Internal Transaction Messesing (Encrypted & Signing Security)
        if (bodyObject.$neighbour && bodyObject.$packet) {
          //ActiveLogger.debug(bodyObject, "Converting Signed for Post");

          try {
            if (bodyObject.$enc) {
            }
          } catch (e) {
            console.log("NO $ENC");
            console.log(bodyObject);
          }

          // We don't encrypt to ourselve
          if (bodyObject.$neighbour.reference != host.reference) {
            // Decrypt Trasanction First (As Signing Pre Encryption)
            if (
              bodyObject.$enc ||
              ActiveOptions.get<any>("security", {}).encryptedConsensus
            ) {
              bodyObject.$packet = JSON.parse(
                Buffer.from(
                  host.decrypt(bodyObject.$packet),
                  "base64"
                ).toString()
              );
            }
          }

          // Verify Signature (but we do verify)
          if (
            bodyObject.$neighbour.signature ||
            ActiveOptions.get<any>("security", {}).signedConsensus
          ) {
            if (
              !host.neighbourhood
                .get(bodyObject.$neighbour.reference)
                .verifySignature(
                  bodyObject.$neighbour.signature,
                  bodyObject.$packet
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
            from: bodyObject.$neighbour.reference,
            body: bodyObject.$packet,
          });
        } else {
          // Resolve as just the object
          resolve({ body: bodyObject });
        }
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
