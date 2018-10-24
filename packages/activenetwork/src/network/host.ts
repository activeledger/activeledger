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
import * as restify from "restify";
import * as http from "http";
//@ts-ignore
import * as corsMiddleware from "restify-cors-middleware";
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
   * @type {restify.Server}
   * @memberof Home
   */
  public readonly api: restify.Server = restify.createServer({
    name: "Activeledger System API",
    version: "2.0.0"
  });

  /**
   *  Server Sent events
   *
   * @private
   * @type {EventSource}
   * @memberof Host
   */
  private sse: any;

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

  private fetchHeader(headers: string[]): string {
    let i = headers.length;
    while (i--) {
      if (headers[i] === "X-Activeledger") {
        return headers[i + 1];
      }
    }
    return "NA";
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
    http
      .createServer((req, res) => {
        // Log Request
        ActiveLogger.trace(
          `Request - ${req.connection.remoteAddress} @ ${req.url}`
        );

        // Internal or External Request
        let requester = this.fetchHeader(req.rawHeaders);

        // Promise Response
        let response: Promise<any>;

        // Different endpoints switched on calling path
        switch (req.url) {
          case "/a/status":
            response = Endpoints.status2(
              this,
              requester
            );
            break;
          default:
            response = Endpoints.status2(
              this,
              requester
            );
            break;
        }

        // Wait for promise to get the response
        response
          .then((response: any) => {
            // Write Header
            // All outputs are JSON and 
            res.writeHead(response.statusCode, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "X-Powered-By": "Activeledger"
            });
            res.write(JSON.stringify(response.content || {}));
            res.end();
          })
          .catch((error: any) => {
            // Write Header
            // Basic error handling for now. As a lot of errors will still be sent as ok responses.
            res.writeHead(500, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "X-Powered-By": "Activeledger"
            });
            res.write(JSON.stringify({ error: "Something has gone wrong." }));
            res.end();
          });
      })
      .listen(3000, function() {
        console.log("server start at port 3000"); //the server object listens on port 3000
      });

    // Minimum Plugins 
    this.api.use(restify.plugins.jsonBodyParser());

    // Manage Sign for post
    this.api.use(Endpoints.postConvertor(this));

    // Manage CORS
    if (ActiveOptions.get<boolean>("CORS", false)) {
      const cors = corsMiddleware({
        origins: ActiveOptions.get<string[]>("CORS", ["*"])
      });

      // Bind to API
      this.api.pre(cors.preflight);
      this.api.use(cors.actual);
    }

    // Setup for the Neighbourhood endpoints
    this.api.get("/a/status", Endpoints.status(this));

    // Setup for accepting external transactions
    this.api.post("/", Endpoints.ExternalInitalise(this));

    // Internal transactions
    this.api.post("/a/init", Endpoints.InternalInitalise(this));

    // Stream Data Management (Activerestore)
    // Passing dbConnection as well due to being private
    this.api.post("/a/stream", Endpoints.streams(this, this.dbConnection));

    // All Stream Management
    this.api.get("/a/all", Endpoints.all(this, this.dbConnection));
    this.api.get("/a/all/:start", Endpoints.all(this, this.dbConnection));

    // Running Experimental hybrid mode? (Make sure we have all the flags)
    let experimental = ActiveOptions.get<any>("experimental", {});
    if (experimental && experimental.hybrid && experimental.hybrid.host) {
      this.sse = new (require("restify-eventsource"))({
        connections: experimental.hybrid.maxConnections
      });
      this.api.get("/hybrid/", this.sse.middleware());
    }

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
          this.sse.send(msg, "hybrid");
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
}
