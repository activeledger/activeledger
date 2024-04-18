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

import { symlinkSync, existsSync } from "fs";
import {
  ActiveHttpd,
  IActiveHttpIp,
  IActiveHttpIncoming
} from "@activeledger/httpd";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveRequest
} from "@activeledger/activeoptions";
import { IUpstreamNode } from "./interfaces/hybrid.interface";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { IncomingMessage, IncomingHttpHeaders } from "http";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { IStreams } from "@activeledger/activedefinitions/lib/definitions";
import { Contract } from "./contract";

/**
 * Hybrid Node Handler
 *
 * @export
 * @class HybridNode
 */
export class HybridNode {
  /**
   * Server connection to the couchdb instance for this node
   *
   * @type {ActiveDSConnect}
   */
  dbConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @type {ActiveDSConnect}
   */
  dbErrorConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb event instance for this node
   *
   * @type {ActiveDSConnect}
   */
  dbEventConnection: ActiveDSConnect;

  /**
   * Http server to listen for transactions
   *
   * @type {ActiveHttpd}
   */
  httpServer: ActiveHttpd;

  /**
   *Creates an instance of HybridNode.
   * @param {IUpstreamNode} upstreamNode
   */
  constructor(private upstreamNode: IUpstreamNode) {
    // Get Default Db connection data
    const db = ActiveOptions.get<any>("db", false);

    // Create connection string
    this.dbConnection = new ActiveDSConnect(db.url + "/" + db.database);
    this.dbConnection.info();

    // Create connection string
    this.dbErrorConnection = new ActiveDSConnect(db.url + "/" + db.error);
    this.dbErrorConnection.info();

    // Create connection string
    this.dbEventConnection = new ActiveDSConnect(db.url + "/" + db.event);
    this.dbEventConnection.info();

    // Create Server
    this.httpServer = new ActiveHttpd(true);

    // Listen for root requests
    this.httpServer.use(
      "/",
      "POST",
      (incoming: IActiveHttpIncoming, req: IncomingMessage) => {
        return this.requestRoot(incoming, req);
      }
    );

    // Listen for stream state responses from host hybrid node
    this.httpServer.use(
      "/streamState/*",
      "POST",
      (incoming: IActiveHttpIncoming, req: IncomingMessage) => {
        return this.requestErrorRestore(incoming, req);
      }
    );

    // Best Effort tx Catch Up!
    this.httpServer.use(
      "/q/",
      "POST",
      (incoming: IActiveHttpIncoming, req: IncomingMessage) => {
        return this.requestQBack(incoming, req);
      }
    );
  }

  /**
   * Processs routes without a path (Transactions)
   *
   * @private
   * @param {IActiveHttpIncoming} incoming
   * @param {IncomingMessage} req
   * @returns {Promise<unknown>}
   */
  private requestRoot(
    incoming: IActiveHttpIncoming,
    req: IncomingMessage
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      // Basic Check Transaction
      if (
        incoming.body &&
        ActiveDefinitions.LedgerTypeChecks.isEntry(incoming.body)
      ) {
        const tx = incoming.body as ActiveDefinitions.LedgerEntry;

        // Same entry point, So need to detect if its a new transaction or from the main network
        // The reason to using the same endpoint is that it will work with all existing code
        if (this.isUpStream(incoming.ip)) {
          // Token Check
          if (!this.authTokenCheck(req.headers)) return resolve({});

          // Create new Protocol and process transaction
          this.contractProcessor(tx)
            .then(resolve)
            .catch(reject);
        } else {
          // Standard Transaction, So just forward to upstream and return!
          ActiveRequest.send(
            `${this.upstreamNode.scheme}://${this.upstreamNode.remote}:${this.upstreamNode.port}`,
            "POST",
            [],
            tx,
            true
          )
            .then(r => resolve(r.data))
            .catch(reject);
        }
      } else {
        reject();
      }
    });
  }

  /**
   * Restores bad data from failed transactions using upstream servers latest state
   *
   *
   * @private
   * @param {IActiveHttpIncoming} incoming
   * @param {IncomingMessage} req
   * @returns {Promise<void>}
   */
  private async requestErrorRestore(
    incoming: IActiveHttpIncoming,
    req: IncomingMessage
  ): Promise<void> {
    // Validate the request
    if (
      incoming.url.length === 2 &&
      this.isUpStream(incoming.ip) &&
      this.authTokenCheck(req.headers)
    ) {
      ActiveLogger.info(
        `Error Data Forward Recovery Started (${incoming.url[1]})`
      );

      // Fetch the error document for reference
      const errorDoc = await this.dbErrorConnection.get(incoming.url[1]);
      const tx = errorDoc.transaction as ActiveDefinitions.LedgerEntry;

      // Check Umid Match
      if (!errorDoc.processed && tx.$umid === incoming.body.umid) {
        // Which documents can be changed
        const changable = new Set<string>([
          ...Object.keys(tx.$tx.$i || {}),
          ...Object.keys(tx.$tx.$o || {})
        ]);

        // Streams that can be forced purged and updated
        const writableStreams: IStreams[] = [];

        // Contracts to write to disl
        const writableContractCode: IStreams[] = [];

        // Loop streams, See if they're safe or "new"
        for (let i = incoming.body.streams.length; i--; ) {
          const stream = incoming.body.streams[i] as {
            id: string;
            doc: any;
          };
          // Can the stream be changed?
          // (Detecting we can remove :stream and flow will work for both)
          if (changable.has(stream.id.replace(":stream", ""))) {
            // Can Update
            writableStreams.push(stream.doc);

            // Purge Existing (sync shouldn't cause issues)
            await this.purgeStream(stream.id);

            // Contains Contracts?
            if (this.isContractStream(stream.doc)) {
              writableContractCode.push(stream.doc);
            }
          } else {
            // Maybe we can change if its NEW stream
            // Check database to make sure it doesn't exist
            if (
              !(
                await this.dbConnection.allDocs({
                  key: stream.id
                })
              ).rows.length
            ) {
              // Can Write
              writableStreams.push(stream.doc);

              // Contains Contracts?
              if (this.isContractStream(stream.doc)) {
                writableContractCode.push(stream.doc);
              }
            }
            // TODO : It need to look at revision information now, Edge use case contract may have been updated!
            // We may also assume the contract may have changed by putting it into the set
          }
        }

        // Streams to be written?
        if (writableStreams.length) {
          ActiveLogger.info(`Writing ${writableStreams.length} streams`);
          await this.dbConnection.bulkDocs(writableStreams, {
            new_edits: false
          });

          // Write Contracts
          if (writableContractCode.length) {
            ActiveLogger.info(
              `Created ${writableContractCode.length} contracts`
            );

            for (let i = writableContractCode.length; i--; ) {
              Contract.rebuild(writableContractCode[i]);
            }

            // If 1 then check for symlink that may need to be created
            if (writableContractCode.length === 1) {
              const contract = writableContractCode[0] as any;
              // Check it doesn't exist
              if (
                !existsSync(
                  `./${tx.$tx.$contract}.js`
                )
              ) {
                symlinkSync(
                  `./${contract._id}.js`,
                  `./contracts/${contract.namespace}/${tx.$tx.$contract}.js`,
                  "file"
                );
              }
            }
          }

          // Update the error document
          errorDoc.processed = true;
          await this.dbErrorConnection.post(errorDoc);
          ActiveLogger.info("Error Recovered Document Updated");
        }
      }
    }
    return;
  }

  /**
   * Process any transaction queued up on the upstream node
   * Using best effort to catch up correctly
   *
   * @private
   * @param {IActiveHttpIncoming} incoming
   * @param {IncomingMessage} req
   * @returns {void}
   */
  private requestQBack(
    incoming: IActiveHttpIncoming,
    req: IncomingMessage
  ): void {
    if (this.isUpStream(incoming.ip) && this.authTokenCheck(req.headers)) {
      const txs = incoming.body as string[];
      for (let i = txs.length; i--; ) {
        const tx: ActiveDefinitions.LedgerEntry = JSON.parse(txs[i]);
        this.contractProcessor(tx)
          .then(result => {
            if (result.status === "ok") {
              ActiveLogger.info(`${tx.$umid} Transaction Caught Up`);
            } else {
              ActiveLogger.warn(
                `${tx.$umid} Transaction Problem (${result.streamState})`
              );
            }
          })
          .catch();
      }
    }
    return;
  }

  /**
   * Delete a record fully from the database (Dangerous Operation!)
   *
   * @private
   * @param {string} id
   * @returns {Promise<void>}
   */
  private async purgeStream(id: string): Promise<void> {
    // Trusted Purged?
    // Do we have the same purge updated from x% of upstreams?

    // Remove record (Currently only 1 upstream supported)
    try {
      const doc = await this.dbConnection.get(id);
      if (doc._id && doc._rev) {
        await this.dbConnection.purge(doc);
      }
    } catch {}
    return;
  }

  /**
   * Start Hybrider Listner (Single Threaded Process for now)
   *
   * @param {boolean} [enableLogs=false]
   */
  public start(enableLogs: boolean = false) {
    // Make sure Index exists
    // Create Index
    this.dbConnection
      .createIndex({
        index: {
          fields: ["namespace", "type", "_id"]
        }
      })
      .then(() => {
        const [, port] = ActiveOptions.get<String>("host", ":5260").split(":");
        this.httpServer.listen(parseInt(port), enableLogs);
        ActiveLogger.info("Activehybrid is running at 0.0.0.0:" + port);
      })
      .catch(() => {
        throw new Error("Couldn't create default index");
      });
  }

  /**
   * Creates the environment to run the transaction through the ledger protocol process
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} tx
   * @returns {ActiveProtocol.Process}
   */
  private contractProcessor(tx: ActiveDefinitions.LedgerEntry): Promise<any> {
    return new Promise((resolve, reject) => {
      // Manipulate transaction to by hybrid safe
      this.makeHybrid(tx);

      // What to do with locking, Same principle? Or self manage
      // we should self manage here because mainnet wont really submit
      // unless we get into handling that on the mainnet side. Then we could get stuck in
      // forever loops!

      //#region Ignored Events
      // Event: Manage broadcast
      // Hybrid doesn't need to broadcast as it isn't a network its store and forward
      // protocol.on("broadcast", () => {});

      // Event: Manage Reload Requests
      // We won't be adding / removing nodes so no need to reload!
      // INFO : Possibly we need to create code to ignore those type of transactions?
      // protocol.on("reload", () => {});

      // Event: Manage Throw Transactions
      // Developers won't know about all the hybrid nodes
      // So we can ignore this event
      // protocol.on("throw", (response: any) => {});
      //#endregion

      // Create Protocol Process as mainnet
      const protocol = new ActiveProtocol.Process(
        tx,
        "hybrid",
        "hybrid",
        {} as any,
        this.dbConnection,
        this.dbErrorConnection,
        this.dbEventConnection,
        // Developers can't target Hybrid for encryption / decryption but can still use stream public keys
        new ActiveCrypto.Secured(ActiveOptions.get<any>("db", false), {}, {})
      );

      // Simpler UnhandledRejects Processing
      process.once("unhandledRejection", async () => {
        ActiveLogger.error("Unhandled Rejection");
        // Create error record about failure
        const result = await this.raiseError({
          code: 10500,
          processed: false,
          transaction: tx,
          reason: "Unhandled Rejection",
          streamState: {}
        });

        // Let mainnet node know, It will send the latest state for us to consider
        resolve({ status: "failed", streamState: result });
      });

      // Event: Manage Commits
      protocol.once("commited", () => {
        // Send on to IoT? (See Above)
        resolve({ status: "ok" });
      });

      // Event: Manage Failed
      protocol.once("failed", async (error: any) => {
        ActiveLogger.error(error, "Failed Tx");
        // Create error record about failure
        const result = await this.raiseError({
          code: 10000,
          processed: false,
          transaction: tx,
          reason: error,
          streamState: {}
        });

        // Ready Main net response
        const response = {
          status: "failed",
          streamState: result,
          contract: 0
        };

        // Are we missing the contract?
        if (error.status === 1401) {
          response.contract = 1;
        }

        // Let mainnet node know, It will send the latest state for us to consider
        resolve(response);
      });

      // Start the process
      protocol.start();
    });
  }

  /**
   * Detects if the stream contains contract data
   *
   * @private
   * @param {*} data
   * @returns {boolean}
   */
  private isContractStream(data: any): boolean {
    return data.namespace && data.contract && data.compiled ? true : false;
  }

  /**
   * Raises error into the database returning its id
   *
   * @private
   * @param {*} doc
   * @returns {Promise<string>}
   */
  private async raiseError(doc: any): Promise<string> {
    ActiveLogger.error(doc.reason, "Transaction Failure");
    return (await this.dbErrorConnection.post(doc)).id;
  }

  /**
   * Detect where the transaction comes from
   *
   * @param {IActiveHttpIp} ip
   * @returns {boolean}
   */
  private isUpStream(ip: IActiveHttpIp): boolean {
    return this.upstreamNode.remote === (ip.proxy || ip.remote) ? true : false;
  }

  /**
   * Takes the transaction and modify to work in a single hybrid environment
   *
   * @param {ActiveDefinitions.LedgerEntry} tx
   * @returns {void}
   */
  private makeHybrid(tx: ActiveDefinitions.LedgerEntry): void {
    // Let Contract know its running inside a hybrid
    tx.$nodes = {
      hybrid: {
        vote: false,
        commit: false
      }
    };

    // Make sure it isn't a broadcast transaction
    tx.$broadcast = false;
    return;
  }

  /**
   * Check authentication headers match up/down stream nodes
   *
   * @private
   * @param {IncomingHttpHeaders} headers
   * @returns {boolean}
   */
  private authTokenCheck(headers: IncomingHttpHeaders): boolean {
    if (headers["x-activeledger"] !== this.upstreamNode.auth) {
      ActiveLogger.error(
        "Incorrect Authentication Header Value (" +
          headers["x-activeledger"] +
          ")"
      );
      return false;
    }
    return true;
  }
}
