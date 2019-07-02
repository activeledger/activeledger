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

import * as cluster from "cluster";
import * as http from "http";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveRequest,
  ActiveGZip
} from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { EventEngine } from "@activeledger/activequery";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints } from "./index";

/**
 * Process object used to manage an individual transaction
 *
 * @interface process
 */
interface process {
  entry: ActiveDefinitions.LedgerEntry;
  resolve: any;
  reject: any;
  protocol?: ActiveProtocol.Process;
}

/**
 * Hosted process for API and Protocol management
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
   * @type ActiveDSConnect
   * @memberof Host
   */
  private dbConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @private
   * @type ActiveDSConnect
   * @memberof Host
   */
  private dbErrorConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb vent instance for this node
   *
   * @private
   * @type ActiveDSConnect
   * @memberof Host
   */
  private dbEventConnection: ActiveDSConnect;

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
      // Broadcasting or Territoriality Mode
      if (entry.$broadcast) {
        // We may already have the $umid in memory
        if (this.processPending[entry.$umid]) {
          ActiveLogger.warn("Broadcast Recieved : " + entry.$umid);
          // Do we still have the transaction in memory?
          if (this.processPending[entry.$umid].protocol) {
            // Update other voting nodes response into the process handling the transaction
            this.processPending[entry.$umid].entry.$nodes[
              this.reference
            ] = this.processPending[entry.$umid].protocol!.updatedFromBroadcast(
              entry.$nodes
            );
          } else {
            // Need to target the correct worker to be updated
            this.moan("txtarget", entry);
          }

          return resolve({
            status: 200,
            data: this.processPending[entry.$umid].entry
          });
        }
      }

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
    this.dbConnection = new ActiveDSConnect(db.url + "/" + db.database);
    this.dbConnection.info();

    // Create connection string
    this.dbErrorConnection = new ActiveDSConnect(db.url + "/" + db.error);
    this.dbErrorConnection.info();

    // Create connection string
    this.dbEventConnection = new ActiveDSConnect(db.url + "/" + db.event);
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
          let body: Buffer[] = [];

          // Reads body data
          req.on("data", (chunk) => {
            body.push(chunk);
          });

          // When read has compeleted continue
          req.on("end", async () => {
            // Join the buffer storing the data
            let data = Buffer.concat(body);

            // gzipped?
            if (req.headers["content-encoding"] == "gzip") {
              data = await ActiveGZip.ungzip(data);
            }

            // All posted data should be JSON
            // Convert data for potential encryption
            Endpoints.postConvertor(
              this,
              data.toString(),
              ((req.headers["x-activeledger-encrypt"] as unknown) as boolean) ||
                false
            )
              .then((body) => {
                // Post Converted, Continue processing
                this.processEndpoints(req, res, body);
              })
              .catch((error) => {
                // Failed to convery respond;
                this.writeResponse(
                  res,
                  error.statusCode || 500,
                  JSON.stringify(error.content || {}),
                  req.headers["accept-encoding"] as string
                );
              });
          });
        } else {
          // Simple get, Continue Processing
          this.processEndpoints(req, res);
        }
      }
    );

    // Create Index
    this.dbConnection
      .createIndex({
        index: {
          fields: ["namespace", "type", "_id"]
        }
      })
      .then(() => {
        // Manage False postive warnings.
        // Find alternative way to capture rejections per message
        process.setMaxListeners(300);

        // Listen to master for Neighbour and Locker details
        process.on("message", (msg) => {
          switch (msg.type) {
            case "neighbour":
              if (
                Home.left.reference != msg.left ||
                Home.right.reference != msg.right
              )
                // Update Neighbour
                this.setNeighbours(false, msg.left, msg.right);
              break;
            case "isHome":
              // Update Home
              let neighbour = this.neighbourhood.get(msg.reference);
              if (neighbour && !neighbour.graceStop) {
                neighbour.isHome = msg.isHome;
              }
              break;
            case "hold":
              // Do we have a hold
              if (msg.lock) {
                // Yes, Continue Processing

                // Listen for unhandledRejects (Most likely thrown by Contract but its a global)
                // While it is global we need to manage it here to keep the encapsulation
                this.unhandledRejection[msg.umid] = (reason: any, p: any) => {
                  // Make sure the object exists
                  if (
                    this.processPending[msg.umid] &&
                    this.processPending[msg.umid].reject
                  ) {
                    this.processPending[msg.umid].reject(
                      `UnhandledRejection: ${reason.toString()} @ ${p.toString()}`
                    );
                  }
                  // Remove Locks
                  this.release(msg.umid);
                };

                // Add event listener
                process.on(
                  "unhandledRejection",
                  this.unhandledRejection[msg.umid]
                );

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
                  this.dbEventConnection,
                  new ActiveCrypto.Secured(
                    this.dbConnection,
                    this.neighbourhood.get(),
                    {
                      reference: Home.reference,
                      public: Home.publicPem,
                      private: Home.identity.pem
                    }
                  )
                );

                // Store Protocol Object
                this.processPending[msg.umid].protocol = protocol;

                // Bind to events
                // Manage on possible commits
                protocol.on("commited", (response: any) => {
                  // Make sure we have the object still
                  if (this.processPending[msg.umid]) {
                    // Poissbly blank response being relayed prevent [Object] output to terminal
                    if (response) {
                      // Send Response back
                      if (response.instant) {
                        ActiveLogger.debug(
                          this.processPending[msg.umid].entry,
                          "Transaction Currently Processing"
                        );
                      } else {
                        ActiveLogger.debug(response, "Transaction Processed");
                      }

                      // If Transaction rebroadcast if hybrid enabled
                      if (this.sse && response.tx) {
                        this.moan("hybrid", response.tx);
                      }
                    }

                    // Process response back into entry for previous neighbours to know the results
                    this.processPending[msg.umid].resolve({
                      status: 200,
                      data: this.processPending[msg.umid].entry
                    });
                    // Remove Locks
                    this.release(msg.umid);
                  }
                });

                // Manage Failure Messaging
                protocol.on("failed", (error: any) => {
                  ActiveLogger.debug(error, "TX Failed");
                  // Add this nodes error into the entry
                  this.processPending[msg.umid].entry.$nodes[
                    Home.reference
                  ].error = error.error;

                  // So if we send as resolve it should still work (Will it keep our error?)
                  this.processPending[msg.umid].resolve({
                    status: 200,
                    data: this.processPending[msg.umid].entry
                  });

                  // Remove Locks
                  this.release(msg.umid);
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
                      ActiveRequest.send(location, "POST", [], {
                        $tx: this.processPending[msg.umid].entry.$tx,
                        $selfsign: this.processPending[msg.umid].entry
                          .$selfsign,
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

                // Listen to the process to see if we need to broadcast the results
                protocol.on("broadcast", (entry: any) => {
                  ActiveLogger.debug("Broadcasting TX : " + msg.umid);
                  // Push entry into all worker (With threads will be shared memory)
                  // nodes so only reflect this node (Other nodes can't trust me anyway)
                  this.moan("txmem", {
                    $umid: entry.$umid,
                    $nodes: {
                      [this.reference]: entry.$nodes[this.reference]
                    }
                  });
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
                this.release(msg.umid);
              }
              break;
            case "release":
              // Did we release (Should always be yes)
              break;
            case "hybrid":
              delete msg.type;

              // Loop all connected client and send
              let i = this.sse.length;
              while (i--) {
                // Check for active connection
                if (this.sse[i] && !this.sse[i].finished) {
                  this.sse[i].write(
                    `event: message\ndata:${JSON.stringify(msg)}`
                  );
                  this.sse[i].write("\n\n");
                }
              }
              break;
            case "reload":
              // Reload Neighbourhood
              ActiveOptions.extendConfig()
                .then((config: any) => {
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

                    // Rebuild Network Territory Map
                    this.terriBuildMap();
                  }
                })
                .catch((e: any) => {
                  ActiveLogger.info(e, "Failed to reload Neighbourhood");
                });
              break;
            case "txmem":
              // Add tx into memory if we don't know about it in this worker
              if (!this.processPending[msg.$umid]) {
                // Add to pending (Using Promises instead of http request)
                this.processPending[msg.$umid] = {
                  entry: msg,
                  resolve: null,
                  reject: null
                };
              } else {
                // Log once
                ActiveLogger.debug("Adding To Memory : " + msg.$umid);
                // Now run the request as workers should have the umid in memory
                this.broadcast(msg.$umid);
              }
              break;
            case "txtarget":
              // Check process still exists could already be commited and VM closed
              if (
                this.processPending[msg.$umid] &&
                this.processPending[msg.$umid].protocol
              ) {
                // Update other voting nodes response into the process handling the transaction
                this.processPending[msg.$umid].entry.$nodes[
                  this.reference
                ] = this.processPending[
                  msg.$umid
                ].protocol!.updatedFromBroadcast(msg.$nodes);
              }
              break;
            case "txmemclear":
              // Remove from pending list
              this.destroy(msg.umid);
              break;
            default:
              ActiveLogger.debug(msg, "Worker -> Unknown IPC call");
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
      })
      .catch(() => {
        throw new Error("Couldn't create default index");
      });
  }

  /**
   * Attempt to clear memory for GV
   *
   * @private
   * @param {*} umid
   * @memberof Host
   */
  private destroy(umid: string): void {
    // Make sure it hasn't ben removed already
    if (this.processPending[umid]) {
      // Check Protocol still exists
      if (this.processPending[umid].protocol) {
        // Log once
        ActiveLogger.debug("Removing from memory : " + umid);
        (this.processPending[umid].protocol as any).destroy(umid);
        (this.processPending[umid].protocol as any) = null;
      }
      (this.processPending[umid] as any).entry = null;
      (this.processPending[umid] as any) = null;
    }
  }

  /**
   * Broadcast Transaction to the network
   *
   * @private
   * @param {string} umid
   * @memberof Host
   */
  private broadcast(umid: string): void {
    // Get all the neighbour nodes
    let neighbourhood = this.neighbourhood.get();
    let nodes = this.neighbourhood.keys();
    let i = nodes.length;
    let promises: any[] = [];

    // Final check object exists
    if (
      this.processPending[umid].entry.$nodes &&
      this.processPending[umid].entry.$nodes[this.reference]
    ) {
      // We only want to send our value
      const data = Object.assign(this.processPending[umid].entry, {
        $nodes: {
          [this.reference]: this.processPending[umid].entry.$nodes[
            this.reference
          ]
        }
      });

      // Loop them all and broadcast the transaction
      while (i--) {
        let node = neighbourhood[nodes[i]];

        // Make sure they're home and not us
        if (node.isHome && node.reference !== this.reference) {
          // Need to detect if we have already sent and got response for nodes for performance
          promises.push(node.knock("init", data));
        }
      }

      // Listen for promises
      Promise.all(promises)
        .then(() => {
          // Don't need to do anything on succusfful response
        })
        .catch(() => {
          // Keep broadcasting until promises fully resolve
          // Could be down nodes (So they can have 5 minute window to get back up)
          // Or connection issues. This doesn't stop commit phase as they will eventually call us.
          setTimeout(() => {
            this.broadcastResolver(umid);
          }, 500);
        });
    }
  }

  /**
   * Resolves broadcasted results
   *
   * @private
   * @param {string} umid
   * @memberof Host
   */
  private broadcastResolver(umid: string): void {
    // Check access to the protocol
    if (this.processPending[umid] && this.processPending[umid].protocol) {
      // Recast as connection errors found.
      ActiveLogger.warn("Rebroadcasting : " + umid);
      this.broadcast(umid);
    } else {
      // No longer in memory. Create a new error document outside protocol
      // We could have comitted but no idea we may have needed a rebroadcast back.
      let doc = {
        code: 1610,
        processed: false,
        umid: umid,
        // simulate tx for restore
        transaction: {
          $broadcast: true,
          $tx: {},
          $revs: {}
        },
        reason: "Failed to rebroadcast while in memory"
      };

      // Return
      this.dbErrorConnection.post(doc);
    }
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

    // Ask for locks
    this.moan("hold", { umid: v.$umid, streams: Object.assign(input, output) });
  }

  /**
   * Trigger a release of the stream locks the process owns
   *
   * @private
   * @param {string} v
   * @memberof Host
   */
  private release(umid: string) {
    // Get Pending Process
    if (this.processPending[umid]) {
      let v = this.processPending[umid].entry;

      // Build a list of streams to release
      // Would be good to cache this
      let input = Object.keys(v.$tx.$i || {});
      let output = Object.keys(v.$tx.$o || {});

      // Release unhandledRejection (Manages Memory)
      if (this.unhandledRejection[v.$umid] instanceof Function) {
        process.off("unhandledRejection", this.unhandledRejection[v.$umid]);
      }

      // Ask for releases
      this.moan("release", {
        umid: v.$umid,
        streams: Object.assign(input, output)
      });

      // Keep transaction in memory for a bit (5 Minutes)
      setTimeout(() => {
        // Remove from pending list
        this.destroy(umid);

        // Let other workers know they can release
        this.moan("txmemclear", { umid: umid });
      }, 20000); //300000
    }
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
    let requester = (req.headers["x-activeledger"] as string) || "NA";

    // Promise Response
    let response: Promise<any>;

    // Can we return compressed data?
    let gzipAccepted = req.headers["accept-encoding"] as string;

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
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
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
                return this.writeResponse(
                  res,
                  418,
                  "I'm a teapot",
                  gzipAccepted
                );
              }
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
          default:
            // All Stream Management with start point
            if (this.firewallCheck(requester, req)) {
              if (req.url) {
                let match = req.url.substr(0, 7);
                switch (match) {
                  case "/a/all/":
                    response = Endpoints.all(
                      this.dbConnection,
                      req.url.substr(7)
                    );
                    break;
                  case "/a/umid":
                    response = Endpoints.umid(
                      this.dbConnection,
                      req.url.substr(8)
                    );
                    break;
                  default:
                    // 404 Not Found
                    return this.writeResponse(
                      res,
                      404,
                      "Not Found",
                      gzipAccepted
                    );
                }
              } else {
                return this.writeResponse(res, 404, "Not Found", gzipAccepted);
              }
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
        }
        break;
      case "POST":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/": // Setup for accepting external transactions
            response = Endpoints.ExternalInitalise(
              this,
              body,
              req.connection.remoteAddress || "unknown"
            );
            break;
          case "/a/encrypt":
            // Make sure it was encrypted here
            response = Endpoints.ExternalEncrypt(
              this,
              body,
              ((req.headers["x-activeledger-encrypt"] as unknown) as boolean) ||
                false,
              this.dbConnection
            );
            // Pass db conntection
            break;
          case "/a/init": // Internal transactions
            if (this.firewallCheck(requester, req)) {
              response = Endpoints.InternalInitalise(this, body);
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            break;
          case "/a/stream": // Stream Data Management (Activerestore)
            if (this.firewallCheck(requester, req)) {
              response = Endpoints.streams(this.dbConnection, body);
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            break;
          default:
            return this.writeResponse(res, 404, "Not Found", gzipAccepted);
        }
        break;
      case "OPTIONS":
        // Accept all for now (Return Request Headers)
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers":
            (req.headers["access-control-request-headers"] as string) || "*",
          "X-Powered-By": "Activeledger"
        });
        res.end();
        return;
      default:
        return this.writeResponse(res, 404, "Not Found", gzipAccepted);
    }

    // Wait for promise to get the response
    response
      .then((response: any) => {
        // Write Header
        // All outputs are JSON and
        this.writeResponse(
          res,
          response.statusCode,
          JSON.stringify(response.content || {}),
          gzipAccepted
        );
      })
      .catch((error: any) => {
        // Write Header
        // Basic error handling for now. As a lot of errors will still be sent as ok responses.
        this.writeResponse(
          res,
          error.statusCode || 500,
          JSON.stringify(error.content || "Something has gone wrong"),
          gzipAccepted
        );
      });
  }

  /**
   * Write the response to the brwoser
   *
   * @private
   * @param {http.ServerResponse} res
   * @param {number} statusCode
   * @param {(string | Buffer)} content
   * @param {string} encoding
   * @memberof Host
   */
  private async writeResponse(
    res: http.ServerResponse,
    statusCode: number,
    content: string | Buffer,
    encoding: string
  ) {
    // Setup Default Headers
    let headers = {
      "Content-Type": "application/json",
      "Content-Encoding": "none",
      "Access-Control-Allow-Origin": "*",
      "X-Powered-By": "Activeledger"
    };

    // Modify output if can compress
    if (encoding == "gzip") {
      headers["Content-Encoding"] = "gzip";
      content = await ActiveGZip.gzip(content);
    }

    // Write the response
    res.writeHead(statusCode, headers);
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
        (req.headers["x-forwarded-for"] as string) ||
          (req.connection.remoteAddress as string)
      )
    );
  }
}
