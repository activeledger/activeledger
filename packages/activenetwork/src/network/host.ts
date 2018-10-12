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
//@ts-ignore
import * as corsMiddleware from "restify-cors-middleware";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { EventEngine } from "@activeledger/activequery";
import Client, { CouchDoc, configureDatabase } from "davenport";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints } from "./index";

/**
 *
 *
 * @interface process
 */
interface process {
  entry: ActiveDefinitions.LedgerEntry;
  response: restify.Response;
  unhandled?: string;
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
   * @type Client<CouchDoc>
   * @memberof Host
   */
  private dbConnection: Client<CouchDoc>;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @private
   * @type Client<CouchDoc>
   * @memberof Host
   */
  private dbErrorConnection: Client<CouchDoc>;

  /**
   * Server connection to the couchdb vent instance for this node
   *
   * @private
   * @type Client<CouchDoc>
   * @memberof Host
   */
  private dbEventConnection: Client<CouchDoc>;

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
   * Add process into pending
   *
   * @memberof Host
   */
  public pending(v: {
    entry: ActiveDefinitions.LedgerEntry;
    response: restify.Response;
  }) {
    // Add to pending
    this.processPending[v.entry.$umid] = v;
    // Ask for hold
    this.hold(v.entry);
  }

  /**
   * Creates an instance of Host.
   * @memberof Host
   */
  constructor() {
    super();

    // Cache db from options
    let db = ActiveOptions.get<any>("db", {});

    // Make sure the database exists (main)
    configureDatabase(db.url, {
      name: db.database
    });

    // Make sure the database exists (error)
    configureDatabase(db.url, {
      name: db.error
    });

    // Make sure the database exists (event)
    configureDatabase(db.url, {
      name: db.event
    });

    // Create connection string
    this.dbConnection = new Client(db.url, db.database);

    // Create connection string
    this.dbErrorConnection = new Client(db.url, db.error);

    // Create connection string
    this.dbEventConnection = new Client(db.url, db.event);

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
    // this.api.get("/a/right", Endpoints.right(this));
    // this.api.get("/a/left", Endpoints.left(this));
    this.api.post("/a/init", Endpoints.InternalInitalise(this));

    // Setup for accepting internal transactions

    // Setup for accepting external transactions
    this.api.post("/", Endpoints.ExternalInitalise(this));

    // Stream Data Management (Activerestore)
    // Passing dbConnection as well due to being private
    this.api.post("/a/stream", Endpoints.streams(this, this.dbConnection));

    // All Stream Management
    this.api.get("/a/all", Endpoints.all(this, this.dbConnection));
    this.api.get("/a/all/:start", Endpoints.all(this, this.dbConnection));

    // Backwards compatible endpoints

    // Debuggable Endpoints
    //if (process.env.NODE_ENV != "production")
    //  this.api.get("/neighbourhood/expose", Endpoints.expose(this));

    // Running Experimental hybrid mode? (Make sure we have all the flags)
    let experimental = ActiveOptions.get<any>("experimental", {});
    if (experimental && experimental.hybrid && experimental.hybrid.host) {
      this.sse = new (require("restify-eventsource"))({
        connections: experimental.hybrid.maxConnections
      });
      this.api.get("/hybrid/", this.sse.middleware());
    }

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
            // Will this cause havok with memory keep having listeners
            process.on("unhandledRejection", (reason, p) => {
              ActiveLogger.fatal("Unhandled Rejection at:" + reason.toString());
              if (!this.processPending[msg.umid].response.headersSent) {
                this.processPending[msg.umid].response.send(500, {
                  error: "UnhandledRejection: " + reason.toString()
                });

                // Remove Locks
                this.release(this.processPending[msg.umid].entry);
              }
            });

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
              // Check headers haven't already been sent
              if (!this.processPending[msg.umid].response.headersSent) {
                this.processPending[msg.umid].response.send(
                  200,
                  this.processPending[msg.umid].entry
                );

                // Remove Locks
                this.release(this.processPending[msg.umid].entry);
              }
            });

            // Manage Failure Messaging
            protocol.on("failed", error => {
              ActiveLogger.debug(error, "TX Failed");

              // Check headers haven't already been sent
              if (!this.processPending[msg.umid].response.headersSent) {
                // Add this nodes error into the entry
                this.processPending[msg.umid].entry.$nodes[
                  Home.reference
                ].error = error.error;

                // So if we send as 200 it should still work (Will it keep our error?)
                this.processPending[msg.umid].response.send(
                  200,
                  this.processPending[msg.umid].entry
                );

                // Remove Locks
                this.release(this.processPending[msg.umid].entry);
              }
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
                    .then((resp:any) => {
                      // Emit Event of successful connection to the ledger (May still have failed on the ledger)
                      eventEngine.emit("throw", {
                        success: true,
                        sentFrom: this.host,
                        sentTo: location,
                        $umid: msg.umid,
                        response: resp.data
                      });
                    })
                    .catch((error:any) => {
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
            this.processPending[msg.umid].response.send(200, {
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

    // Ask for releases
    this.moan("release", {
      umid: v.$umid,
      streams: Object.assign(input, output)
    });
  }
}
