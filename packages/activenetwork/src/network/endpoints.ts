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

import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Host } from "./host";
import { Home } from "./home";
import { NeighbourStatus } from "./neighbourhood";

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
  public static ipcThrottle: number = 0;

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
  public static ExternalInitalise(host: Host, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      // Check Transaction (Basic Validation Tests)
      if (body && ActiveDefinitions.LedgerTypeChecks.isEntry(body)) {
        let tx = body as ActiveDefinitions.LedgerEntry;

        // Set Date
        tx.$datetime = new Date();

        // Set Origin
        tx.$origin = host.reference;

        // Set Umid
        tx.$umid = ActiveCrypto.Hash.getHash(JSON.stringify(tx));

        // Not supporting mutiple transactions yet
        if (tx.$multi) {
          // Multiple
          return resolve({
            statusCode: 400,
            content: "Multiple Transaction Not Implemented"
          });
        }

        // Make broadcast default
        if (!tx.$territoriality && !tx.$broadcast) {
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
                commit: 0
              };

              // Get nodes to cound
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
              }

              // We have the entire network $tx object. This isn't something we want to return
              let output: ActiveDefinitions.LedgerResponse = {
                $umid: tx.$umid,
                $summary: summary,
                $streams: tx.$streams
              };

              // Append Debug View
              if (ActiveOptions.get<boolean>("debug", false)) {
                output.$debug = tx;
              }

              return resolve({
                statusCode: 200,
                content: output
              });
            } else {
              // If we had to be rebroadcasted this isn't an error
              if (response.rebroadcasted) {
                return resolve({
                  statusCode: 200,
                  content: response.data
                });
              } else {
                return resolve({
                  statusCode: response.status,
                  content: response.data
                });
              }
            }
          })
          .catch(error => {
            // Do something with the response before returning
            return reject({
              statusCode: 500,
              content: error
            });
          });
      } else {
        return reject({
          statusCode: 500,
          content: "Invalid Transaction"
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
      if (host.getStatus() != NeighbourStatus.Stable)
        return resolve({
          statusCode: 500,
          content: "Network Not Stable"
        });

      // Cast Body
      let tx = body as ActiveDefinitions.LedgerEntry;

      // Send into host pool
      host
        .pending(tx)
        .then((ledger: any) => {
          return resolve({
            statusCode: ledger.status,
            content: ledger.data
          });
        })
        .catch((error: any) => {
          return reject({
            statusCode: 500,
            content: error
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
              .then(ledger => {
                // Add rebroadcast flag
                ledger.rebroadcasted = true;
                resolve(ledger);
              })
              .catch(error => {
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
        .then(ledger => resolve(ledger))
        .catch(error => reject(error));
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
        Endpoints.ipcThrottle++;

        // Is this a live request
        if (neighbour && !neighbour.graceStop) {
          resolve({
            statusCode: 200
          });
        } else {
          resolve({
            statusCode: 403
          });
        }

        // When should we rebase
        if (
          Endpoints.ipcThrottle > ActiveOptions.get<number>("ipcThrottle", 8)
        ) {
          // However we can trigger a "rebase" of the ordering if this comes from a node we think is offline
          host.moan("rebase");
          Endpoints.ipcThrottle = 0;
        }
      } else {
        // Prevent circular (Added since no longer creating new left / right using reference for easy identity)
        // Status shouldn't be called much in comparison
        let neighbourhood = host.neighbourhood.get();
        let keys = Object.keys(neighbourhood);
        let i = keys.length;
        let neighbours: { [index: string]: object } = {};

        // Loop and build (reduced output now)
        // Hide Host & Port for now (May enable for authenticated requests)
        while (i--) {
          let neighbour = neighbourhood[keys[i]];
          if (!neighbour.graceStop) {
            neighbours[neighbour.reference] = {
              isHome: neighbour.isHome
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
              neighbours: neighbours
            },
            pem: Home.publicPem
          }
        });
      }
    });
  }

  /**
   * Return stream information stored on this node
   *
   * @static
   * @param {*} db
   * @param {*} body
   * @returns {Promise<any>}
   * @memberof Endpoints
   */
  public static streams(db: any, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (body.$streams) {
        // Restrict Access to any volatile requests
        let i = body.$streams.length;
        while (i--) {
          // Check that :volatile doesn't exist
          if (body.$streams[i].indexOf(":volatile") !== -1) {
            // End exectuion
            return reject({
              statusCode: 403,
              content: "Request not allowed"
            });
          }
        }

        // Fetch Both State & Stream file with revisions
        // Search Options (Should add an index?)
        let options: any = {
          selector: {
            _id: {
              $in: body.$streams
            }
          }
        };

        // Request all data?
        if (!body.$allFields) {
          options.fields = ["_id", "_rev"];
        }

        // Search (Need Index?)
        db.find(options)
          .then((results: any) => {
            return resolve({
              statusCode: 200,
              content: results.docs
            });
          })
          .catch((error: any) => {
            // Don't mind an error so lets say everyting is ok
            return resolve({
              statusCode: 200,
              content: []
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
              content: "Request not allowed"
            });
          }

          // Get the specific
          db.get(body.$stream, {
            _rev: body.$rev
          })
            .then((results: any) => {
              return resolve({
                statusCode: 200,
                content: results
              });
            })
            .catch((error: any) => {
              // Don't mind an error so lets say everyting is ok
              return resolve({
                statusCode: 200,
                content: []
              });
            });
        } else {
          // Bad Request
          return reject({
            statusCode: 500,
            content: "Internal Server Error"
          });
        }
      }
    });
  }

  /**
   * Return all stream information
   *
   * @static
   * @param {*} db
   * @param {*} [start]
   * @returns {Promise<any>}
   * @memberof Endpoints
   */
  public static all(db: any, start?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      // Setup Search Options
      let options: any = { limit: 500 };
      if (start) {
        options.startkey = start;
        options.skip = 2;
      }

      db.allDocs(options)
        .then((response: any) => {
          resolve({
            statusCode: 200,
            content: response.rows
              .map(Endpoints.allMap)
              .filter(Endpoints.allFilter)
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
          return reject({
            statusCode: 500,
            content: "Decryption Error"
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
            if (ActiveOptions.get<any>("security", {}).encryptedConsensus) {
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
              return reject({
                statusCode: 500,
                content: "Security Challenge Failure"
              });
            }
          }

          // Open signed post
          return resolve(bodyObject.$packet);
        } else {
          // Resolve as just the object
          resolve(bodyObject);
        }
      }
    });
  }
}
