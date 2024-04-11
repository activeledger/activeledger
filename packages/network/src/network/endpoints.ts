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

import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Host } from "./host";
import { Home } from "./home";
import { NeighbourStatus } from "./neighbourhood";
import { Maintain } from "./maintain";

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
   * @memberof Endpoints
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
   * @memberof Endpoints
   */
  public static ExternalInitalise(
    host: Host,
    body: any,
    ip: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Check Transaction (Basic Validation Tests)
      if (body && ActiveDefinitions.LedgerTypeChecks.isEntry(body)) {
        let tx = body as ActiveDefinitions.LedgerEntry;

        // Set Date
        tx.$datetime = new Date();

        // Check transaction hasn't expired
        if (tx.$tx.$expire && new Date(tx.$tx.$expire) <= tx.$datetime) {
          return resolve(
            this.successfulFailure(`Transaction Expired : ${tx.$tx.$expire}`)
          );
        }

        // Set Origin
        tx.$origin = host.reference;

        // Set Umid
        tx.$umid = ActiveCrypto.Hash.getHash(JSON.stringify(tx));

        // Ip Address sending the transaction
        tx.$remoteAddr = ip;

        // Not supporting mutiple transactions yet
        if (tx.$multi) {
          // Multiple
          return resolve({
            statusCode: 400,
            content: "Multiple Transaction Not Implemented",
          });
        }

        // Make broadcast default, Unless single node network
        if (host.neighbourhood.count() < 4) {
          tx.$broadcast = false;
        } else if (!tx.$territoriality && !tx.$broadcast) {
          tx.$broadcast = true;
        }

        // If we got here everything is ok to send into internal
        // Now sending direct reducing http overhead
        Endpoints.DirectInternalInitalise(host, tx)
          .then((response: any) => {
            if (response.status == "200" && !response.data.error) {
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
              let i = nodes.length;
              while (i--) {
                summary.total++;
                if (tx.$nodes[nodes[i]].vote) summary.vote++;
                if (tx.$nodes[nodes[i]].commit) summary.commit++;

                // Manage Errors (Hides node on purpose)
                if (tx.$nodes[nodes[i]].error) {
                  if (summary.errors) {
                    summary.errors.push(tx.$nodes[nodes[i]].error as string);
                  } else {
                    summary.errors = [tx.$nodes[nodes[i]].error as string];
                  }
                }

                // Did this node have data to send to the client
                if (tx.$nodes[nodes[i]].return)
                  responses.push(tx.$nodes[nodes[i]].return);
              }

              // We have the entire network $tx object. This isn't something we want to return
              let output: ActiveDefinitions.LedgerResponse = {
                $umid: tx.$umid,
                $summary: summary,
                $streams: tx.$streams,
              };

              // Optional Responses to add
              if (responses.length) {
                output.$responses = responses;
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
            // Do something with the response before returning
            // If the status code is 100 and busy locks, We will convert it to a standard
            // If network isn't stable we will also convert to standard 200
            // ledger error for the SDK's to capture and manage
            // TODO: Reduce the amount of data to detect
            if (
              (error.status == "100" && error.error === "Busy Locks") ||
              error === "Network Not Stable"
            ) {
              return resolve(this.successfulFailure(error.error || error));
            } else {
              ActiveLogger.error(error, "Sent 500 Response (1000)");
              return reject({
                statusCode: 500,
                content: error,
              });
            }
          });
      } else {
        ActiveLogger.error("Sent 500 Response (1200)");
        return reject({
          statusCode: 500,
          content: "Invalid Transaction",
        });
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
   * @memberof Endpoints
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
   * @memberof Endpoints
   */
  public static InternalInitalise(host: Host, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      // Is the network stable?
      if (host.getStatus() != NeighbourStatus.Stable) {
        ActiveLogger.error("Sent 500 Response (1500)");
        return resolve({
          statusCode: 500,
          content: "Network Not Stable",
        });
      }

      // Cast Body
      let tx = body as ActiveDefinitions.LedgerEntry;
      // Send into host pool
      host
        .pending(tx)
        .then((ledger: any) => {
          return resolve({
            statusCode: ledger.status,
            content: ledger.data,
          });
        })
        .catch((error: any) => {
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
   * @memberof Endpoints
   */
  private static DirectInternalInitalise(
    host: Host,
    tx: ActiveDefinitions.LedgerEntry
  ): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Is the network stable?
      if (host.getStatus() != NeighbourStatus.Stable)
        return reject("Network Not Stable");

      // Targetted territoriality mapper
      if (tx.$territoriality) {
        // Cannot work with broadcast
        if (tx.$broadcast) {
          return reject("Territoriality not supported in broadcast mode");
        }

        // Get the sending node details
        let sending = host.terriMap(tx.$territoriality);

        // Do we know this territory node address
        if (sending) {
          ActiveLogger.info("Rebroadcasting to : " + sending);
          // If not ourselves intercept
          if (sending !== host.reference) {
            // We need to rebroadcast to sending node
            let rebroadcast = host.neighbourhood.get(sending);
            // Send and wait on their response
            rebroadcast
              .knock("", tx, true)
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
        .pending(tx)
        .then((ledger) => resolve(ledger))
        .catch((error) => reject(error));
    });
  }

  /**
   * Show the status of this host home node and its network
   *
   * @static
   * @param {Host} host
   * @param {string} requester
   * @returns {Promise<any>}
   * @memberof Endpoints
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
   * @memberof Endpoints
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
          ActiveLogger.error("Sent 500 Response (1600)");
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
   * @memberof Endpoints
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
   * @memberof Endpoints
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
   * @memberof Endpoints
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
   * @memberof Endpoints
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
   * @memberof Endpoints
   */
  public static postConvertor(
    host: Host,
    body: string,
    encryptHeader: boolean
  ): Promise<any> {
    return new Promise((resolve, reject) => {
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
        // body should now be a json string to be converted
        let bodyObject = JSON.parse(body);

        // Internal Transaction Messesing (Encrypted & Signing Security)
        if (bodyObject.$neighbour && bodyObject.$packet) {
          ActiveLogger.debug("Converting Signed for Post");

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
          if (ActiveOptions.get<any>("security", {}).signedConsensus) {
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
   * Creates a 200 return body with local error
   *
   * @private
   * @static
   * @param {string} error
   * @returns {*}
   * @memberof Endpoints
   */
  private static successfulFailure(error: string): any {
    return {
      statusCode: 200,
      content: {
        $umid: "",
        $summary: {
          total: 1,
          vote: 0,
          commit: 0,
          errors: [error],
        },
        $streams: {
          new: [],
          updated: [],
        },
      },
    };
  }
}
