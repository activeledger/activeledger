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

import { Server, IncomingMessage, ServerResponse, createServer } from "http";
import { fork, ChildProcess } from "child_process";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveGZip
} from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints } from "./index";
import { Locker } from "./locker";
import { PhysicalCores } from "./cpus";

// TODO: Check .send doesn't error if it does rebuild processor

/**
 * Process object used to manage an individual transaction
 *
 * @interface process
 */
interface process {
  entry: ActiveDefinitions.LedgerEntry;
  resolve: any;
  reject: any;
  pid: number;
}

/**
 * Setup object for a processor process
 *
 * @interface setup
 */
interface setup {
  type: string;
  data: {
    self: string;
    reference: string;
    right: Neighbour;
    neighbourhood: {
      [reference: string]: Neighbour;
    };
    pubPem: string;
    privPem: any;
    db: any;
    __base: unknown;
  };
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
   * @type {Server}
   * @memberof Home
   */
  public readonly api: Server;

  /**
   * Server Sent events
   *
   * @private
   * @type {ServerResponse[]}
   * @memberof Host
   */
  private sse: ServerResponse[] = [];

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
   * How many cpu processors have said they're ready
   *
   * @private
   * @memberof Host
   */
  private cpuReady = 0;

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
          // Process Assigned?
          if (this.processPending[entry.$umid].pid) {
            // Find Processor to send in the broadcast message
            this.findProcessor(this.processPending[entry.$umid].pid)!.send({
              type: "broadcast",
              data: {
                umid: entry.$umid,
                nodes: entry.$nodes
              }
            });
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
        reject: reject,
        pid: 0
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
    this.api = createServer((req: IncomingMessage, res: ServerResponse) => {
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
    });

    // Create Index
    this.dbConnection
      .createIndex({
        index: {
          fields: ["namespace", "type", "_id"]
        }
      })
      .then(() => {
        // How many threads (Cache so we can check on ready)
        const cpuTotal = PhysicalCores.count();

        // Processor Setup Values
        const setup: setup = {
          type: "setup",
          data: {
            self: Home.host,
            reference: Home.reference,
            right: Home.right,
            neighbourhood: this.neighbourhood.get(),
            pubPem: Home.publicPem,
            privPem: Home.identity.pem,
            db: ActiveOptions.get<any>("db", {}),
            __base: ActiveOptions.get("__base", __dirname)
          }
        };

        // Setup Processors
        for (let i = 0; i < cpuTotal; i++) {
          // Add process into array
          const processor = this.createProcessor(setup, cpuTotal);
          // Add to list
          this.processors.push(processor);
          // Setup
          processor.send(setup);
        }

        // Setup Iterator
        this.processorIterator = this.processors[Symbol.iterator]();
      })
      .catch((e) => {
        throw new Error("Couldn't create default index");
      });
  }

  /**
   * Creator a processor thread (by process)
   *
   * @private
   * @returns {ChildProcess}
   * @memberof Host
   */
  private createProcessor(setup: setup, cpuTotal?: number): ChildProcess {
    // Create Process
    const pFork = fork(`${__dirname}\\process.js`, [], {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    // Listen for message to respond to waiting http
    pFork.on("message", (m) => {
      // Cache Pending Reference
      const pending = this.processPending[m.data.umid];

      // Check data for self to update
      if (m.data.nodes) {
        //pending.entry.$nodes[this.reference] = m.data.self;
        pending.entry.$nodes = {
          ...pending.entry.$nodes,
          ...m.data.nodes
        };
      }

      // Switch on type of messages from processors
      switch (m.type) {
        case "failed":
          // So if we send as resolve it should still work (Will it keep our error?)
          pending.resolve({
            status: 200,
            data: pending.entry
          });
          // Remove Locks
          this.release(pending);
          break;
        case "commited":
          // Process response back into entry for previous neighbours to know the results
          pending.resolve({
            status: 200,
            data: { ...pending.entry, ...m.data.entry }
          });
          // Remove Locks
          this.release(pending);

          // Post Reply Processing
          if (m.data) {
            // If Transaction rebroadcast if hybrid enabled
            if (this.sse && m.data.tx) {
              let i = this.sse.length;
              while (i--) {
                // Check for active connection
                if (this.sse[i] && !this.sse[i].finished) {
                  this.sse[i].write(
                    `event: message\ndata:${JSON.stringify(pending.entry)}`
                  );
                  this.sse[i].write("\n\n");
                }
              }
            }
          }
          break;
        case "broadcast":
          ActiveLogger.debug("Broadcasting TX : " + m.data.$umid);
          this.broadcast(m.data.umid);
          break;
        case "reload":
          this.reload();
          break;
        case "ready":
          // Check that we should be counting
          if (cpuTotal) {
            // Increase Ready Counter
            this.cpuReady++;
            // If not listening and have enough cpu returns (Covers crashes)
            if (!this.api.listening && this.cpuReady >= cpuTotal) {
              // Listen to the Neighbourhood
              this.api.listen(
                ActiveInterfaces.getBindingDetails("port"),
                () => {
                  ActiveLogger.info(
                    "Activeledger listening on port " +
                      ActiveInterfaces.getBindingDetails("port")
                  );
                }
              );
            }
          }
          break;
        case "unhandledrejection":
          // So if we send as resolve it should still work
          pending.resolve({
            status: 200,
            data: "UnhandledRejection Error"
          });
          // Remove Locks
          this.release(pending);
          break;
        default:
          ActiveLogger.fatal(m, "Unknown IPC Call");
          break;
      }
    });

    // Recreate a new subprocessor
    pFork.on("error", (error) => {
      ActiveLogger.fatal(error, "Processor Crashed");
      // Look for any transactions which are in this processor
      const pendings = Object.keys(this.processPending);
      pendings.forEach((key) => {
        // Get Transaction
        const pending = this.processPending[key];
        // Was this transaction in the broken processor
        if (pending.pid === pFork.pid) {
          // Resolve to return oprhened transactions
          pending.resolve({
            status: 200,
            data: pending.entry
          });

          // Clear Internal
          (pending as any).entry = null;
          (pending as any) = null;
        }
      });
      // find from processors list
      const pos = this.processors.findIndex((processor) => {
        return processor.pid === pFork.pid;
      });
      // Remove from processors list
      if (pos) {
        this.processors.splice(pos, 1);
      }
      // We should now create a new processor
      const processor = this.createProcessor(setup);
      // Add to list
      this.processors.push(processor);
      // Setup
      processor.send(setup);
    });

    return pFork;
  }

  /**
   * Reload the configuration
   *
   * @private
   * @memberof Host
   */
  private reload() {
    // Reload Neighbourhood
    ActiveOptions.extendConfig()
      .then((config: any) => {
        if (config.neighbourhood) {
          ActiveLogger.debug(config.neighbourhood, "Reset Request");

          // Reference would have changed
          Home.reference = this.reference = ActiveCrypto.Hash.getHash(
            this.host + this.port + ActiveOptions.get<string>("network", ""),
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
        // Now to make sure all other processors reload
        this.processors.forEach((processor) => {
          processor.send({
            type: "reload",
            data: {
              reference: Home.reference,
              right: Home.right,
              neighbourhood: this.neighbourhood.get()
            }
          });
        });
      })
      .catch((e: any) => {
        ActiveLogger.info(e, "Failed to reload Neighbourhood");
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
      // Pass destory message to processor
      this.findProcessor(this.processPending[umid].pid)!.send({
        type: "destory",
        data: {
          umid
        }
      });
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
    if (this.processPending[umid]) {
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
    if (Locker.hold([...input, ...output])) {
      // Get next process from the array
      const robin = this.getRobin();

      // Make sure we have the response object
      if (!this.processPending[v.$umid].entry.$nodes)
        this.processPending[v.$umid].entry.$nodes = {};

      // Setup this node response
      this.processPending[v.$umid].entry.$nodes[Home.reference] = {
        vote: false,
        commit: false
      };

      // Remember who got selected
      this.processPending[v.$umid].pid = robin.pid;

      // Pass transaction to sub processor
      robin.send({
        type: "tx",
        entry: this.processPending[v.$umid].entry
      });
      return;
    } else {
      // No, How to deal with it?
      this.processPending[v.$umid].resolve({
        status: 100,
        error: "Busy Locks"
      });
    }
  }

  /**
   * Gets next processor in the list (Doesn't account for load)
   *
   * @private
   * @returns {ChildProcess}
   * @memberof Host
   */
  private getRobin(): ChildProcess {
    // Get next processes in queue
    let robin = this.processorIterator.next().value;

    // Do we need to reset?
    if (!robin) {
      this.processorIterator = this.processors[Symbol.iterator]();
      return this.processorIterator.next().value;
    }
    return robin;
  }

  /**
   * Trigger a release of the stream locks the process owns
   *
   * @private
   * @param {string} v
   * @memberof Host
   */
  private release(pending: process) {
    // Build a list of streams to release
    // Would be good to cache this
    const input = Object.keys(pending.entry.$tx.$i || {});
    const output = Object.keys(pending.entry.$tx.$o || {});

    // Ask for releases
    Locker.release([...input, ...output]);

    // Keep transaction in memory for a bit (5 Minutes)
    setTimeout(() => {
      // Remove from pending list
      if (pending.entry) {
        this.destroy(pending.entry.$umid);
      }
    }, 300000); //20000
  }

  /**
   * Process Activeledger request endpoints
   *
   * @private
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {*} [body]
   * @memberof Host
   */
  private processEndpoints(
    req: IncomingMessage,
    res: ServerResponse,
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
   * @param {ServerResponse} res
   * @param {number} statusCode
   * @param {(string | Buffer)} content
   * @param {string} encoding
   * @memberof Host
   */
  private async writeResponse(
    res: ServerResponse,
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
   * @param {IncomingMessage} req
   * @returns {boolean}
   * @memberof Host
   */
  private firewallCheck(requester: string, req: IncomingMessage): boolean {
    return (
      requester !== "NA" &&
      this.neighbourhood.checkFirewall(
        (req.headers["x-forwarded-for"] as string) ||
          (req.connection.remoteAddress as string)
      )
    );
  }
}
