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

import * as axios from "axios";
import * as cluster from "cluster";
import * as http from "http";
//@ts-ignore
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { EventEngine } from "@activeledger/activequery";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints } from "./index";
// @ts-ignore
import * as PouchDB from "pouchdb";
// @ts-ignore
import * as PouchDBFind from "pouchdb-find";
// Add Find Plugin
PouchDB.plugin(PouchDBFind);
/**
 * Process object used to manage an individual transaction
 *
 * @interface process
 */
interface process {
  entry: ActiveDefinitions.LedgerEntry;
  resolve: any;
  reject: any;
}

/**
 * Hosted process for API and Protocol management
 * TODO: Consider moving this into ActiveProtocol (Better Ciruclar Solution?)
 *
 * @export
 * @class Host
 * @extends {Home}
 */
export class Host extends Home {
  /**
   * All communications done via a single REST server
   * we will need to manage permissions and security to seperate the calls
   *
   * @type {http.Server}
   * @memberof Home
   */
  public readonly api: http.Server;

  /**
   * Server Sent events
   *
   * @private
   * @type {http.ServerResponse[]}
   * @memberof Host
   */
  private sse: http.ServerResponse[] = [];

  /**
   * Server connection to the couchdb instance for this node
   *
   * @private
   * @type PouchDB
   * @memberof Host
   */
  private dbConnection: any;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @private
   * @type PouchDB
   * @memberof Host
   */
  private dbErrorConnection: any;

  /**
   * Server connection to the couchdb vent instance for this node
   *
   * @private
   * @type PouchDB
   * @memberof Host
   */
  private dbEventConnection: any;

  /**
   * Holds the processPending requests before processing
   *
   * @private
   * @type {*}
   * @memberof Host
   */
  private processPending: {
    [reference: string]: process;
  } = {};

  /**
   * Holds reference for UnhandledRejectsion (From Contracts)
   * This means we can remove them from the listner
   *
   * @private
   * @type {{
   *     [reference: string]: any;
   *   }}
   * @memberof Host
   */
  private unhandledRejection: {
    [reference: string]: any;
  } = {};

  /**
   * Add process into pending
   *
   * @memberof Host
   */
  public pending(entry: ActiveDefinitions.LedgerEntry): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Add to pending (Using Promises instead of http request)
      this.processPending[entry.$umid] = {
        entry: entry,
        resolve: resolve,
        reject: reject
      };
      // Ask for hold
      this.hold(entry);
    });
  }

  /**
   * Creates an instance of Host.
   * @memberof Host
   */
  constructor() {
    super();

    // Cache db from options
    let db = ActiveOptions.get<any>("db", {});

    // Create connection string
    this.dbConnection = new PouchDB(db.url + "/" + db.database);
    this.dbConnection.info();

    // Create connection string
    this.dbErrorConnection = new PouchDB(db.url + "/" + db.error);
    this.dbErrorConnection.info();

    // Create connection string
    this.dbEventConnection = new PouchDB(db.url + "/" + db.event);
    this.dbEventConnection.info();

    // Create HTTP server for managing transaction requests
    this.api = http.createServer(
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        // Log Request
        ActiveLogger.debug(
          `Request - ${req.connection.remoteAddress} @ ${req.method}:${req.url}`
        );

        // Capture POST data
        if (req.method == "POST") {
          // Holds the body
          let body: string | any = "";

          // Reads body data
          req.on("data", chunk => {
            body += chunk.toString(); // convert Buffer to string
          });

          // When read has compeleted continue
          req.on("end", () => {
            // All posted data should be JSON
            // Convert data for potential encryption
            Endpoints.postConvertor(this, JSON.parse(body), this.fetchHeader(
              req.rawHeaders,
              "X-Activeledger-Encrypt",
              false
            ) as boolean)
              .then(body => {
                // Post Converted, Continue processing
                this.processEndpoints(req, res, body);
              })
              .catch(error => {
                // Failed to convery respond;
                this.writeResponse(
                  res,
                  error.statusCode || 500,
                  JSON.stringify(error.content || {})
                );
              });
          });
        } else {
          // Simple get, Continue Processing
          this.processEndpoints(req, res);
        }
      }
    );

    // Manage False postive warnings.
    // Find alternative way to capture rejections per message
    process.setMaxListeners(300);

    // Listen to master for Neighbour and Locker details
    process.on("message", msg => {
      switch (msg.type) {
        case "neighbour":
          if (
            Home.left.reference != msg.left ||
            Home.right.reference != msg.right
          )
            ActiveLogger.debug(msg, "New Neighbour Update");

          // Update Neighbour
          this.setNeighbours(false, msg.left, msg.right);
          break;
        case "isHome":
          // Update Home
          let neighbour = this.neighbourhood.get(msg.reference);
          if (neighbour && !neighbour.graceStop) {
            this.neighbourhood.get(msg.reference).isHome = msg.isHome;
          }
          break;
        case "hold":
          ActiveLogger.debug(msg, "Got Lock?");
          // Do we have a hold
          if (msg.lock) {
            // Yes, Continue Processing

            // Listen for unhandledRejects (Most likely thrown by Contract but its a global)
            // While it is global we need to manage it here to keep the encapsulation
            this.unhandledRejection[msg.umid] = (reason: any) => {
              ActiveLogger.fatal("Unhandled Rejection at:" + reason.toString());
              this.processPending[msg.umid].reject(
                "UnhandledRejection: " + reason.toString()
              );
              // Remove Locks
              this.release(this.processPending[msg.umid].entry);
            };

            // Add event listener
            process.on("unhandledRejection", this.unhandledRejection[msg.umid]);

            // Make sure we have the response object
            if (!this.processPending[msg.umid].entry.$nodes)
              this.processPending[msg.umid].entry.$nodes = {};

            // Setup this node response
            this.processPending[msg.umid].entry.$nodes[Home.reference] = {
              vote: false,
              commit: false
            };

            // Create new Protocol Process object for transaction
            let protocol: ActiveProtocol.Process = new ActiveProtocol.Process(
              this.processPending[msg.umid].entry,
              Home.host,
              Home.reference,
              Home.right,
              this.dbConnection,
              this.dbErrorConnection,
              this.dbEventConnection
            );

            // Bind to events
            // Manage on possible commits
            protocol.on("commited", (response: any) => {
              // Send Response back
              if (response.instant) {
                ActiveLogger.debug(response, "TX Maybe Commited");
              } else {
                ActiveLogger.debug(response, "TX Commited");
              }

              // If Transaction rebroadcast if hybrid enabled
              if (this.sse && response.tx) {
                this.moan("hybrid", response.tx);
              }

              // Process response back into entry for previous neighbours to know the results
              this.processPending[msg.umid].resolve({
                status: 200,
                data: this.processPending[msg.umid].entry
              });
              // Remove Locks
              this.release(this.processPending[msg.umid].entry);
            });

            // Manage Failure Messaging
            protocol.on("failed", error => {
              ActiveLogger.debug(error, "TX Failed");
              // Add this nodes error into the entry
              this.processPending[msg.umid].entry.$nodes[Home.reference].error =
                error.error;

              // So if we send as resolve it should still work (Will it keep our error?)
              this.processPending[msg.umid].resolve({
                status: 200,
                data: this.processPending[msg.umid].entry
              });

              // Remove Locks
              this.release(this.processPending[msg.umid].entry);
            });

            // Throw transaction to other ledgers
            protocol.on("throw", (response: any) => {
              ActiveLogger.info(response, "Throwing Transaction");

              // Prepare event emitter for response management
              const eventEngine = new EventEngine(
                this.dbEventConnection,
                this.processPending[msg.umid].entry.$tx.$contract
              );

              // Unique Phase
              eventEngine.setPhase("throw");

              if (response.locations && response.locations.length) {
                // Throw transaction to those locations
                let i = response.locations.length;
                while (i--) {
                  // Cache Location
                  let location = response.locations[i];
                  axios.default
                    .post(location, {
                      $tx: this.processPending[msg.umid].entry.$tx,
                      $selfsign: this.processPending[msg.umid].entry.$selfsign,
                      $sigs: this.processPending[msg.umid].entry.$sigs
                    })
                    .then((resp: any) => {
                      // Emit Event of successful connection to the ledger (May still have failed on the ledger)
                      eventEngine.emit("throw", {
                        success: true,
                        sentFrom: this.host,
                        sentTo: location,
                        $umid: msg.umid,
                        response: resp.data
                      });
                    })
                    .catch((error: any) => {
                      // Emit Event of error sending to the ledger
                      eventEngine.emit("throw", {
                        success: false,
                        sentFrom: this.host,
                        sentTo: location,
                        $umid: msg.umid,
                        response: error.toString()
                      });
                    });
                }
              }
            });

            // Start the process
            protocol.start();
          } else {
            // No, How to deal with it?
            this.processPending[msg.umid].resolve({
              status: 100,
              error: "Busy Locks"
            });

            // Remove Locks
            this.release(this.processPending[msg.umid].entry);
          }
          break;
        case "release":
          // Did we release (Should always be yes)
          if (msg.release) {
            // Will there be anything to do?
          }
          break;
        case "hybrid":
          delete msg.type;

          // Loop all connected client and send
          let i = this.sse.length;
          while (i--) {
            // Check for active connection
            if (this.sse[i] && !this.sse[i].finished) {
              this.sse[i].write(`event: message\ndata:${JSON.stringify(msg)}`);
              this.sse[i].write("\n\n");
            }
          }
          break;
        case "reload":
          // Reload Neighbourhood
          ActiveOptions.extendConfig()
            .then(config => {
              if (config.neighbourhood) {
                ActiveLogger.debug(config.neighbourhood, "Reset Request");

                // Reference would have changed
                Home.reference = this.reference = ActiveCrypto.Hash.getHash(
                  this.host +
                    this.port +
                    ActiveOptions.get<string>("network", ""),
                  "sha1"
                );

                // Prepare self for reset
                Home.left = new Neighbour(this.host, this.port);
                Home.right = new Neighbour(this.host, this.port);

                // Reset Network
                this.neighbourhood.reset(config.neighbourhood);
              }
            })
            .catch(e => {
              ActiveLogger.info(e, "Failed to reload Neighbourhood");
            });
          break;
        default:
          ActiveLogger.trace(msg, "Worker -> Unknown IPC call");
          break;
      }
    });

    // Listen to the Neighbourhood
    // May need to move this to outside the constructor.
    // - However you can add endpoints even after listening
    this.api.listen(ActiveInterfaces.getBindingDetails("port"), () => {
      ActiveLogger.info(
        "Worker (" +
          cluster.worker.id +
          ") listening on port " +
          ActiveInterfaces.getBindingDetails("port")
      );
    });
  }

  /**
   * Trigger a hold of the stream locks the process wants to own
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} v
   * @memberof Host
   */
  private hold(v: ActiveDefinitions.LedgerEntry) {
    // Build a list of streams to lock
    // Would be good to cache this
    let input = Object.keys(v.$tx.$i || {});
    let output = Object.keys(v.$tx.$o || {});

    // TODO :
    // If a single process, We can call locker here to save
    // CPU cycles

    // Ask for locks
    this.moan("hold", { umid: v.$umid, streams: Object.assign(input, output) });
  }

  /**
   * Trigger a release of the stream locks the process owns
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} v
   * @memberof Host
   */
  private release(v: ActiveDefinitions.LedgerEntry) {
    // Build a list of streams to release
    // Would be good to cache this
    let input = Object.keys(v.$tx.$i || {});
    let output = Object.keys(v.$tx.$o || {});

    // TODO :
    // If a single process, We can call locker here to save
    // CPU cycles

    // Release unhandledRejection (Manages Memory)
    if (this.unhandledRejection[v.$umid] instanceof Function) {
      process.off("unhandledRejection", this.unhandledRejection[v.$umid]);
    }

    this.moan("release", {
      // Ask for releases
      umid: v.$umid,
      streams: Object.assign(input, output)
    });
  }

  /**
   * Fetch custom header from request
   *
   * @private
   * @param {string[]} headers
   * @param {string} search
   * @param {boolean} [valueReturn=true]
   * @returns {(string | boolean)}
   * @memberof Host
   */
  private fetchHeader(
    headers: string[],
    search: string,
    valueReturn: boolean = true,
    valueDefault: any = "NA"
  ): string | boolean {
    // Make sure lower case search
    search = search.toLowerCase();
    // Loop Headers
    let i = headers.length;
    while (i--) {
      if (headers[i].toLowerCase() === search) {
        if (valueReturn) {
          return headers[i + 1];
        } else {
          return true;
        }
      }
    }

    // Not found returns
    return valueReturn ? valueDefault : false;
  }

  /**
   * Process Activeledger request endpoints
   *
   * @private
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {*} [body]
   * @memberof Host
   */
  private processEndpoints(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body?: any
  ) {
    // Internal or External Request
    let requester = this.fetchHeader(
      req.rawHeaders,
      "x-activeledger"
    ) as string;

    // Promise Response
    let response: Promise<any>;

    // Diffrent endpoints VERB
    switch (req.method) {
      case "GET":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/a/status": // Network Status Request
            response = Endpoints.status(this, requester);
            break;
          case "/a/all": // All Stream Management
            if (this.firewallCheck(requester, req)) {
              response = Endpoints.all(this.dbConnection);
            } else {
              return this.writeResponse(res, 403, "Forbidden");
            }
            break;
          case "/hybrid":
            let experimental = ActiveOptions.get<any>("experimental", {});
            if (
              experimental &&
              experimental.hybrid &&
              experimental.hybrid.host
            ) {
              // Connection Limiter
              if (experimental.hybrid.maxConnections > this.sse.length) {
                // Write the required header
                res.writeHead(200, {
                  Connection: "keep-alive",
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Access-Control-Allow-Origin": "*",
                  "X-Powered-By": "Activeledger"
                });
                // Add to response array
                let index = this.sse.push(res);
                // Listen for close and remove by index
                res.on("close", () => {
                  // Remove from array (-1 for correct index)
                  this.sse.splice(index - 1, 1);
                });
                return;
              } else {
                return this.writeResponse(res, 418, "I'm a teapot");
              }
            } else {
              return this.writeResponse(res, 403, "Forbidden");
            }
          default:
            // All Stream Management with start point
            if (req.url && req.url.substr(0, 7) == "/a/all/") {
              if (this.firewallCheck(requester, req)) {
                response = Endpoints.all(
                  this.dbConnection,
                  parseInt(req.url.substr(7))
                );
              } else {
                return this.writeResponse(res, 403, "Forbidden");
              }
            } else {
              // 404 Not Found
              return this.writeResponse(res, 404, "Not Found");
            }
        }
        break;
      case "POST":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/": // Setup for accepting external transactions
            response = Endpoints.ExternalInitalise(this, body);
            break;
          case "/a/init": // Internal transactions
            if (this.firewallCheck(requester, req)) {
              response = Endpoints.InternalInitalise(this, body);
            } else {
              return this.writeResponse(res, 403, "Forbidden");
            }
            break;
          case "/a/stream": // Stream Data Management (Activerestore)
            if (this.firewallCheck(requester, req)) {
              response = Endpoints.streams(this.dbConnection, body);
            } else {
              return this.writeResponse(res, 403, "Forbidden");
            }
            break;
          default:
            return this.writeResponse(res, 404, "Not Found");
        }
        break;
      case "OPTIONS":
        // Accept all for now
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "*",
          "X-Powered-By": "Activeledger"
        });
        res.end();
        return;
      default:
        return this.writeResponse(res, 404, "Not Found");
    }

    // Wait for promise to get the response
    response
      .then((response: any) => {
        // Write Header
        // All outputs are JSON and
        this.writeResponse(
          res,
          response.statusCode,
          JSON.stringify(response.content || {})
        );
      })
      .catch((error: any) => {
        // Write Header
        // Basic error handling for now. As a lot of errors will still be sent as ok responses.
        this.writeResponse(
          res,
          error.statusCode || 500,
          JSON.stringify(error.content || "Something has gone wrong")
        );
      });
  }

  /**
   * Write the response to the brwoser
   *
   * @private
   * @param {http.ServerResponse} res
   * @param {number} statusCode
   * @param {string} content
   * @memberof Host
   */
  private writeResponse(
    res: http.ServerResponse,
    statusCode: number,
    content: string
  ) {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Powered-By": "Activeledger"
    });
    res.write(content);
    res.end();
  }

  /**
   * Checks the local paramters to see if connection is allowed
   *
   * @private
   * @param {string} requester
   * @param {http.IncomingMessage} req
   * @returns {boolean}
   * @memberof Host
   */
  private firewallCheck(requester: string, req: http.IncomingMessage): boolean {
    return (
      requester !== "NA" &&
      this.neighbourhood.checkFirewall(
        (this.fetchHeader(
          req.rawHeaders,
          "x-forwarded-for",
          true,
          ""
        ) as string) || (req.connection.remoteAddress as string)
      )
    );
  }
}
