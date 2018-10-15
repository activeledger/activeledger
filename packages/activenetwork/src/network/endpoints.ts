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

import * as restify from "restify";
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
   * @returns {restify.RequestHandler}
   * @memberof Endpoints
   */
  public static ExternalInitalise(host: Host): restify.RequestHandler {
    return (
      req: restify.Request,
      res: restify.Response
    ) => {
      // Check Transaction (Basic Validation Tests)
      if (req.body && ActiveDefinitions.LedgerTypeChecks.isEntry(req.body)) {
        let tx = req.body as ActiveDefinitions.LedgerEntry;

        // Set Date
        tx.$datetime = new Date();

        // Set Origin
        tx.$origin = host.reference;

        // Set Umid
        tx.$umid = ActiveCrypto.Hash.getHash(JSON.stringify(tx));

        // Not supporting mutiple transactions yet
        if (tx.$multi) {
          // Multiple
          return res.send(400, "Multiple Transaction Not Implemented");
        }

        // While the URL params are optional lets verify them.
        if (req.params.contract) {
          if (req.params.entry) {
            // Both defined
            if (
              req.params.contract != tx.$tx.$contract &&
              req.params.entry != tx.$tx.$entry
            ) {
              return res.send(400, "URL and Body Params don't match");
            }
          } else {
            // Default Entry
            if (req.params.contract != tx.$tx.$contract) {
              return res.send(400, "URL and Body Params don't match");
            }
          }
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

              return res.send(200, output);
            } else {
              return res.send(response.status, response.data);
            }
          })
          .catch(error => {
            // Do something with the response before returning
            return res.send(500, error);
          });
      } else {
        return res.send(500);
      }
    };
  }

  /**
   * Handle transaction request internally in the ledger. This is how all requests
   * will be submitted into each node's protocol process. Post convertor has already
   * dealt with the validation of the data
   *
   * @static
   * @param {Host} host
   * @returns {restify.RequestHandler}
   * @memberof Endpoints
   */
  public static InternalInitalise(host: Host): restify.RequestHandler {
    return (
      req: restify.Request,
      res: restify.Response
    ) => {
      // Make sure the requester is in the neighbourhood
      let neighbour = host.neighbourhood.get(
        req.header("X-Activeledger", "NA")
      );
      if (
        neighbour &&
        host.neighbourhood.checkFirewall(
          (req.headers["x-forwarded-for"] as string) ||
            (req.connection.remoteAddress as string)
        )
      ) {
        // Is the network stable?
        if (host.getStatus() != NeighbourStatus.Stable)
          return res.send(500, "Network Not Stable");

        // Cast Body
        let tx = req.body as ActiveDefinitions.LedgerEntry;

        // Send into host pool
        host
          .pending(tx)
          .then((ledger: any) => {
            res.send(ledger.status, ledger.data);
          })
          .catch((error: any) => {
            res.send(500, error);
          });
      } else {
        res.send(403);
      }
    };
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
   * @returns {restify.RequestHandler}
   * @memberof Endpoints
   */
  public static status(host: Host): restify.RequestHandler {
    return (
      req: restify.Request,
      res: restify.Response,
    ) => {
      ActiveLogger.warn(`Status Request - ${req.connection.remoteAddress}`);
      // Everyone can see this endpoint, Other Nodes just need 200 for now
      let requester = req.header("X-Activeledger", "NA");
      let neighbour = host.neighbourhood.get(requester);
      if (requester != "NA") {
        // Increase Count
        Endpoints.ipcThrottle++;

        // Is this a live request
        if (neighbour && !neighbour.graceStop) {
          res.send(200);
        } else {
          res.send(403);
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
        res.send(200, {
          status: host.getStatus(),
          reference: host.reference,
          left: Home.left.reference,
          right: Home.right.reference,
          neighbourhood: {
            neighbours: neighbours
          },
          pem: Home.publicPem
        });
      }
    };
  }

  /**
   * Return stream information stored on this node
   *
   * @static
   * @param {Host} host
   * @param {PouchDB} db
   * @returns {restify.RequestHandler}
   * @memberof Endpoints
   */
  public static streams(host: Host, db: any): restify.RequestHandler {
    return (
      req: restify.Request,
      res: restify.Response,
    ) => {
      // Make sure the requester is in the neighbourhood
      let neighbour = host.neighbourhood.get(
        req.header("X-Activeledger", "NA")
      );
      if (
        neighbour &&
        host.neighbourhood.checkFirewall(
          (req.headers["x-forwarded-for"] as string) ||
            (req.connection.remoteAddress as string)
        )
      ) {
        if (req.body.$streams) {
          // Restrict Access to any volatile requests
          let i = req.body.$streams.length;
          while (i--) {
            // Check that :volatile doesn't exist
            if (req.body.$streams[i].indexOf(":volatile") !== -1) {
              // End exectuion
              res.send(500);
              return;
            }
          }

          // Fetch Both State & Stream file with revisions
          // Search Options (Should add an index?)
          let options: any = {
            selector: {
              _id: {
                $in: req.body.$streams
              }
            }
          };

          // Request all data?
          if (!req.body.$allFields) {
            options.fields = ["_id", "_rev"];
          }

          // Search (Need Index?)
          db.find(options)
            .then((results: any) => {
              res.send(200, results.docs);
            })
            .catch((error: any) => {
              // Don't mind an error so lets say everyting is ok
              res.send(200, []);
            });
        } else {
          if (req.body.$stream && req.body.$rev) {
            // Restrict Access to any volatile requests
            // Check that :volatile doesn't exist
            if (req.body.$stream.indexOf(":volatile") !== -1) {
              // End exectuion
              res.send(500);
              return;
            }

            // Get the specific
            db.get(req.body.$stream, {
              _rev: req.body.$rev
            })
              .then((results: any) => {
                res.send(200, results);
              })
              .catch((error: any) => {
                // Don't mind an error so lets say everyting is ok
                res.send(200, []);
              });
          } else {
            // Bad Request
            res.send(500);
          }
        }
      } else {
        res.send(403);
      }
    };
  }

  /**
   * Return all stream information
   *
   * @static
   * @param {Host} host
   * @param {PouchDB} db
   * @returns {restify.RequestHandler}
   * @memberof Endpoints
   */
  public static all(host: Host, db: any): restify.RequestHandler {
    return (
      req: restify.Request,
      res: restify.Response,
    ) => {
      // Make sure the requester is in the neighbourhood
      let neighbour = host.neighbourhood.get(
        req.header("X-Activeledger", "NA")
      );
      if (
        neighbour &&
        host.neighbourhood.checkFirewall(
          (req.headers["x-forwarded-for"] as string) ||
            (req.connection.remoteAddress as string)
        )
      ) {
        if (req.params.start) {
          Endpoints.allFixListWithoutDocs(db, {
            limit: 500,
            start: req.params.start
          })
            .then(response => {
              res.send(
                200,
                response.data.rows
                  .map(Endpoints.allMap)
                  .filter(Endpoints.allFilter)
              );
            })
            .catch(() => {
              // Problem on the server
              res.send(500);
            });
        } else {
          // No Start Position
          Endpoints.allFixListWithoutDocs(db, { limit: 500 })
            .then(response => {
              res.send(
                200,
                response.data.rows
                  .map(Endpoints.allMap)
                  .filter(Endpoints.allFilter)
              );
            })
            .catch(() => {
              // Problem on the server
              res.send(500);
            });
        }
      } else {
        res.send(403);
      }
    };
  }

  /**
   * Fixed a bug in old db connector (davenport) list documents which exclude id by refactoring the object.
   *
   * @private
   * @static
   * @param {PouchDB} db
   * @param {*} options
   * @returns {Promise<any>}
   * @memberof Endpoints
   */
  private static allFixListWithoutDocs(db: any, options: any): Promise<any> {
    // Expose the whole object outside of ts
    let xDb = db as any;

    // Build up the get url and query
    let url = `${xDb.databaseUrl}/_all_docs?limit=${options.limit}`;

    // Start Key
    if (options.start) {
      // skip 3 (data, stream & volatile)
      // Only need to skip 2 because we will be starting with :stream (So will skip next data when 3)
      url += `&startkey="${options.start}"&skip=2`;
    }

    // Fetch from server
    return xDb.axios.get(url);
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
   * @returns {restify.RequestHandler}
   * @memberof Endpoints
   */
  public static postConvertor(host: Host): restify.RequestHandler {
    return (
      req: restify.Request,
      res: restify.Response,
      next: restify.Next
    ) => {
      // Post may contain encryption / verification
      if (req.getRoute().method == "POST") {
        // Internal Transaction Messesing (Encrypted & Signing Security)
        if (req.body && req.body.$neighbour && req.body.$packet) {
          ActiveLogger.trace(req.body, "Converting Signed for Post");

          // We don't encrypt to ourselve
          if (req.body.$neighbour.reference != host.reference) {
            // Decrypt Trasanction First (As Signing Pre Encryption)
            if (ActiveOptions.get<any>("security", {}).encryptedConsensus) {
              req.body.$packet = JSON.parse(
                Buffer.from(host.decrypt(req.body.$packet), "base64").toString()
              );
            }
          }

          // Verify Signature (but we do verify)
          if (ActiveOptions.get<any>("security", {}).signedConsensus) {
            if (
              !host.neighbourhood
                .get(req.body.$neighbour.reference)
                .verifySignature(
                  req.body.$neighbour.signature,
                  req.body.$packet
                )
            ) {
              // Bad Message
              return res.send(500, {
                status: 505,
                error: "Security Challenge Failure"
              });
            }
          }

          // Open signed post
          req.body = req.body.$packet;
        } else {
          // Is this an encrypted external transaction that need passing.
          if (req.header("X-Activeledger-Encrypt")) {
            try {
              // Decrypt
              req.body = JSON.parse(
                Buffer.from(host.decrypt(req.body), "base64").toString()
              );
            } catch {
              // Error trying to decrypt
              res.send(500, "Decryption Error");
              return;
            }
          }
        }
      }
      // Continue to handler
      next();
    };
  }
}
