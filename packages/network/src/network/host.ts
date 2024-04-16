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
   * Process ready to be hot swapped
   *
   * @private
   * @type {ChildProcess}
   * @memberof Host
   */
  private standbyProcess: ChildProcess;

  /**
   * How many cpu processors have said they're ready
   *
   * @private
   * @memberof Host
   */
  private cpuReady = 0;

  /**
   * How many hybrid connected nodes
   *
   * @private
   * @memberof Host
   */
  private hybridHosts: ActiveDefinitions.IHybridNodes[];

  /**
   * Holds transactions to be run as locks released.
   * Basic formation of a tx memory pool.
   *
   * @private
   * @type {[]}
   * @memberof Host
   */
  private busyLocksQueue: {
    entry: ActiveDefinitions.LedgerEntry;
    retry: number;
  }[] = [];

  /**
   * Add process into pending
   *
   * @memberof Host
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
          if (this.processPending[entry.$umid].pid) {
            // Find Processor to send in the broadcast message
            this.findProcessor(this.processPending[entry.$umid].pid)!.send({
              type: "broadcast",
              data: {
                umid: entry.$umid,
                nodes: entry.$nodes,
              },
            });
          }
          return resolve({
            status: 200,
            data: this.processPending[entry.$umid].entry,
          });
        }
      }

      // Check we don't have it, Process finding may have failed.
      if (!this.processPending[entry.$umid]) {
        // Add to pending (Using Promises instead of http request)
        this.processPending[entry.$umid] = {
          entry: entry,
          resolve: resolve,
          reject: reject,
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

    // Build Hybrid Node List
    this.hybridHosts = ActiveOptions.get<ActiveDefinitions.IHybridNodes[]>(
      "hybrid",
      []
    );

    // Set hybrid doc name
    if (this.hybridHosts.length) {
      for (let i = this.hybridHosts.length; i--; ) {
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
            (req.headers["x-activeledger-encrypt"] as unknown as boolean) ||
              false
          )
            .then((body) => {
              // Post Converted, Continue processing
              this.processEndpoints(req, res, body.body, body.from);
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
    for (let i = 0; i < cpuTotal; i++) {
      // Add process into array
      const processor = this.createProcessor(cpuTotal);
      // Add to list
      this.processors.push(processor);
      // Setup
      processor.send(this.getLatestSetup());
    }

    // Create temporary ready to swap out (So it is already set up)
    this.standbyProcess = this.createProcessor(cpuTotal);
    this.standbyProcess.send(this.getLatestSetup());

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
   * @memberof Host
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
   * @memberof Host
   */
  private createProcessor(cpuTotal?: number): ChildProcess {
    // Create Process
    const pFork = fork(`${__dirname}/process.js`, [], {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    // Reusable restart process from error with current scope
    const unloadProcessorSafely = (...error: any[]) => {
      ActiveLogger.fatal(error, "Processor Crashed");

      // Push standby process
      this.processors.push(this.standbyProcess);

      // Find the bad process
      const pos = this.processors.findIndex((processor) => {
        return processor.pid === pFork.pid;
      });
      // Remove from processors list and create new
      if (pos !== -1) {
        this.processors.splice(pos, 1);
      }

      // We should now create a new standby processor
      this.standbyProcess = this.createProcessor();
      this.standbyProcess.send(this.getLatestSetup());

      // Wait for current tansactions to finish (Destroy can take up to 5 minutes)
      setTimeout(() => {
        // Look for any transactions which are in this processor
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
            this.release(pending, true);
          }
        });

        // Instruct child to terminate. (Clears memory)
        // Even though we should be clear timeout to act as a buffer and
        // push to the end of the event loop
        setTimeout(() => {
          pFork.kill();
        }, 2500);
        // Contracts which extend timeout will still be at risk hence the above
      }, 420000);
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
          ActiveLogger.debug("Broadcasting TX : " + m.data.umid);
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
            this.release(pending, true);
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
              neighbourhood: this.neighbourhood.get(),
            },
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
      this.findProcessor(this.processPending[umid].pid)?.send({
        type: "destory",
        data: {
          umid,
        },
      });
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
          [this.reference]:
            this.processPending[umid].entry.$nodes[this.reference],
        },
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
   * @memberof Host
   */
  private labelOrKey(txIO: any): string[] {
    // Get reference for input or output
    const keys = Object.keys(txIO || {});
    const out: string[] = [];

    for (let i = keys.length; i--; ) {
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
   * @memberof Host
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
   * Trigger a hold of the stream locks the process wants to own
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} v
   * @param {number} retries
   * @memberof Host
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
        if (retries > ActiveOptions.get<number>("queue_retry", 5)) {
          this.processPending[v.$umid].reject({
            status: 100,
            error: "Busy Locks",
          });
          this.release(this.processPending[v.$umid], true);
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
   * @param {boolean} noWait Don't wait to release
   * @memberof Host
   */
  private release(pending: process, noWait = false) {
    // Ask for releases
    Locker.release([
      ...this.labelOrKey(pending.entry.$tx.$i),
      ...this.labelOrKey(pending.entry.$tx.$o),
    ]);

    // Check the lock queue
    this.processQueue();

    // Shared removal method for instant or delayed.
    // delayed only used on broadcast but only paniced processes call instant
    const remove = () => {
      // Remove from pending list
      if (pending.entry) {
        this.destroy(pending.entry.$umid);
      }
    };

    if (noWait) {
      remove();
    } else {
      // Keep transaction in memory for a bit (5 Minutes)
      setTimeout(() => {
        remove();
      }, 300000); //20000
    }
  }

  /**
   * Manages the busy lock queue
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} [next]
   * @memberof Host
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
   * @memberof Host
   */
  private timerQueue() {
    setTimeout(() => {
      this.processQueue();
      this.timerQueue();
    }, 10000);
  }

  /**
   * Manage Hybrid Nodes
   *
   * @private
   * @param {string} tx
   * @param {ActiveDefinitions.IStreams} [activityStreams]
   * @memberof Host
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
                      const path = `${process.cwd()}/contracts/${
                        tx.$tx.$namespace
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
                    for (let i = keys.length; i--; ) {
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
   * @memberof Host
   */
  private hybridLabelKeyId(txIO: ActiveDefinitions.LedgerIORputs): string[] {
    // Get reference for input or output
    const streams = Object.keys(txIO);

    // Check the first one, If labelled then loop all.
    // Means first has to be labelled but we don't want to loop when not needed
    if (txIO[streams[0]].$stream) {
      const streamMap: string[] = [];
      for (let i = streams.length; i--; ) {
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
   * @memberof Host
   */
  private processEndpoints(
    req: IncomingMessage,
    res: ServerResponse,
    body?: any,
    from?: string
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
