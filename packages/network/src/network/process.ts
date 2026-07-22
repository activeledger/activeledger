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

import { ActiveDSConnect, ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveProtocol } from "@activeledger/activeprotocol";

// Maximum memory used in VM processor
const MAX_MEMORY_MB =
  ActiveOptions.get<number>("max_memory", 1500) * 1024 * 1024;

/**
 * Bare minimum data needed to make a home
 *
 * @interface IMakeHome
 */
interface IMakeHome {
  reference: string;
  self: string;
  pubPem: string;
  privPem: string;
}

/**
 * Initial setup for the Processor
 *
 * @interface ISetup
 * @extends {IMakeHome}
 */
interface ISetup extends IMakeHome {
  right: any;
  neighbours: { [reference: string]: Neighbour };
  db: any;
}

interface IContractCaches {
  [contractName: string]: string | any;
}

/**
 * Main entry for running Activeledger sub processors.
 *
 * @class Processor
 */
class Processor {
  /**
   *
   *
   * @private
   * @type {ActiveDSConnect}
   */
  private db: ActiveDSConnect;

  /**
   *
   *
   * @private
   * @type {ActiveDSConnect}
   */
  private dbe: ActiveDSConnect;

  /**
   *
   *
   * @private
   * @type {ActiveDSConnect}
   */
  private dbev: ActiveDSConnect;

  /**
   *
   *
   * @private
   * @type {ActiveCrypto.Secured}
   */
  private secured: ActiveCrypto.Secured;

  /**
   *
   *
   * @private
   * @type {{ [reference: string]: Neighbour }}
   */
  private neighbourhood: { [reference: string]: Neighbour };

  /**
   *
   *
   * @private
   * @type {{
   *     [umid: string]: any;
   *   }}
   */
  private unhandledRejection: {
    [umid: string]: any;
  } = {};

  /**
   *
   *
   * @private
   * @type {{
   *     [umid: string]: ActiveProtocol.Process;
   *   }}
   */
  private protocols: {
    [umid: string]: ActiveProtocol.Process;
  } = {};

  /**
   * Cache we already sent the stop sending tx signal
   *
   * @private
   */
  private maxMemoryReached = false;

  /**
   * Holds the latest version number for a generic contract request
   *
   * @private
   * @type {IContractCaches}
   */
  private latestContractVersion: IContractCaches = {};

  /**
   * Holds the latest version number for a generic contract request
   *
   * @private
   * @type {IContractCaches}
   */
  private latestContractData: IContractCaches = {};

  constructor() {
    // Initalise CLI Options
    ActiveOptions.init();

    // Now we can parse configuration
    ActiveOptions.parseConfig();

    // Enable Extended Debugging
    ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

    // Listen for IPC (Interprocess Communication)
    process.on("message", (m: any) => {
      switch (m.type) {
        case "setup":
          // Set Database (Do we need to?)
          ActiveOptions.set("db", m.data.db);
          // Setup Paths
          ActiveOptions.set("__base", m.data.__base);
          // Extend from Database
          ActiveOptions.extendConfig()
            .then(() => {
              // Setup Processor
              this.setup(m.data);
            })
            .catch((e) => {
              ActiveLogger.fatal(e, "Config Extension Issues");
            });
          break;
        case "hk":
          this.housekeeping(m.data.right ?? Home.right, m.data.neighbourhood);
          break;
        case "tx":
          // Create new Protocol Process object for transaction
          this.protocols[m.entry.$umid] = new ActiveProtocol.Process(
            m.entry,
            Home.host,
            Home.reference,
            Home.right,
            this.db,
            this.dbe,
            this.dbev,
            this.secured
          );

          // Listen for unhandledRejects (Most likely thrown by Contract but its a global)
          // While it is global we need to manage it here to keep the encapsulation
          this.unhandledRejection[m.entry.$umid] = (reason: Error) => {
            // Make sure the object exists
            if (
              this.protocols[m.entry.$umid] &&
              !(this.protocols[m.entry.$umid] as any).unhandled
            ) {
              // Reason should always be an error but checking to prevent cascade of error problems
              ActiveLogger.warn(
                {
                  name: reason?.name ?? "Unknown",
                  message: reason?.message ?? "Unknown",
                  stack: reason?.stack ?? "Unknown",
                },
                "UnhandledRejection - " + m.entry.$umid
              );
              this.unhandled(m.entry, reason);
              // Only call once (TODO remove any)
              (this.protocols[m.entry.$umid] as any).unhandled = true;
            }
          };

          // Event: Manage Unhandled Rejections from VM
          process.on(
            "unhandledRejection",
            this.unhandledRejection[m.entry.$umid]
          );

          // Event: Manage Commits
          this.protocols[m.entry.$umid].on("commited", (response: any) => {
            this.committed(m.entry, response);
          });

          // Event: Manage Failed
          this.protocols[m.entry.$umid].on("failed", (error: any) => {
            // Clear contract data cache, This should fixed with SPI
            // however it is ineffiecent due to the fact all errors will reset contract data
            // TODO: find better location to catch and throw if its contract data relevent
            // SPI is fixing it, This just makes sure the cache gets cleared.
            // (Maybe the throw at rev check instead on cache will work, as this could cause unnessary fetching)
            const contract = m.entry.$tx.$contract.substring(0, 64);
            if (this.latestContractData[contract]) {
              this.send("contractData", {
                contract: contract,
                data: null,
              });
            }

            this.failed(m.entry, error.error);
          });

          // Event: Manage broadcast
          this.protocols[m.entry.$umid].on("broadcast", (early) => {
            this.broadcast(m.entry, early);
          });

          // Event: Manage Reload Requests
          this.protocols[m.entry.$umid].on("reload", () => {
            this.reloadUp(m.entry.$umid);
          });

          // Disable
          // Event: Manage Throw Transactions
          // this.protocols[m.entry.$umid].on(
          //   "throw",
          //   (response: any) => {
          //     this.throw(m.entry, response);
          //   }
          // );

          // Event: Latest Contract Version
          this.protocols[m.entry.$umid].on(
            "contractLatestVersion",
            (response: { contract: string; file: string }) => {
              if (response) {
                this.latestContractVersion[response.contract] = response.file;
                this.send("contractLatestVersion", response);
              }
            }
          );

          // Event: Contract Data
          this.protocols[m.entry.$umid].on(
            "contractData",
            (response: { contract: string; data: any }) => {
              if (response) {
                this.latestContractData[response.contract] = response.data;
                this.send("contractData", response);
              }
            }
          );

          // Start the process
          this.protocols[m.entry.$umid].start(
            this.latestContractVersion[m.entry.$tx.$contract],
            this.latestContractData[m.entry.$tx.$contract.substring(0, 64)]
          );
          break;
        case "broadcast":
          if (this.protocols[m.data.umid]) {
            // Update Protocol with network values
            this.protocols[m.data.umid].updatedFromBroadcast(m.data.nodes);
          }
          break;
        case "destory":
          // Remove protocol from memory.
          this.clear(m.data.umid, m.data.skipTimeout);
          break;
        case "reload":
          this.reloadDown(m.data);
          break;
        case "contractLatestVersion":
          if (m.data.refresh) {
            if (m.data.contract) {
              for (const key of Object.keys(this.latestContractVersion)) {
                if (key === m.data.contract || this.latestContractVersion[key].includes(m.data.contract)) {
                  delete this.latestContractVersion[key];
                }
              }
              ActiveProtocol.Process.clearContractPathCache(m.data.contract);
            } else {
              this.latestContractVersion = {};
              ActiveProtocol.Process.clearContractPathCache();
            }
          }
          if (m.data.contract) {
            this.latestContractVersion[m.data.contract] = m.data.file;
          }
          break;
        case "contractData":
          this.latestContractData[m.data.contract] = m.data.data;
          break;
        default:
          ActiveLogger.fatal(m, "Unknown Processor Call");
      }
      // Check memory usage let host know if its high
      // VM needs improving to release its memory, This is temporary solution to let this process
      // finish and then be swapped out with the waiting one.
      if (!this.maxMemoryReached && process.memoryUsage.rss() > MAX_MEMORY_MB) {
        this.maxMemoryReached = true;
        this.send("memory", process.memoryUsage());
      }
    });
  }

  /**
   * Process Commit Responses back to main thread
   *
   * @private
   * @param {*} entry
   * @param {*} response
   */
  private committed(entry: any, response: any): void {
    // Was it a contract upgrade? (Moved here to not delay cache updates)
    if (entry.$tx.$contract == "contract" && entry.$tx.$entry == "update") {
      // Get input (To get namespace)
      const input = entry.$tx.$i[Object.keys(entry.$tx.$i)[0]];
      // Get Output (contract id)
      const output = Object.keys(entry.$tx.$o)[0];
      // Update parent processor cache
      this.send("contractLatestVersion", {
        contract: output,
        file: `${output}@${input.version}`,
        refresh: true,
      });
      // Implement for labels?
    }

    // Pass back to host to respond.
    this.send("commited", {
      umid: entry.$umid,
      nodes: entry.$nodes,
      entry: {
        $streams: entry.$streams,
        $territoriality: entry.$territoriality,
        response: entry.response,
      },
    });

    // Clear Early?
    //if (!entry.$broadcast && !response) {
    this.clear(entry.$umid);
    //}
  }

  /**
   * Process failed transactions back to main thread
   *
   * @private
   * @param {*} entry
   * @param {Error} error
   */
  private failed(entry: any, error: Error): void {
    ActiveLogger.debug(error, "TX Failed");
    // Store error
    //entry.$nodes[Home.reference].error = error?.toString();

    if (Home.reference) {
      if (entry.$nodes[Home.reference]?.error) {
        entry.$nodes[Home.reference].error = error?.toString();
      } else {
        entry.$nodes[Home.reference] = {
          vote: false,
          commit: false,
          error: error?.toString(),
        };
      }
    }

    // Pass back to host to respond
    this.send("commited", {
      umid: entry.$umid,
      nodes: entry.$nodes,
    });

    if (!entry.$broadcast) {
      this.clear(entry.$umid);
    }
  }

  /**
   * Process broadcast request back to main thread
   *
   * @private
   * @param {*} entry
   */
  private broadcast(entry: any, early = false): void {
    // Pass back to host to respond
    this.send("broadcast", {
      umid: entry.$umid,
      nodes: entry.$nodes,
      revs: entry.$revs,
      early,
    });
  }

  /**
   * Process reload requests back to main thread
   *
   * @private
   * @param {string} umid
   */
  private reloadUp(umid: string): void {
    this.send("reload", {
      umid,
    });
  }

  /**
   * Reload the configuration
   *
   * @private
   */
  private reloadDown(data: any) {
    try {
      // Re-read config.json to capture any live updates (such as "build" number)
      ActiveOptions.parseConfig();
      ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);
    } catch (e) {
      ActiveLogger.error(e, "Child process failed to re-parse config.json");
    }

    // Reload Neighbourhood
    ActiveOptions.extendConfig()
      .then((config: any) => {
        if (config.neighbourhood) {
          ActiveLogger.debug(config.neighbourhood, "Reset Request");
          Home.reference = data.reference;
          this.housekeeping(data.right, data.neighbourhood);
        }
      })
      .catch((e: any) => {
        ActiveLogger.info(e, "Failed to reload Neighbourhood");
      });
  }

  /**
   * Process throwing transactions to other ledgers with event tracking
   *
   * Disabled
   *
   * @private
   * @param {*} entry
   * @param {*} response
   */
  // private throw(entry: any, response: any): void {
  //   // We can throw from here
  //   ActiveLogger.info(response, "Throwing Transaction");

  //   // Prepare event emitter for response management
  //   const eventEngine = new EventEngine(this.dbev, entry.$tx.$contract, entry.$tx.umid);

  //   // Unique Phase
  //   eventEngine.setPhase("throw");

  //   if (response.locations && response.locations.length) {
  //     // Throw transaction to those locations
  //     let i = response.locations.length;
  //     while (i--) {
  //       // Cache Location
  //       let location = response.locations[i];
  //       ActiveRequest.send(location, "POST", [], {
  //         $tx: entry.$tx,
  //         $selfsign: entry.$selfsign,
  //         $sigs: entry.$sigs,
  //       })
  //         .then((resp: any) => {
  //           // Emit Event of successful connection to the ledger (May still have failed on the ledger)
  //           eventEngine.emit("throw", {
  //             success: true,
  //             sentFrom: Home.host,
  //             sentTo: location,
  //             $umid: entry.$umid,
  //             response: resp.data,
  //           });
  //         })
  //         .catch((error: any) => {
  //           // Emit Event of error sending to the ledger
  //           eventEngine.emit("throw", {
  //             success: false,
  //             sentFrom: Home.host,
  //             sentTo: location,
  //             $umid: entry.$umid,
  //             response: error?.toString(),
  //           });
  //         });
  //     }
  //   }
  // }

  /**
   * Process unhandledrejections back to main thread
   *
   * @private
   * @param {*} entry
   * @param {Error} error
   */
  private unhandled(entry: any, error: Error): void {
    //ActiveLogger.warn(error, "UnhandledRejection - " + entry.$umid);
    // Store error (if we can)
    let recoverable = false;
    if (entry.$nodes) {
      const errMsg =
        "(Unhandled Contract Error) " + JSON.stringify(error || "unknown");
      // unhandled may happen before object created
      if (Home.reference) {
        recoverable = true;
        if (entry.$nodes[Home.reference]?.error) {
          entry.$nodes[Home.reference].error = errMsg;
        } else {
          entry.$nodes[Home.reference] = {
            vote: false,
            commit: false,
            error: errMsg,
          };
        }
      } else {
        // Reference has been lost (Processor crashing?)
        // Lets use random placeholder to attempt to store the data
        entry.$nodes[`NoRef-${(+new Date()).toString(36).slice(-5)}`] = {
          vote: false,
          commit: false,
          error: errMsg,
        };
      }
    }

    // Pass back to host to respond
    this.send("unhandledrejection", {
      umid: entry.$umid,
      nodes: entry.$nodes,
      recoverable,
    });

    if (!entry.$broadcast) {
      this.clear(entry.$umid);
    }
  }

  /**
   * Handle communications back to the main thread
   *
   * @private
   * @param {string} type
   * @param {unknown} data
   */
  private send(type: string, data: unknown): void {
    (process as any)?.send(
      {
        type,
        data,
      },
      (e: Error | null) => {
        // Most likely channel has been closed.
      }
    );
  }

  /**
   * Memory Management
   *
   * @private
   * @param {string} umid
   */
  private clear(umid: string, skipTimeout = false): void {
    const clear = () => {
      ActiveLogger.debug("Removing from memory : " + umid);
      // Clear Listners & Destory Early
      if (this.protocols[umid]) {
        this.protocols[umid].destroy(umid);
        this.protocols[umid].removeAllListeners();
        // Clear
        delete this.protocols[umid];
      }

      // No longer need to handle unhandled rejections
      if (this.unhandledRejection[umid]) {
        process.off("unhandledRejection", this.unhandledRejection[umid]);
        delete this.unhandledRejection[umid];
      }
    };
    if (skipTimeout) {
      clear();
    } else {
      // TODO 5000 maybe not long enough or actually to long this set for testing with commit pre postprocessing
      setTimeout(() => {
        clear();
      }, 5000);
    }
  }

  /**
   * Process setup of the processor from main thread
   *
   * @private
   * @param {ISetup} setup
   */
  private setup(setup: ISetup) {
    // Manage False postive warnings.
    // Find alternative way to capture rejections per message
    process.setMaxListeners(300);

    // Create connection string
    this.db = new ActiveDSConnect(setup.db.url + "/" + setup.db.database);

    // Create connection string
    this.dbe = new ActiveDSConnect(setup.db.url + "/" + setup.db.error);

    // Create connection string
    this.dbev = new ActiveDSConnect(setup.db.url + "/" + setup.db.event);

    // Setup Home
    this.makeHome(setup);

    // Create default house keeping
    this.housekeeping(setup.right, setup.neighbours);
    ActiveLogger.info("Processor Setup Complete");

    // Let main thread know we are ready
    this.send("ready", {
      pid: process.pid,
    });
  }

  /**
   * Setup minimum home
   *
   * @private
   * @param {IMakeHome} { reference, self, pubPem, privPem }
   */
  private makeHome({ reference, self, pubPem, privPem }: IMakeHome) {
    Home.reference = reference;
    Home.host = self;
    Home.publicPem = pubPem;
    Home.identity = new ActiveCrypto.KeyPair("rsa", privPem);
  }

  /**
   * Keep home tidy with communication path
   *
   * @private
   * @param {*} right
   * @param {{ [reference: string]: Neighbour }} [neighbours]
   */
  private housekeeping(
    right: any,
    neighbours?: { [reference: string]: Neighbour }
  ) {
    // TODO if bundle we need to send it before rewriting this?
    // Create new right neighbour with identity if known
    Home.right = new Neighbour(
      right.host,
      right.port,
      right.isHome,
      right.identity
        ? new ActiveCrypto.KeyPair(right.identity.type, right.identity.pem)
        : undefined
    );

    // Are we updating the neighbourhood?
    if (neighbours) {
      this.neighbourhood = neighbours;

      this.secured = new ActiveCrypto.Secured(this.db, this.neighbourhood, {
        reference: Home.reference,
        public: Home.publicPem,
        private: Home.identity.pem,
      });
    }
  }
}

// Start Processor
new Processor();
