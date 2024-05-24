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
import { readlinkSync } from "fs";
import { basename } from "path";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveGZip,
  ActiveRequest,
} from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Home } from "./home";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints, Maintain } from "./index";
import { Locker } from "./locker";
import { PhysicalCores } from "./cpus";
import * as process from "process";

const RELEASE_SHUTDOWN_TIMEOUT = 5 * 60 * 1000;
const RELEASE_DELETE_TIMEOUT = 1 * 60 * 1000;
const TIMER_QUEUE_INTERVAL = 10 * 1000;
const GRACEFUL_PROC_SHUTDOWN = 7 * 60 * 1000;
const KILL_PROC_SHUTDOWN = 2.5 * 1000;

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
  shutdown?: boolean;
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
 * Extend  ChildProcess and add stoppable flag
 *
 * @interface StoppableChildProcess
 * @extends {ChildProcess}
 */
interface StoppableChildProcess extends ChildProcess {
  stop: boolean;
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
   */
  public readonly api: Server;

  /**
   * Server connection to the couchdb instance for this node
   *
   * @private
   * @type ActiveDSConnect
   */
  private dbConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @private
   * @type ActiveDSConnect
   */
  private dbErrorConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb vent instance for this node
   *
   * @private
   * @type ActiveDSConnect
   */
  private dbEventConnection: ActiveDSConnect;

  /**
   * Holds the processPending requests before processing
   *
   * @private
   * @type {*}
   */
  private processPending: {
    [reference: string]: process;
  } = {};

  /**
   * How many cpu processors have said they're ready
   *
   * @private
   */
  private cpuReady = 0;

  /**
   * How many hybrid connected nodes
   *
   * @private
   */
  private hybridHosts: ActiveDefinitions.IHybridNodes[];

  /**
   * Holds transactions to be run as locks released.
   * Basic formation of a tx memory pool.
   *
   * @private
   * @type {[]}
   */
  private busyLocksQueue: {
    entry: ActiveDefinitions.LedgerEntry;
    retry: number;
  }[] = [];

  /**
   * Add process into pending
   *
   */
  public pending(
    entry: ActiveDefinitions.LedgerEntry,
    internal = false
  ): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Broadcasting or Territoriality Mode
      if (entry.$broadcast) {
        // We may already have the $umid in memory
        if (this.processPending[entry.$umid]) {
          ActiveLogger.debug("Broadcast Recieved : " + entry.$umid);
          // Process Assigned?
          if (this.processPending[entry.$umid].pid &&
              // If a lead/er we don't need to let sub processor know
              !this.processPending[entry.$umid].entry?.$nodes[this.reference]?.leader) {
            // Find Processor to send in the broadcast message
            const processor = this.findProcessor(
              this.processPending[entry.$umid].pid
            );
            if (processor) {
              processor.send({
                type: "broadcast",
                data: {
                  umid: entry.$umid,
                  nodes: entry.$nodes,
                },
              });
            } else {
              // Not found, Lets just return the umid anyway it may confirm or will timeout
            }
          }
          return resolve({
            status: 200,
            //data: this.processPending[entry.$umid].entry,
          });
        }
      }

      // Check we don't have it, Process finding may have failed.
      if (!this.processPending[entry.$umid]) {
        // Add to pending (Using Promises instead of http request)
        this.processPending[entry.$umid] = {
          entry: entry,
          resolve: (response: unknown) => {
            // Catch all release (with a response) Impact on broadcast?
            this.release({ entry, resolve: null, reject: null, pid: 0 });
            resolve(response);
          },
          reject: (response: unknown) => {
            // Catch all release (with a response) Impact on broadcast?
            this.release({ entry, resolve: null, reject: null, pid: 0 });
            reject(response);
          },
          pid: 0,
        };
        // Ask for hold
        //this.hold(entry);
        this.processQueue(entry, internal);
      } else {
        // If we have it and didn't find it, Lets return this request, However
        // do we need to manage the existing one? Possibly stuck? play safe
        // resolve with what we know
        return resolve({
          status: 200,
          data: this.processPending[entry.$umid].entry,
        });
      }
    });
  }

  /**
   * Creates an instance of Host.
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

    // Build Hybrid Node List
    this.hybridHosts = ActiveOptions.get<ActiveDefinitions.IHybridNodes[]>(
      "hybrid",
      []
    );

    // Set hybrid doc name
    if (this.hybridHosts.length) {
      for (let i = this.hybridHosts.length; i--;) {
        const hybrid = this.hybridHosts[i];
        hybrid.docName = ActiveCrypto.Hash.getHash(hybrid.url + hybrid.auth);
      }
    }

    // Create HTTP server for managing transaction requests
    this.api = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Log Request
      ActiveLogger.debug(
        `Request - ${req.connection.remoteAddress} @ ${req.method}:${req.url}`
      );

      // Capture POST data
      if (req.method == "POST") {
        // Holds the body
        const body: Buffer[] = [];

        // Reads body data
        req.on("data", (chunk) => {
          body.push(chunk);
        });

        // When read has compeleted continue
        req.on("end", async () => {
          // Join the buffer storing the data
          let data = Buffer.concat(body);
          // gzipped?
          // Sometimes internal transactions fail to be decompressed
          // the header shouldn't be missing but added magic number check as a back
          // all internal transactions are supposed to be compressed failsafe check for when header isn't available?
          if (
            req.headers["content-encoding"] == "gzip" ||
            (data[0] == 0x1f && data[1] == 0x8b)
          ) {
            try {
              data = await ActiveGZip.ungzip(data);
            } catch {
              // Just incase the magic number still invalid gzip
              // capture the "incorrect header check" -3 Z_DATA_ERROR and continue
              // with the original non-gzip compliant data
            }
          }

          // console.log(req.headers);
          // console.log("====");

          // All posted data should be JSON
          // Convert data for potential encryption
          Endpoints.postConvertor(
            this,
            data.toString(),
            (req.headers["x-activeledger-encrypt"] as unknown as boolean) ||
            false
          )
            .then((body) => {
              // Post Converted, Continue processing
              this.processEndpoints(req, res, body.body, body.from);
            })
            .catch((error) => {
              // Failed to convery respond;
              ActiveLogger.error(error, "Server POST Parser 500");
              this.writeResponse(
                res,
                error.statusCode || 500,
                JSON.stringify(error.content || {}),
                req.headers["Accept-Encoding"] as string
              );
            });
        });
      } else {
        // Simple get, Continue Processing
        this.processEndpoints(req, res);
      }
    });

    // Create Index
    // this.dbConnection
    //   .createIndex({
    //     index: {
    //       fields: ["namespace", "type", "_id"],
    //     },
    //   })
    //   .then(() => {
    // How many threads (Cache so we can check on ready)
    const cpuTotal = PhysicalCores.count();

    // Setup Processors
    const latestSetupMsg = this.getLatestSetup();
    for (let i = 0; i < cpuTotal; i++) {
      // Add process into array
      const processor = this.createProcessor(cpuTotal);
      // Add to list
      this.processors.push(processor);
      // Setup
      processor.send(latestSetupMsg);
    }

    // Create temporary ready to swap out (So it is already set up)
    this.standbyProcess = this.createProcessor(cpuTotal);
    this.standbyProcess.send(latestSetupMsg);

    // Setup Iterator
    this.processorIterator = this.processors[Symbol.iterator]();

    // Start queue failsafe
    this.timerQueue();
  }

  /**
   * Retuns latest setup for a subprocess
   *
   * @private
   * @returns {setup}
   */
  private getLatestSetup(): setup {
    return {
      type: "setup",
      data: {
        self: Home.host,
        reference: Home.reference,
        right: Home.right,
        neighbourhood: this.neighbourhood.get(),
        pubPem: Home.publicPem,
        privPem: Home.identity.pem,
        db: ActiveOptions.get<any>("db", {}),
        __base: ActiveOptions.get("__base", __dirname),
      },
    };
  }

  /**
   * Creator a processor thread (by process)
   *
   * @private
   * @returns {ChildProcess}
   */
  private createProcessor(cpuTotal?: number): ChildProcess {
    // Create Process
    const pFork = fork(`${__dirname}/process.js`, [], {
      cwd: process.cwd(),
      stdio: "inherit",
    }) as StoppableChildProcess;

    // Set useful default
    pFork.stop = false;

    // Prevent multiple runs, Could overwrite method instead
    let unloadHandled = false;

    // Reusable restart process from error with current scope
    const unloadProcessorSafely = (...error: any[]) => {
      if (unloadHandled) {
        ActiveLogger.fatal(error, "Processor Crashed - Already Shutting Down");
      } else {
        pFork.stop = unloadHandled = true;
        ActiveLogger.fatal(error, "Processor Crashed");

        // Push standby process
        this.processors.push(this.standbyProcess);

        // We should now create a new standby processor
        this.standbyProcess = this.createProcessor();
        this.standbyProcess.send(this.getLatestSetup());

        ActiveLogger.fatal(
          pFork,
          "Will Gracefully Shutdown in " + GRACEFUL_PROC_SHUTDOWN
        );
        // Wait for current tansactions to finish (Destroy can take up to 5 minutes)
        setTimeout(() => {
          // Look for any transactions which are in this processor
          ActiveLogger.fatal(pFork, "Starting Graceful Shutdown");
          const pendings = Object.keys(this.processPending);
          pendings.forEach((key) => {
            // Get Transaction
            let pending = this.processPending[key];
            // Was this transaction in the broken processor
            if (pending?.pid === pFork.pid) {
              // This will just resolve all pending transactions in that process pool
              // Wont be graceful but most likely other nodes will have the same conclusion
              // However enough time has passed that it *should* be safe
              // TODO make sure we don't have a single transaction forever extending timeout.
              // Or find a way to move it into another process broadcast timeout is within the 5 minutes
              // Assign general error
              pending.entry.$nodes[this.reference].error =
                "(Contract Thread Error) Unknown - Try Again";

              // Resolve to return oprhened transactions
              pending.resolve({
                status: 200,
                data: pending.entry,
              });

              // Remove Locks
              this.release(pending);
            }
          });

          // Instruct child to terminate. (Clears memory)
          // Even though we should be clear timeout to act as a buffer and
          // push to the end of the event loop
          ActiveLogger.fatal(pFork, "Will Kill in " + KILL_PROC_SHUTDOWN);
          setTimeout(() => {
            ActiveLogger.fatal(pFork, "Sending Kill Signal");
            //Find the bad process
            for (let i = this.processors.length; i--;) {
              if (this.processors[i].pid === pFork.pid) {
                this.processors.splice(i, 1);
                break;
              }
            }
            // const pos = this.processors.findIndex((processor) => {
            //   return processor.pid === pFork.pid;
            // });

            // // Remove from processors list and create new
            // if (pos !== -1) {
            //   this.processors.splice(pos, 1, this.standbyProcess);
            // }
            pFork.kill();
          }, KILL_PROC_SHUTDOWN);
          // Contracts which extend timeout will still be at risk hence the above
        }, GRACEFUL_PROC_SHUTDOWN);
      }
    };

    // Listen for message to respond to waiting http
    pFork.on("message", (m: any) => {
      // Cache Pending Reference
      const pending = this.processPending[m.data.umid];

      // Process may have been cleared by unhandleded process crashing
      if (pending) {
        // Check data for self to update
        if (m.data.nodes) {
          //pending.entry.$nodes[this.reference] = m.data.self;
          pending.entry.$nodes = {
            ...pending.entry.$nodes,
            ...m.data.nodes,
          };
        }

        // Check for revisions if they have been added
        if (m.data.revs && !pending.entry.$revs) {
          pending.entry.$revs = {
            $i: m.data.revs.$i || {},
            $o: m.data.revs.$o || {},
          };
        }
      }

      // Switch on type of messages from processors
      switch (m.type) {
        case "failed":
          if (!pending) return; // Fail safe, May happen when process being closed
          // So if we send as resolve it should still work (Will it keep our error?)
          pending.resolve({
            status: 200,
            data: pending.entry,
          });
          // Remove Locks
          this.release(pending);

          // If we want to send AFTER this node has completed uncomment
          // If Hybrid enabled, Send transaction on
          if (m.data && this.hybridHosts.length) {
            this.processHybridNodes(pending.entry);
          }
          break;
        case "commited":
          if (!pending) return; // Fail safe, May happen when process being closed
          // Process response back into entry for previous neighbours to know the results
          pending.resolve({
            status: 200,
            data: { ...pending.entry, ...m.data.entry },
          });
          // Remove Locks
          this.release(pending);

          // If we want to send AFTER this node has completed uncomment
          // If Hybrid enabled, Send transaction on
          if (this.hybridHosts.length) {
            // TODO : TypeError: Cannot read property '$streams' of undefined
            this.processHybridNodes(pending.entry, m.data.entry?.$streams);
          }
          break;
        case "broadcast":
          this.broadcast(m.data.umid, m.data.early);
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
              Maintain.healthTimer(true);
            }
          }
          break;
        case "unhandledrejection":
          if (pending) {
            pending.resolve({
              status: 200,
              data: { ...pending.entry, ...m.data.entry },
            });
            // Remove Locks
            this.release(pending);
          }
          // End process and create new subprocess
          unloadProcessorSafely(
            "unhandledrejection - Already Handled, Tidying up processes"
          );
          break;
        case "contractLatestVersion":
          // Let other processes know of new version
          this.processors.forEach((processor) => {
            processor.send(m);
          });
          // No need to send to standby it hasn't processed the transaction
          break;
        case "memory":
          // End process and create new subprocess
          unloadProcessorSafely(
            `High Memory Load (${m.data.rss / 1024 / 1024}mb)`
          );
          break;
        default:
          ActiveLogger.fatal(m, "Unknown IPC Call");
          break;
      }
    });

    // Recreate a new subprocessor
    pFork.on("error", unloadProcessorSafely);

    return pFork;
  }

  /**
   * Reload the configuration
   *
   * @private
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
        const reloadMsg = {
          type: "reload",
          data: {
            reference: Home.reference,
            right: Home.right,
            neighbourhood: this.neighbourhood.get(),
          },
        };
        this.processors.forEach((processor) => {
          processor.send(reloadMsg);
        });
        this.standbyProcess.send(reloadMsg);
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
   */
  private destroy(umid: string): void {
    // Make sure it hasn't ben removed already
    if (this.processPending[umid]) {
      // Set to shutdown so broadcast can stop
      this.processPending[umid].shutdown = true;

      // Pass destory message to processor
      this.findProcessor(this.processPending[umid].pid)?.send({
        type: "destory",
        data: {
          umid,
        },
      });

      // Keep in memory to manage inbound broadcasts
      setTimeout(() => {
        delete this.processPending[umid];
      }, RELEASE_DELETE_TIMEOUT);
    }
  }

  /**
   * Broadcast Transaction to the network
   *
   * @private
   * @param {string} umid
   */
  private broadcast(umid: string, early = false): void {
    // Final check object exists
    if (
      this.processPending[umid]?.entry &&
      this.processPending[umid].entry.$broadcast &&
      this.processPending[umid].entry.$nodes &&
      this.processPending[umid].entry.$nodes[this.reference]
    ) {
      ActiveLogger.debug("Broadcasting TX : " + umid);

      // Get all the neighbour nodes
      let neighbourhood = this.neighbourhood.get();
      let nodes = this.neighbourhood.keys();
      let i = nodes.length;
      let promises: any[] = [];

      // We only want to send our value
      const data = !early
        ? Object.assign(this.processPending[umid].entry, {
          $nodes: {
            [this.reference]:
              this.processPending[umid].entry.$nodes[this.reference],
          },
        })
        : Object.assign(this.processPending[umid].entry, {
          $nodes: {},
        });

      // Experienced a blank target from above assign, Double check to prevent bad loop
      if (data) {
        // Loop them all and broadcast the transaction
        while (i--) {
          let node = neighbourhood[nodes[i]];

          // Make sure they're home and not us
          if (node.isHome && node.reference !== this.reference) {
            // Need to detect if we have already sent and got response for nodes for performance
            promises.push(node.knock("init", data));
          }
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
   */
  private broadcastResolver(umid: string): void {
    // Check access to the protocol
    if (this.processPending[umid] && this.processPending[umid].entry) {
      // Recast as connection errors found.
      ActiveLogger.warn("Rebroadcasting : " + umid);
      this.broadcast(umid);
    } else {
      // No longer in memory. Create a new error document outside protocol
      // We could have comitted but no idea we may have needed a rebroadcast back.
      const doc = {
        code: 1610,
        processed: false,
        umid: umid,
        // simulate tx for restore
        transaction: {
          $broadcast: true,
          $tx: {},
          $revs: {},
        },
        reason: "Failed to rebroadcast while in memory",
      };

      // Return
      this.dbErrorConnection.post(doc);
    }
  }

  /**
   * TODO: Need to merge with labelOrKey@protocol/process.ts
   *
   * @private
   * @param {*} txIO
   * @param {boolean} [outputs=false]
   * @returns {string[]}
   */
  private labelOrKey(txIO: any): string[] {
    // Get reference for input or output
    const keys = Object.keys(txIO || {});
    const out: string[] = [];

    for (let i = keys.length; i--;) {
      // Stream label or self
      out.push(this.filterPrefix(txIO[keys[i]].$stream || keys[i]));
    }
    return out;
  }

  /**
   * Filters Prefix for labelorkey locking
   *
   * @private
   * @param {string} streamId
   * @returns {string}
   */
  private filterPrefix(streamId: string): string {
    // If id length more than 64 trim the start
    if (streamId.length > 64) {
      streamId = streamId.slice(-64);
    }

    // Return just the id
    return streamId;
  }

  /**
   * Trigger a hold of the stream locks that the process wants to own
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} v
   * @param {number} retries
   */
  private hold(v: ActiveDefinitions.LedgerEntry, retries = 0): boolean {
    // Build a list of streams to lock
    // Would be good to cache this
    // let input = Object.keys(v.$tx.$i || {});
    // let output = Object.keys(v.$tx.$o || {});

    // Ask for locks
    if (
      v.$selfsign ||
      // Use set to filter unique then back to array (or in loop)
      Locker.hold([
        ...new Set([
          ...this.labelOrKey(v.$tx.$i),
          ...this.labelOrKey(v.$tx.$o),
        ]),
      ])
    ) {
      // Get next process from the array
      const robin = this.getRobin();

      // Make sure we have the response object
      if (!this.processPending[v.$umid].entry.$nodes)
        this.processPending[v.$umid].entry.$nodes = {};

      // Setup this node response
      this.processPending[v.$umid].entry.$nodes[Home.reference] = {
        vote: false,
        commit: false,
      };

      // Remember who got selected
      this.processPending[v.$umid].pid = robin.pid || 0;

      // Pass transaction to sub processor
      robin.send({
        type: "tx",
        entry: this.processPending[v.$umid].entry,
      });

      // If we want to send BEFORE this node has processed uncomment
      // if (this.hybridHosts.length) {
      //   this.processHybridNodes(this.processPending[v.$umid].entry);
      // }

      return true;
    } else {
      if (retries === 0) {
        // Push to the end of the queue
        this.busyLocksQueue.push({
          entry: v,
          retry: 1,
        });
      } else {
        // Detect internal transaction read below for more information
        const internal = v.$revs ? true : false;
        const maxRetries = internal
          ? 2
          : ActiveOptions.get<number>("queue_retry", 5);

        if (retries > maxRetries) {
          // $origin check will mean if this is the entry node and is locked it will
          // still send around the network. Broadcast will fail. So for now if entry is locked
          // defaulting to queue attempt to unlock. Otherwise busy locks could be spammed. Doesn't mean
          // in the future we can enable it. For now if entry node isn't locked then it will continue regardless
          if (/*v.$origin || */ internal) {
            // Internal Request (So need to respond as expected + forward on if not broadcast)
            // Some network conditions wont have this set
            if (!v.$nodes) {
              v.$nodes = {};
            }
            v.$nodes[this.reference] = {
              vote: false,
              commit: false,
              error: "Busy Locks",
            };

            // Internal Busy Locks, Safe to track
            const doc = {
              code: 1100,
              processed: false,
              umid: v.$umid,
              transaction: v,
              locker: Locker.getLocks(),
              reason: "Internal Busy Locks",
            };

            // Return
            this.dbErrorConnection.post(doc);

            // Not Broadcast & Not Last
            if (!v.$broadcast && Home.right.reference != v.$origin) {
              // Forward on to the next node and compile responses back
              (async () => {
                const next = await Home.right.knock("init", v);
                this.processPending[v.$umid].resolve({
                  status: 200,
                  data: { ...v, ...next.data },
                });
              })();
            } else {
              // Respond back with our failure
              this.processPending[v.$umid].resolve({
                status: 200,
                data: v,
              });
            }
          } else {
            // External Request
            this.processPending[v.$umid].reject({
              status: 100,
              error: "Busy Locks",
            });
          }

          // Not always safe but i/o position incorrect will help
          this.release(this.processPending[v.$umid]);
          // True so it is "handled" and removed from the queue in a single location
          return true;
        }
      }
      return false;
    }
  }

  /**
   * Gets next processor in the list (Doesn't account for load)
   *
   * @private
   * @returns {ChildProcess}
   */
  private getRobin(): ChildProcess {
    // Get next processes in queue
    let robin = this.processorIterator.next().value;

    // Do we need to reset?
    if (!robin) {
      this.processorIterator = this.processors[Symbol.iterator]();
      return this.getRobin();
    }

    // Has this processor been told to stop
    if (robin.stop) {
      return this.getRobin();
    }

    return robin;
  }

  /**
   * Trigger a release of the stream locks the process owns
   *
   * @private
   * @param {string} v
   * @param {boolean} noWait Don't wait to release
   */
  private release(pending: process) {
    // Ask for releases
    Locker.release([
      ...this.labelOrKey(pending.entry.$tx.$i),
      ...this.labelOrKey(pending.entry.$tx.$o),
    ]);

    // Keep transaction in memory for a bit (5 Minutes)
    setTimeout(() => {
      if (pending.entry) {
        this.destroy(pending.entry.$umid);
      }
    }, RELEASE_SHUTDOWN_TIMEOUT);

    // Put this at the end so the queue can clear this transaction
    setTimeout(() => {
      // Check the lock queue
      this.processQueue();
    }, 100);
  }

  /**
   * Manages the busy lock queue
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} [next]
   */
  private processQueue(next?: ActiveDefinitions.LedgerEntry, internal = false) {
    // If Internal and not broadcast let it skip the queue
    let skipped = false;
    if (next && internal && !next.$broadcast) {
      this.hold(next);
      skipped = true;
    }

    // Run through the queue in order to process
    if (this.busyLocksQueue.length) {
      for (let i = 0; i < this.busyLocksQueue.length; i++) {
        if (
          this.hold(
            this.busyLocksQueue[i].entry,
            this.busyLocksQueue[i].retry++
          )
        ) {
          // Success, Can remove from queue
          // cannot splice as still looping and looping in order
          delete this.busyLocksQueue[i];
        }
      }
      // Remove the empty results if any
      this.busyLocksQueue = this.busyLocksQueue.filter((n) => n);
    }

    // After processing earlier transactions now deal with calling
    if (next && !skipped) {
      this.hold(next);
    }
  }

  /**
   * Checks the queue periodically to prevent timeouts
   * better to return as a busy lock
   *
   * @private
   */
  private timerQueue() {
    setTimeout(() => {
      this.processQueue();
      this.timerQueue();
    }, TIMER_QUEUE_INTERVAL);
  }

  /**
   * Manage Hybrid Nodes
   *
   * @private
   * @param {string} tx
   * @param {ActiveDefinitions.IStreams} [activityStreams]
   */
  private processHybridNodes(
    tx: ActiveDefinitions.LedgerEntry,
    activityStreams?: ActiveDefinitions.IStreams
  ) {
    // Skip default/setup as it doesn't help hybrids
    if (
      tx.$tx.$namespace !== "default" ||
      (tx.$tx.$namespace === "default" && tx.$tx.$contract !== "setup")
    ) {
      // Minmum data needed for hybrid to process
      const txData = JSON.stringify({
        $tx: tx.$tx,
        $datatime: tx.$datetime,
        $umid: tx.$umid,
        $selfsign: tx.$selfsign,
        $sigs: tx.$sigs,
        $remoteAddr: tx.$remoteAddr,
      });

      // Loop all hybrids and send
      this.hybridHosts.forEach((hybrid) => {
        if (hybrid.active) {
          ActiveRequest.send(
            hybrid.url,
            "POST",
            ["Content-Type:application/json", "X-Activeledger:" + hybrid.auth],
            txData,
            true
          )
            .then((response) => {
              // Hybrid Active, Has the node missed anything?
              // The below may create a 404 error log.
              this.dbErrorConnection
                .exists(hybrid.docName as string)
                .then((exists: any) => {
                  if (exists && exists.q && exists.q.length) {
                    // Send the queue (no need to wait being best effort)
                    ActiveRequest.send(
                      `${hybrid.url}/q`,
                      "POST",
                      ["X-Activeledger:" + hybrid.auth],
                      exists.q
                    ).catch();

                    // Then delete!
                    this.dbErrorConnection.purge(exists).catch();
                  }

                  // ok = do nothing
                  // unhandledRejection, failed = send latest version
                  const data = response.data as any;

                  // Everything but ok, should see latest version
                  if (data.status !== "ok") {
                    // Get all New / Updated Docs
                    const updated = [
                      ...(activityStreams?.new || []),
                      ...(activityStreams?.updated || []),
                    ].map((stream) => stream.id);

                    // Also need $i, $o and $r,  Can probably reuse the .keys
                    const input = tx.$tx.$i
                      ? this.hybridLabelKeyId(tx.$tx.$i)
                      : [];
                    const output = tx.$tx.$o
                      ? this.hybridLabelKeyId(tx.$tx.$o)
                      : [];

                    // Dupes should be managed (If not switch to set)
                    const keys = [...updated, ...input, ...output];

                    // Missing Contract
                    if (data.contract) {
                      const path = `${process.cwd()}/contracts/${tx.$tx.$namespace
                        }/${tx.$tx.$contract}.js`;
                      // Maybe symlink?
                      try {
                        keys.push(basename(readlinkSync(path), ".js"));
                      } catch (e) {
                        // File is a stream id
                        keys.push(basename(path, ".js"));
                      }
                    }

                    // Loop all and append :stream to get meta data
                    const tmp = [];
                    for (let i = keys.length; i--;) {
                      tmp.push(keys[i] + ":stream");
                    }

                    // Push tmp back into keys so we get everything
                    keys.push(...tmp);

                    // Fetch all docs (Dupes should be managed, If not use set)
                    return this.dbConnection
                      .allDocs({
                        include_docs: true,
                        keys,
                      })
                      .then((results) => {
                        // Return the results with the error id
                        if (results.rows.length) {
                          // Can ignore responses
                          return ActiveRequest.send(
                            `${hybrid.url}/streamState/${data.streamState}`,
                            "POST",
                            ["X-Activeledger:" + hybrid.auth],
                            {
                              umid: tx.$umid,
                              streams: results.rows,
                            }
                          );
                        }
                      });
                  }
                });
            })
            .catch(() => {
              // Best Effort Approach
              // Store all failed requests into a error document named after the node
              // Node comes online and pings the mainnet to send this best effort list
              // Whhy best effort?
              // If the node has missed 1000 transactions and it takes 5 seconds a transaction there is a good chance that
              // a new transaction will come in that later relies on one of the missed transactions which may not yet be processed
              // This will tricker the trusted recovery, When that transaction does get caught up it will now also fail by being behind again triggering recovery
              // This recovery will continue to happen until all transactions have finished and with best effort (and duplication) the data should be up to date.
              // Error database can be deleted so this record would be lost and then it would be a slower recovery reason behind "best effort" naming

              // Get Document if exists
              this.dbErrorConnection
                .createget(hybrid.docName as string)
                .then((doc: any) => {
                  // Add the tx to this nodes queue
                  if (doc.q) {
                    doc.q.push(txData);
                  } else {
                    doc.q = [txData];
                  }

                  // Write document back to the database
                  return this.dbErrorConnection.post(doc);
                })
                .catch(() => {
                  // Can Ignore catch for now
                });
            });
        }
      });
    }
  }

  /**
   * Extract stream id from transaction type
   *
   * @private
   * @param {ActiveDefinitions.LedgerIORputs} txIO
   * @returns {string[]}
   */
  private hybridLabelKeyId(txIO: ActiveDefinitions.LedgerIORputs): string[] {
    // Get reference for input or output
    const streams = Object.keys(txIO);

    // Check the first one, If labelled then loop all.
    // Means first has to be labelled but we don't want to loop when not needed
    if (txIO[streams[0]].$stream) {
      const streamMap: string[] = [];
      for (let i = streams.length; i--;) {
        // Stream label or self
        let streamId = txIO[streams[i]].$stream || streams[i];
        streamMap.push(streamId);
      }
      return streamMap;
    } else {
      return streams;
    }
  }

  /**
   * Process Activeledger request endpoints
   *
   * @private
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {*} [body]
   */
  private processEndpoints(
    req: IncomingMessage,
    res: ServerResponse,
    body?: any,
    from?: string
  ) {
    //console.log(req.headers);
    // Internal or External Request
    let requester = (req.headers["x-activeledger"] as string) || "NA";

    // Promise Response
    let response: Promise<any>;

    // Can we return compressed data?
    let gzipAccepted = req.headers["Accept-Encoding"] as string;

    // Diffrent endpoints VERB
    switch (req.method) {
      case "GET":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/a/locks": // Network Status Request
            return this.writeResponse(
              res,
              200,
              JSON.stringify(Locker.getLocks()),
              gzipAccepted
            );
          case "/a/locks/check": // Network Status Request
            Locker.checkLocks();
            return this.writeResponse(
              res,
              200,
              JSON.stringify({ checked: true }),
              gzipAccepted
            );
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
          // This opens up a dos style attack (loop on every request)
          // case "/hybrid/online": // Hybrid Node starting up
          //   // Loop Hybrids, Find matching auth
          //   const hAuth = req.headers["x-activeledger"] as string;
          //   break;
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
              (req.headers["x-activeledger-encrypt"] as unknown as boolean) ||
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
          "X-Powered-By": "Activeledger",
        });
        res.end();
        return;
      default:
        return this.writeResponse(res, 404, "Not Found", gzipAccepted);
    }

    // Wait for promise to get the response
    response
      .then((response: any) => {
        let data = response.content || {};
        // Response should be encrypted?
        if (response.content && response.content.$encrypt && from) {
          data = {
            $packet: this.neighbourhood
              .get(from)
              .encryptKnock(JSON.stringify(response.content), true),
            $enc: true,
          };
        }

        // Write Header
        // All outputs are JSON and
        this.writeResponse(
          res,
          response.statusCode,
          JSON.stringify(data),
          gzipAccepted
        );
      })
      .catch((error: any) => {
        // Write Header
        // Basic error handling for now. As a lot of errors will still be sent as ok responses.
        ActiveLogger.error(error, "Failed to send response back");
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
      "X-Powered-By": "Activeledger",
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
