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
   * @memberof HybridNode
   */
  dbConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @type {ActiveDSConnect}
   * @memberof HybridNode
   */
  dbErrorConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb event instance for this node
   *
   * @type {ActiveDSConnect}
   * @memberof HybridNode
   */
  dbEventConnection: ActiveDSConnect;

  /**
   * Http server to listen for transactions
   *
   * @type {ActiveHttpd}
   * @memberof HybridNode
   */
  httpServer: ActiveHttpd;

  /**
   *Creates an instance of HybridNode.
   * @param {IUpstreamNode} upstreamNode
   * @memberof HybridNode
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
  }

  /**
   * Processs routes without a path (Transactions)
   *
   * @private
   * @param {IActiveHttpIncoming} incoming
   * @param {IncomingMessage} req
   * @returns {Promise<unknown>}
   * @memberof HybridNode
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
          if (!this.authTokenCheck(req.headers)) return resolve();

          // Create new Protocol Process object for transaction
          const protocol = this.getContractProtocol(tx);

          // Simpler UnhandledRejects Processing
          process.once("unhandledRejection", async () => {
            ActiveLogger.error("Unhandled Rejection");
            // Create error record about failure
            const result = await this.raiseError({
              code: 10500,
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
            const result = this.raiseError({
              code: 10000,
              transaction: tx,
              reason: error,
              streamState: {}
            });

            // Let mainnet node know, It will send the latest state for us to consider
            resolve({ status: "failed", streamState: result });
          });

          // Start the process
          protocol.start();
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
   * Start Hybrider Listner (Single Threaded Process for now)
   *
   * @param {boolean} [enableLogs=false]
   * @memberof HybridNode
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
        ActiveLogger.info("Activecore Hybrid is running at 0.0.0.0:" + port);
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
   * @memberof HybridNode
   */
  private getContractProtocol(
    tx: ActiveDefinitions.LedgerEntry
  ): ActiveProtocol.Process {
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
    return new ActiveProtocol.Process(
      tx,
      "hybrid",
      "hybrid",
      {} as any,
      this.dbConnection,
      this.dbErrorConnection,
      this.dbEventConnection,
      // Fix this, So we can run all in contract encryption / decryption processes but as developers won't know the hybrid nodes they cant be targetting
      new ActiveCrypto.Secured(ActiveOptions.get<any>("db", false), {}, {})
    );
  }

  /**
   * Raises error into the database returning its id
   *
   * @private
   * @param {*} doc
   * @returns {Promise<string>}
   * @memberof HybridNode
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
    console.log(this.upstreamNode.remote + " == " + ip.remote);
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
   * @memberof HybridNode
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
