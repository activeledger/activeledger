#!/usr/bin/env node

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
  ActiveOptions,
  ActiveDSConnect,
  ActiveChanges
} from "@activeledger/activeoptions";
import * as fs from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork } from "@activeledger/activenetwork";
import {
  IChange,
  IChangeDocument,
  IResponse
} from "./interfaces/document.interfaces";
import { Sledgehammer } from "./sledgehammer";
import { Contract } from "./contract";
import { rejects } from "assert";

class ActiveRestore {
  private verbose = true;

  private configName = "config.json";

  private network: ActiveNetwork.Home;

  private isSelfhost = false;

  private database: ActiveDSConnect;

  private errorDatabase: ActiveDSConnect;

  private errorFeed: ActiveChanges;

  private isQuickFullRestore = false;

  private neighbourCount: number;

  private consensusReachedAmount: number;

  private attemptUmidDoc = false;

  private umidDoc: any;

  constructor() {
    ActiveOptions.init();

    this.getIdentity()
      .then(() => {
        return this.getConfig();
      })
      .then(() => {
        return this.setupDatabase();
      })
      .then(() => {
        return this.getConsensusData();
      })
      .then(() => {
        if (!this.isQuickFullRestore) {
          this.errorListener();
          this.errorFeed.start();
        } else {
          this.runQuickFullRestore();
        }
      })
      .catch((error: Error) => {
        ActiveLogger.error(error);
      });
  }

  private output(message: string, other?: any) {
    if (this.verbose) {
      other ? ActiveLogger.info(other, message) : ActiveLogger.info(message);
    }
  }

  // #region Initialisation
  private setConfigData(key: string, data: string) {
    this.output("Setting " + key);
    ActiveOptions.set(key, data);
  }

  private getConfig(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output("Getting Config");

      let path = ActiveOptions.get<string>("path", "");
      let config = ActiveOptions.get<string>("config", this.configName);

      path
        ? this.setConfigData("config", path + config)
        : this.output("No config path found");

      !fs.existsSync(config)
        ? () => {
            throw ActiveLogger.fatal(`No config file found (${config})`);
          }
        : this.output("Config path found");

      this.output("Parsing Config");
      ActiveOptions.parseConfig();

      this.output("Extending Config");
      ActiveOptions.extendConfig()
        .then(() => {
          this.output("Config Extended");
          resolve();
        })
        .catch((err: unknown) => {
          reject(err);
        });
    });
  }

  private getIdentity(): Promise<void> {
    return new Promise((resolve) => {
      this.output("Getting Identity");

      const identity = ActiveOptions.get<string | boolean>("identity", false);
      const path = ActiveOptions.get<string>("path", ".") + "/.identity";

      identity
        ? this.setConfigData("identity", path)
        : this.output("No identity found");

      !fs.existsSync(path)
        ? () => {
            throw ActiveLogger.fatal(`No Identity file found (${path})`);
          }
        : this.output("Identity path found");

      resolve();
    });
  }

  private setupSelfHostDB(dbConfig: any) {
    this.output("Setting up self hosted database");
    this.isSelfhost = true;
    dbConfig.url = "http://127.0.0.1:" + dbConfig.selfhost.port;

    // Update path to override the default CoudhDB
    dbConfig.path = dbConfig.selfhost.dir || "./.ds";

    // Set the modified data
    ActiveOptions.set("db", dbConfig);
  }

  private setupErrorDB(dbConfig: any) {
    // Get error database connection
    this.errorDatabase = new ActiveDSConnect(
      `${dbConfig.url}/${dbConfig.error}`
    );

    // Initialise Error feed
    this.errorFeed = new ActiveChanges("Restore", this.errorDatabase, 1);
  }

  private setupDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dbConfig = ActiveOptions.get<any>("db", {});

      // Check if selfhosted
      dbConfig.selfhost
        ? this.setupSelfHostDB(dbConfig)
        : this.output("Not using self hosted database");

      // Initialise ActiveNetwork for communications management (knock all)
      this.output("Initialising ActiveNetwork");
      this.network = new ActiveNetwork.Home();

      // Initialise live database connection
      this.output("Initialising ActiveDSConnect");
      this.database = new ActiveDSConnect(
        `${dbConfig.url}/${dbConfig.database}`
      );

      !ActiveOptions.get<boolean>("full", false)
        ? this.setupErrorDB(dbConfig)
        : (this.isQuickFullRestore = true);

      resolve();
    });
  }

  private getConsensusData(): Promise<void> {
    return new Promise((resolve) => {
      // Get the amount of neighbours in the network
      this.neighbourCount = ActiveOptions.get<Array<any>>(
        "neighbourhood",
        []
      ).length;

      // Get the minimum amount to reach consensus
      this.consensusReachedAmount = ActiveOptions.get<any>(
        "consensus",
        {}
      ).reached;

      resolve();
    });
  }
  // #endregion

  // #region Error Feed Listening
  getNeighbourCount = (dontIncludeSelf: boolean) =>
    dontIncludeSelf ? this.neighbourCount - 1 : this.neighbourCount;

  metConsensus = (votes: number, dontIncludeSelf: boolean = false) =>
    (votes / this.getNeighbourCount(dontIncludeSelf)) * 100 >=
    this.consensusReachedAmount
      ? true
      : false;

  private errorListener(): void {
    /* 
      Error Codes
      950  = Stream not found 
      960  = State not found
      1000 = Vote failed (Similar to 1505, but has a different report time)
      1200 = Stream position incorrect
      1210 = Read only stream not found
      1505 = This node voted no, possibly incorrectly (Similar to 1000, but has a different report time)
      1510 = Failed to save, this might have been the only node to vote
      1610 = Failed to get a response back in a rebroadcast while the transaction was in memory
    */
    const errorCodes = [950, 960, 1200, 1210, 1510, 1600, 1610];

    // Does the transaction have votes
    const hasVote = (data: any) => (data.vote ? true : false);

    // Has the transaction met consensus

    // Handle consensus not being met
    const handleConsensusNotMet = (changeDoc: any) => {
      this.output("Conensus not met.");
      changeDoc.code === 1200
        ? this.dataIntegrityCheck(changeDoc)
        : this.setProcessed(changeDoc);
    };

    // Does the transaction have an error code
    const hasErrorCode = (changeDoc: any) =>
      errorCodes.indexOf(changeDoc.code) !== -1 ? true : false;

    const beginMain = (changeDoc: any, transaction: any) => {
      // Check for true votes
      this.output("Checking votes");
      const votes = Object.values(transaction.$nodes).filter(hasVote).length;
      this.output(`Vote total: ${votes}`);

      // Check if votes reached consensus
      // Code 1200: If votes did not, transaction was voted incorrect by majority, we can safely ignore it
      // Everything else: Might be ahead so check for incorrect stream position
      this.output("Checking if consensus has been met.");
      this.metConsensus(votes)
        ? this.dataIntegrityCheck(changeDoc)
        : handleConsensusNotMet(changeDoc);
    };

    // Check that a transaction is compatible
    const isCompatibleTransaction = (changeDoc: any) =>
      changeDoc.code !== 1510 &&
      changeDoc.code !== 1000 &&
      !changeDoc.transaction.$broadcast
        ? true
        : false;

    const handleNotProcessed = (changeDoc: any) => {
      this.output("Document not yet processed.");
      // Check the error codes
      if (hasErrorCode(changeDoc)) {
        this.output("Document has errored.");
        // If failed to save can't rely on data in the body
        // If vote failed might not have node responses
        // If broadcast can't rely on the data

        this.output(
          `Is this a compatible transaction: ${isCompatibleTransaction(
            changeDoc
          )}`
        );

        isCompatibleTransaction(changeDoc)
          ? beginMain(changeDoc, changeDoc.transaction)
          : // If all nodes voted false check the integrity to verify.
            // They might have voted no because this revision is wrong.
            this.dataIntegrityCheck(changeDoc);
      } else {
        this.output("Document has no error code.");
        this.setProcessed(changeDoc);
      }
    };

    this.errorFeed.on("change", (change: IChange) => {
      this.output("Change event received, pausing error feed.");
      // Pause error feed to process
      this.errorFeed.pause();

      const changeDoc = change.doc;

      this.output("Checking if document already processed.");
      // Has the document been processed? If yes resume feed
      !changeDoc.processed
        ? handleNotProcessed(changeDoc)
        : this.errorFeed.resume();
    });
  }

  private async dataIntegrityCheck(document: IChangeDocument): Promise<void> {
    ActiveLogger.info("Data Check - Blocking Network");

    // Delay to allow network to finish processing
    setTimeout(async () => {
      ActiveLogger.info("Data Check - Resuming");

      //  Get the revisions
      this.output("Getting revisions");
      const revs = await this.getRevisions(document);

      // Output possible stream changes
      ActiveLogger.info(revs, "$stream revisions");

      this.output("Getting network stream data");
      const reducedStreamData = await this.getNetworkStreamData(revs);

      this.output("Checking for consensus");
      const checkForConsensus = await this.consensusCheck(
        reducedStreamData,
        document
      );
    }, 6000);
  }

  private getRevisions(document: IChangeDocument): Promise<string[]> {
    const responseHasError = (data: any) => (data.error ? true : false);

    const createStreamCache = (data: any) => {
      this.umidDoc = data;
      let concatArray;

      data.streams
        ? (concatArray = [...data.streams.new, ...data.streams.updated])
        : (concatArray = []);

      return concatArray;
    };

    const revisionAlreadyStored = (revisions: any, revision: any) =>
      revisions[revision] ? true : false;

    return new Promise((resolve, reject) => {
      this.output("Getting revisions");
      const transaction = document.transaction;

      const revisions: string[] = [
        ...(Object.keys(transaction.$revs.$i || {}) as string[]),
        ...(Object.keys(transaction.$revs.$o || {}) as string[]),
        ...(Object.values(transaction.$tx.$r || {}) as string[])
      ];

      this.output(`Getting data from network. Using UMID:`, document.umid);
      this.network.neighbourhood
        .knockAll(`umid/${document.umid}`, null, true)
        .then((responses: IResponse[]) => {
          let streamCache: any[] = [];

          this.output("Network data", responses);

          // Merge streams from responses
          for (let i = responses.length; i--; ) {
            const response = responses[i];

            responseHasError(response)
              ? streamCache.push(...createStreamCache(response))
              : !this.attemptUmidDoc
              ? // The error could be on this node
                // Attempt to try and add the UMID
                (this.attemptUmidDoc = true)
              : reject("Unable to retrieve necessary data");
          }

          streamCache.length > 0
            ? this.output("Stream cache:", streamCache)
            : this.attemptUmidDoc
            ? this.output("Attempting UMID doc? " + this.attemptUmidDoc)
            : this.output("Stream cache empty and not attempting UMID doc.");

          const getId = (data: any) => data.id;
          const revNotStored = (data: any) => {
            return (array: string[]) => {
              return array.indexOf(data) > -1;
            };
          };

          const streamIds: string[] = streamCache
            .filter(revNotStored)
            .map(getId);

          revisions.concat(...streamIds);

          // Need to add :stream as well
          // As revs is prepopulated we need to go through the revs array and add :stream
          for (let i = revisions.length; i--; ) {
            revisions.push(`${revisions[i]}:stream`);
          }

          resolve(revisions);
        })
        .catch((err: unknown) => {
          console.error(err);
        });
    });
  }

  private consensusCheck(
    reducedStreamData: any,
    document: IChangeDocument
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const streams = Object.keys(reducedStreamData);
      const promiseHolder = [];

      for (let i = streams.length; i--; ) {
        const streamIndex = streams[i];
        const stream = reducedStreamData[streamIndex];

        const revs = Object.keys(stream);

        for (let i = revs.length; i--; ) {
          const revisionIndex = revs[i];
          const revisionCount = stream[revisionIndex];

          // this.metConsensus(revisionCount)

          if (this.metConsensus(revisionCount, true)) {
            ActiveLogger.info(`WW🐔D - ${streamIndex}@${revisionIndex}`);
            promiseHolder.push(this.fixStream(streamIndex, revisionIndex));
          }
        }
      }

      Promise.all(promiseHolder)
        .then((results: unknown[]) => {
          this.setProcessed(document);

          if (results.some((e: boolean) => e)) {
            this.hammerTime();
          } else {
            ActiveLogger.warn("Data Check - False Positive");

            if (this.attemptUmidDoc) {
              this.insertUmid(this.umidDoc);
            }
          }
        })
        .catch((error: Error) => {
          ActiveLogger.error(error, "All Datafix processes errored");
        });
    });
  }

  private hammerTime(): Promise<any> {
    return new Promise((resolve, reject) => {
      Sledgehammer.smash()
        .then(() => {
          ActiveLogger.info("Smashing complete");

          if (this.attemptUmidDoc) {
            this.insertUmid(this.umidDoc);
          }

          // TODO: Move this to the end of promise call, and all the others too
          this.errorFeed.resume();
          resolve();
        })
        .catch((error: Error) => {
          ActiveLogger.error(error, "Hammer broke");
          this.errorFeed.resume();
          reject();
        });
    });
  }

  private insertUmid(umidDoc: any): void {
    if (umidDoc) {
      this.database
        .bulkDocs([umidDoc], { new_edits: false })
        .then(() => {
          ActiveLogger.info("UMID Added");
        })
        .catch((error: Error) => {
          ActiveLogger.info(error || umidDoc, "Adding UMID failed");
        });
    }
  }

  private fixStream(streamId: any, revision: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.database
        .get(streamId)
        .then((document: any) => {
          if (document._rev === revision) {
            resolve(false);
          } else {
            this.fixDocument(document, streamId, revision, false)
              .then(resolve)
              .catch(reject);
          }
        })
        .catch((err: unknown) => {
          this.fixDocument({ _id: streamId }, streamId, revision, false)
            .then(resolve)
            .catch(reject);
        });
    });
  }

  private fixDocument(
    document: any,
    streamId: string,
    revision: string,
    volatile: boolean
  ): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      const streamData = await this.getNeighbourhoodStreamData(
        document,
        streamId,
        revision,
        volatile
      );
    });
  }

  private getNeighbourhoodStreamData(
    document: IChangeDocument,
    $stream: string,
    $rev: string,
    volatile: boolean
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.network.neighbourhood
        .knockAll("stream", { $stream, $rev }, true)
        .then((streams: any) => {
          for (let i = streams.length; i--; ) {
            const stream = streams[i];
            if (stream.error) {
              if (
                document.error &&
                document.status &&
                document.message &&
                document.docId &&
                document.status === 404 &&
                document.message === "missing"
              ) {
                document._id = document.docId;
              }

              if (stream && !Array.isArray(stream)) {
                if (this.isSelfhost) {
                  return this.rebuildSelf(document, stream);
                } else {
                  return this.rebuildRemote(document, stream, volatile);
                }
              }
            }
          }
        })
        .catch((error: Error) => {
          ActiveLogger.info(error, "Error Message");
          ActiveLogger.info(document, "Document");
          resolve(false);
        });
    });
  }

  private rebuildRemote(
    document: any,
    stream: any,
    volatile: boolean
  ): Promise<any> {
    const isVolatileStreamData = (volatile: boolean, data: any) =>
      volatile && data._id.indexOf(":stream") > -1 ? true : false;

    const isRequiredStreamData = (stream: any) =>
      stream.namespace && stream.contract && stream.compiled ? true : false;

    return new Promise(async (resolve, reject) => {
      this.output("Begginning data remote rebuild process");
      this.output("Re-writing stream");
      document.$activeledger = {
        delete: true,
        rewrite: stream
      };

      this.output("Attempting to add updated document to database");
      try {
        await this.database.put(document);
      } catch (error) {
        reject(error);
      }

      this.output("Checking stream data");
      isRequiredStreamData(stream)
        ? Contract.rebuild(stream)
        : this.output("Stream data does not contain required data");

      this.output("Checking for volatile");
      isVolatileStreamData(volatile, document)
        ? await this.database.put({
            _id: document._id.replace(":stream", ":volatile"),
            _rev: document._rev
          })
        : this.output("Data is not volatile");

      resolve(true);
    });
  }

  private rebuildSelf(document: any, stream: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.output("Begginning data rebuild process on self");
      this.database
        .purge(document)
        .then(() => {
          return this.database.bulkDocs([stream], { new_edits: false });
        })
        .then(() => {
          resolve(true);
        })
        .catch((error: Error) => {
          reject(error);
        });
    });
  }

  private getNetworkStreamData($streams: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      this.network.neighbourhood
        .knockAll("stream", { $streams }, true)
        .then((streamData) => {
          let reduction = {};

          for (let i = streamData.length; i--; ) {
            const streams = streamData[i];
            if (!streams.error) {
              reduction = this.reduceStreamData(streams, reduction);
            }
          }

          resolve(reduction);
        })
        .catch((error: Error) => {
          this.errorFeed.resume();
          reject(error);
        });
    });
  }

  private reduceStreamData(streams: any, reduction: any): any {
    for (let i = streams.length; i--; ) {
      const stream = streams[i];

      // Is the stream ID already there
      if (!reduction[stream._id]) {
        reduction[stream._id] = {};
      }

      // Is the revision already there
      !reduction[stream._id][stream._rev]
        ? (reduction[stream._id][stream._rev] = 0)
        : reduction[stream._id][stream._rev]++;
    }
  }

  private setProcessed(document: IChangeDocument): Promise<void> {
    return new Promise((resolve, reject) => {
      document.processed = true;
      document.processedAt = new Date();

      this.errorDatabase
        .put(document)
        .then(() => {
          this.errorFeed.resume();
          resolve();
        })
        .catch((error: Error) => {
          // There may be conflicts as there are multiple streams per transaction, so multiple may have the haveProcessed flag
          // In the future this will be handled differently, but for now just resolve
          this.errorFeed.resume();
          reject(error);
        });
    });
  }
  // #endregion

  // #region Quick Full Restore

  private runQuickFullRestore(): void {
    ActiveLogger.info("Starting Quick Full Restore");

    const neighbourhood = this.network.neighbourhood.get();
    const nodes = Object.keys(neighbourhood);

    const promises: Array<Promise<any>> = [];

    for (let i = nodes.length; i--; ) {
      const node = neighbourhood[nodes[i]];

      if (node.reference !== ActiveNetwork.Home.reference) {
        promises.push(this.asyncRecursiveRebuild(node));
      }
    }

    Promise.all(promises)
      .then((results) => {
        let expandCompare: any = {};

        let consensusReached: Array<any> = [];

        for (let i = results.length; i--; ) {
          const list = results[i].streams;
          // TODO:
        }
      })
      .catch((err: unknown) => {
        console.error(err);
      });
  }

  private asyncRecursiveRebuild(node: ActiveNetwork.Neighbour): Promise<any> {
    return new Promise(async (resolve, reject) => {
      let output: any[] = [];
      const knockResults = await node.knock("all");

      if (knockResults.data) {
        const id = knockResults.data[knockResults.data.length - 1].id;
        output = (await node.knock(`all/${id}`)).data;
      }

      if (output) {
        resolve({ reference: node.reference, streams: output });
      } else {
        reject("No output");
      }
    });
  }

  // #endregion
}

new ActiveRestore();
