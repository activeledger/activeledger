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
  ActiveDSConnect,
  ActiveOptions,
  ActiveRequest,
} from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { EventEngine } from "@activeledger/activequery";

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

interface IContractVersions {
  [contractName: string]: string;
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
   * @memberof Processor
   */
  private db: ActiveDSConnect;

  /**
   *
   *
   * @private
   * @type {ActiveDSConnect}
   * @memberof Processor
   */
  private dbe: ActiveDSConnect;

  /**
   *
   *
   * @private
   * @type {ActiveDSConnect}
   * @memberof Processor
   */
  private dbev: ActiveDSConnect;

  /**
   *
   *
   * @private
   * @type {ActiveCrypto.Secured}
   * @memberof Processor
   */
  private secured: ActiveCrypto.Secured;

  /**
   *
   *
   * @private
   * @type {{ [reference: string]: Neighbour }}
   * @memberof Processor
   */
  private neighbourhood: { [reference: string]: Neighbour };

  /**
   *
   *
   * @private
   * @type {{
   *     [umid: string]: any;
   *   }}
   * @memberof Processor
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
   * @memberof Processor
   */
  private protocols: {
    [umid: string]: ActiveProtocol.Process;
  } = {};

  /**
   * Holds the latest version number for a generic contract request
   *
   * @private
   * @type {IContractVersions}
   * @memberof Process
   */
  private latestContractVersion: IContractVersions = {};

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
          this.housekeeping(m.data.right, m.data.neighbourhood);
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
            if (this.protocols[m.entry.$umid]) {
              this.unhandled(m.entry, reason);
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
            this.failed(m.entry, error.error);
          });

          // Event: Manage broadcast
          this.protocols[m.entry.$umid].on("broadcast", () => {
            this.broadcast(m.entry);
          });

          // Event: Manage Reload Requests
          this.protocols[m.entry.$umid].on("reload", () => {
            this.reloadUp(m.entry.$umid);
          });

          // Event: Manage Throw Transactions
          this.protocols[m.entry.$umid].on("throw", (response: any) => {
            this.throw(m.entry, response);
          });

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

          // Start the process
          this.protocols[m.entry.$umid].start(
            this.latestContractVersion[m.entry.$tx.$contract]
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
          this.clear(m.data.umid);
          break;
        case "reload":
          this.reloadDown(m.data);
          break;
        case "contractLatestVersion":
          // Only change if different. (Maybe check semver?)
          if (this.latestContractVersion[m.data.contract] != m.data.file) {
            this.latestContractVersion[m.data.contract] = m.data.file;
          }
          break;
        default:
          ActiveLogger.fatal(m, "Unknown Processor Call");
      }
    });
  }

  /**
   * Process Commit Responses back to main thread
   *
   * @private
   * @param {*} entry
   * @param {*} response
   * @memberof Processor
   */
  private committed(entry: any, response: any): void {
    if (response && response.instant) {
      ActiveLogger.debug(entry, "Transaction Currently Processing");
    } else {
      ActiveLogger.debug(entry, "Transaction Processed");
    }

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
    if (!entry.$broadcast && !response) {
      this.clear(entry.$umid);
    }
  }

  /**
   * Process failed transactions back to main thread
   *
   * @private
   * @param {*} entry
   * @param {Error} error
   * @memberof Processor
   */
  private failed(entry: any, error: Error): void {
    ActiveLogger.debug(error, "TX Failed");
    // Store error
    entry.$nodes[Home.reference].error = error.toString();

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
   * @memberof Processor
   */
  private broadcast(entry: any): void {
    // Pass back to host to respond
    this.send("broadcast", {
      umid: entry.$umid,
      nodes: entry.$nodes,
      revs: entry.$revs,
    });
  }

  /**
   * Process reload requests back to main thread
   *
   * @private
   * @param {string} umid
   * @memberof Processor
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
   * @memberof Host
   */
  private reloadDown(data: any) {
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
   * @private
   * @param {*} entry
   * @param {*} response
   * @memberof Processor
   */
  private throw(entry: any, response: any): void {
    // We can throw from here
    ActiveLogger.info(response, "Throwing Transaction");

    // Prepare event emitter for response management
    const eventEngine = new EventEngine(this.dbev, entry.$tx.$contract);

    // Unique Phase
    eventEngine.setPhase("throw");

    if (response.locations && response.locations.length) {
      // Throw transaction to those locations
      let i = response.locations.length;
      while (i--) {
        // Cache Location
        let location = response.locations[i];
        ActiveRequest.send(location, "POST", [], {
          $tx: entry.$tx,
          $selfsign: entry.$selfsign,
          $sigs: entry.$sigs,
        })
          .then((resp: any) => {
            // Emit Event of successful connection to the ledger (May still have failed on the ledger)
            eventEngine.emit("throw", {
              success: true,
              sentFrom: Home.host,
              sentTo: location,
              $umid: entry.$umid,
              response: resp.data,
            });
          })
          .catch((error: any) => {
            // Emit Event of error sending to the ledger
            eventEngine.emit("throw", {
              success: false,
              sentFrom: Home.host,
              sentTo: location,
              $umid: entry.$umid,
              response: error.toString(),
            });
          });
      }
    }
  }

  /**
   * Process unhandledrejections back to main thread
   *
   * @private
   * @param {*} entry
   * @param {Error} error
   * @memberof Processor
   */
  private unhandled(entry: any, error: Error): void {
    ActiveLogger.warn(error, "UnhandledRejection");
    // Store error (if we can)
    if (entry.$nodes) {
      const errMsg = "(Unhandled Contract Error) " + error.toString();
      // unhandled may happen before object created
      if (entry.$nodes[Home.reference]?.error) {
        entry.$nodes[Home.reference].error = errMsg;
      } else {
        entry.$nodes[Home.reference] = {
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
   * @memberof Processor
   */
  private send(type: string, data: unknown): void {
    (process as any).send({
      type,
      data,
    });
  }

  /**
   * Memory Management
   *
   * @private
   * @param {string} umid
   * @memberof Processor
   */
  private clear(umid: string) {
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
      this.unhandledRejection[umid] = null;
    }
  }

  /**
   * Process setup of the processor from main thread
   *
   * @private
   * @param {ISetup} setup
   * @memberof Processor
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
   * @memberof Processor
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
   * @memberof Processor
   */
  private housekeeping(
    right: any,
    neighbours?: { [reference: string]: Neighbour }
  ) {
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
