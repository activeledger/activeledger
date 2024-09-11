/*
 * MIT License (MIT)
 * Copyright (c) 2019 Activeledger
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

import { Helper } from "../helper/helper";
import { Provider } from "../provider/provider";
import {
  IChange,
  IChangeDocument,
  IResponse,
} from "../../interfaces/document.interfaces";
import { ActiveLogger } from "@activeledger/activelogger";
import { ErrorCodes } from "./error-codes.enum";
import { ActiveCrypto } from "@activeledger/activecrypto";

/**
 * Interagent that listens for error events and attempts to fix them
 *
 * @export
 * @class Interagent
 */
export class Interagent {
  private errorCodes = [
    ErrorCodes.StreamNotFound,
    ErrorCodes.StateNotFound,
    ErrorCodes.VoteFailedNetworkOk,
    ErrorCodes.InternalBusyLocked,
    ErrorCodes.StreamPositionIncorrect,
    ErrorCodes.ReadOnlyStreamNotFound,
    ErrorCodes.NodeFinalReject,
    ErrorCodes.FailedToSave,
    ErrorCodes.Unknown,
    ErrorCodes.FailedToGetResponse,
  ];

  /**
   * Flag dictating if the process should attempt to create a UMID doc
   *
   * @private
   */
  private attemptUmidDoc = false;

  /**
   * UMID document holder
   *
   * @private
   * @type {*}
   */
  private umidDoc: any;

  private skippedErrorInterval: Function;

  /**
   * Creates an instance of Interagent.
   */
  constructor() {
    this.listener();

    // Routine check for any documents missed due to restarts
    this.skippedErrorInterval = async () => {
      await this.skippedChecker();
      //await this.skippedArchieveChecker();

      // Next loop delay
      setTimeout(() => {
        this.skippedErrorInterval();
      }, 5000);
    }; //300000

    // Start up delay
    setTimeout(() => {
      this.skippedErrorInterval();
    }, 5000);
  }

  /**
   * Begins listenning to the errorfeed
   *
   * @private
   */
  private listener(): void {
    // Provider.errorFeed.on("change", async (change: IChange) => {
    //   Helper.output("Change event received, pausing error feed.");

    //   // Temporary solution while resolving resequencing to purges
    //   Provider.errorFeed.stop();
    //   await this.skippedChecker();
    //   Provider.errorFeed.start();
    //   return;

    /*

    const changeDoc = change.doc;

    Helper.output("Checking if document already processed.");

    // Has the document been processed?
    if (!changeDoc.processed) {
      try {
        if (await Provider.errorDatabase.exists(changeDoc._id)) {
          // Pause error feed to process
          Provider.errorFeed.pause();
          this.processDocument(changeDoc);
          Provider.errorFeed.resume();
          Helper.output("Restoration complete.");
        } else {
          // Stop Start listener to adjust for forced sequence change
          Provider.errorFeed.stop();
          Provider.errorFeed.start();
        }
      } catch (error) {
        ActiveLogger.error(error);
      }
    } else {
      // Move to archive
      await this.archive(changeDoc)
      Provider.errorFeed.resume();
    }
    */
    //});

    // Provider.archiveFeed.on("change", async (change: IChange) => {
    //   Helper.output("Change event received, pausing error feed.");

    //   // Temporary solution while resolving resequencing to purges
    //   Provider.archiveFeed.stop();
    //   await this.skippedArchieveChecker();
    //   Provider.archiveFeed.start();
    //   return;
    // });
  }

  /**
   * Get documents that are pending to be checked
   *
   * @private
   */
  private async skippedChecker() {
    // Get any existing error documents
    const docs = await Provider.errorDatabase.allDocs({
      include_docs: true,
      limit: 200,
    });

    if (docs.rows.length) {
      // Provider.errorFeed.pause();
      for (let i = docs.rows.length; i--;) {
        const doc = docs.rows[i];
        // If doc has been processed just move
        if (doc.processed) {
          await this.archive(doc);
        } else {
          await this.processDocument(doc);
        }
      }
      // Provider.errorFeed.resume();
    }
  }

  /**
   * Get documents that are pending to be checked
   *
   * @private
   */
  // private async skippedArchieveChecker() {
  //   // Get any existing archive documents
  //   const docs = await Provider.archiveDatabase.allDocs({
  //     include_docs: true,
  //     limit: 500,
  //   });

  //   if (docs.rows.length) {
  //     // Provider.archiveFeed.pause();
  //     for (let i = docs.rows.length; i--; ) {
  //       const doc = docs.rows[i];
  //       // Loop the map to find sequences
  //       const revMap = Object.keys(doc.rev_map);
  //       ActiveLogger.info(
  //         `Archiving ${doc._id} sequences total ${revMap.length}`
  //       );
  //       for (let ii = revMap.length; ii--; ) {
  //         // convert to sequence key name
  //         const seq = doc.rev_map[revMap[ii]].toString().padStart(16, "0");
  //         try {
  //           // Fetch sequence
  //           const data = ((await Provider.database.seqGet(seq)) as any).data;
  //           // Archive sequence
  //           await Provider.archiveArchive.post({
  //             _id: "SEQ-" + seq,
  //             stream: doc._id,
  //             data,
  //           });
  //           // Delete orignal sequence
  //           await Provider.database.seqDelete(seq);
  //         } catch (e) {
  //           ActiveLogger.info(`Sequence ${seq} not found`);
  //         }
  //       }
  //       // Move from archive to archived
  //       await Provider.archiveDatabase.purge(doc);

  //       // Collision prevention
  //       doc._id = Date.now() + ":" + doc._id;
  //       await Provider.archiveArchive.post(doc);
  //     }
  //     // Provider.archiveFeed.resume();
  //   }
  // }

  // #region Micro functions

  /**
   * Check if a transaction has votes
   *
   * @private
   */
  private hasVote = (data: any) => (!!data.vote);

  /**
   * Handle consensus not being met
   *
   * @private
   */
  private handleConsensusNotMet(changeDoc: any): Promise<void> {
    Helper.output("Conensus not met.");
    if (
      changeDoc.code === ErrorCodes.StreamPositionIncorrect ||
      changeDoc.code === ErrorCodes.StreamNotFound ||
      changeDoc.code === ErrorCodes.InternalBusyLocked
    ) {
      return this.dataIntegrityCheck(changeDoc);
    } else {
      return this.setProcessed(changeDoc);
    }
    // return changeDoc.code === ErrorCodes.StreamPositionIncorrect // 1200
    //   ? this.dataIntegrityCheck(changeDoc)
    //   : this.setProcessed(changeDoc);
  }

  /**
   * Does the transaction have an error code
   *
   * @private
   */
  private hasErrorCode = (changeDoc: any) =>
    this.errorCodes.indexOf(changeDoc.code) !== -1;

  /**
   * Check that a transaction is compatible
   *
   * @private
   */
  private isCompatibleTransaction = (changeDoc: any) =>
    changeDoc.code !== ErrorCodes.FailedToSave && // 1510
    changeDoc.code !== ErrorCodes.NodeFinalReject && // 1505
    changeDoc.code !== ErrorCodes.VoteFailed && // 1000
    !changeDoc.transaction.$broadcast;

  /**
   * Check if revision already stored
   *
   * @private
   */
  private revisionAlreadyStored = (revisions: any, revision: any) =>
    !!revisions[revision];

  /**
   * Check if the response has an error
   *
   * @private
   */
  private responseHasError = (data: any) => (!!data.error);

  /**
   * Create a cache of streams
   *
   * @private
   */
  private createStreamCache = (data: any) => {
    if (data.umid) {
      // Check valid umid document as been passed
      this.umidDoc = data;
    }
    let concatArray: any;

    data.streams
      ? (concatArray = [...data.streams.new, ...data.streams.updated])
      : (concatArray = []);

    return concatArray;
  };

  /**
   * Create a fix stream promise element
   *
   * @private
   */
  private handleStreamFixPromise = (streamIndex: any, revisionIndex: any) => {
    ActiveLogger.info(`WW🐔D - ${streamIndex}@${revisionIndex}`);
    return this.fixStream(streamIndex, revisionIndex);
  };

  /**
   * Check if document is missing
   *
   * @private
   */
  private isDocMissing = (document: any) =>
    !!(document.error &&
      document.status &&
      document.message &&
      document.docId &&
      document.status === 404 &&
      document.message === "missing");

  /**
   * Check if the stream data is in a correct format
   *
   * @private
   */
  private isStreamDefinedAndNotEmptyArray = (stream: any) =>
    !!(stream && !Array.isArray(stream));
  // #endregion

  /**
   * Handle a document not having the processed flag
   *
   * @private
   */
  private processDocument(changeDoc: any): Promise<void> {
    Helper.output("Document not yet processed.");
    // Check the error codes
    if (this.hasErrorCode(changeDoc)) {
      Helper.output("Document has errored.");

      Helper.output(
        `Is this a compatible transaction: ${this.isCompatibleTransaction(
          changeDoc
        )}`
      );

      return this.isCompatibleTransaction(changeDoc)
        ? this.beginMain(changeDoc, changeDoc.transaction)
        : // If all nodes voted false check the integrity to verify.
        // They might have voted no because this revision is wrong.
        this.dataIntegrityCheck(changeDoc);
    } else {
      Helper.output("Document has no error code.");
      return this.setProcessed(changeDoc);
    }
  }

  /**
   * Begin the main process
   *
   * @private
   */
  private beginMain(changeDoc: any, transaction: any): Promise<void> {
    // Check for true votes
    Helper.output("Checking votes");
    const votes = Object.values(transaction.$nodes).filter(this.hasVote).length;
    Helper.output(`Vote total: ${votes}`);

    // Check if votes reached consensus
    Helper.output("Checking if consensus has been met.");
    return Helper.metConsensus(votes)
      ? this.dataIntegrityCheck(changeDoc)
      : this.handleConsensusNotMet(changeDoc);
  }

  /**
   * Check the data's integrity
   *
   * @private
   * @param {IChangeDocument} document
   * @returns {Promise<void>}
   */
  private async dataIntegrityCheck(document: IChangeDocument): Promise<void> {
    return new Promise((resolve, reject) => {
      ActiveLogger.info("Data Check - Blocking Network");

      // Delay to allow network to finish processing
      setTimeout(async () => {
        ActiveLogger.info("Data Check - Resuming");

        try {
          // Did the nodes error together?
          Helper.output("Error Mismatch finder");
          if (!this.errorMismatchFinder(document)) {
            await this.setProcessed(document);
            return resolve();
          }

          //  Get the revisions
          Helper.output("Getting revisions");
          const revs = await this.getRevisions(document);

          // Output possible stream changes
          ActiveLogger.info(revs, "$stream revisions");

          Helper.output("Getting network stream data");
          const reducedStreamData = await this.getNetworkStreamData(revs);

          Helper.output("Checking for consensus");
          await this.consensusCheck(reducedStreamData, document);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 500);
    });
  }

  /**
   * Process the document error messages if 1505 to see if all nodes "agreed with the error"
   * If a single node was different to myself continue
   *
   * @private
   * @param {IChangeDocument} document
   * @returns
   */
  private errorMismatchFinder(document: IChangeDocument) {
    if (document.code === ErrorCodes.NodeFinalReject) {
      const nodeErrors = Object.keys(document.transaction.$nodes);
      // Sometimes a node doesn't attach correctly, Defaulting to unknown should trigger this to
      // still be checked as a last resort.
      const myError =
        document.transaction.$nodes[document.transaction.$origin]?.error || "unknown";
      // Loop nodes and search for different error
      for (let i = nodeErrors.length; i--;) {
        if (document.transaction.$nodes[nodeErrors[i]].error !== myError) {
          // Only verify 1 error is different instead of a conensus %
          // Continue processing
          return true;
        }
      }
      // Don't continue, All nodes should have failed together
      return false;
    }
    // Incorrect error code
    return true;
  }

  /**
   * Get the documents revisions
   *
   * @private
   * @param {IChangeDocument} document
   * @returns {Promise<string[]>}
   */
  private getRevisions(document: IChangeDocument): Promise<string[]> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Getting revisions");
      const transaction = document.transaction;

// TODO maybe get from $i $o rev maybe wrong?

      let revisions: string[] = [
        ...(Object.keys(transaction.$revs?.$i || {}) as string[]),
        ...(Object.keys(transaction.$revs?.$o || {}) as string[]),
        ...(Object.values(transaction.$tx.$r || {}) as string[]),
      ];

      Helper.output(`Getting data from network. Using UMID:`, document.umid);

      try {
        const responses: IResponse[] =
          await Provider.network.neighbourhood.knockAll(
            `umid/${document.umid}`,
            null,
            true
          );

        let streamCache: any[] = [];

        Helper.output("Network data", responses);

        // Merge streams from responses
        for (let i = responses.length; i--;) {
          const response = responses[i];

          !this.responseHasError(response)
            ? streamCache.push(...this.createStreamCache(response))
            : !this.attemptUmidDoc
              ? // The error could be on this node
              // Attempt to try and add the UMID
              (this.attemptUmidDoc = true)
              : null;
          //: reject("Unable to retrieve necessary data");
        }

        streamCache.length > 0
          ? Helper.output("Stream cache:", streamCache)
          : this.attemptUmidDoc
            ? Helper.output("Attempting UMID doc? " + this.attemptUmidDoc)
            : Helper.output("Stream cache empty and not attempting UMID doc.");

        const getId = (data: any) => data.id;
        const revNotStored = (data: any) => {
          return (array: string[]) => {
            return array.indexOf(data) > -1;
          };
        };

        const streamIds: string[] = streamCache.filter(revNotStored).map(getId);

        // Make sure revisions are imported from umid
        revisions = revisions.concat(...streamIds);

        // Need to add :stream as well
        // As revs is prepopulated we need to go through the revs array and add :stream
        for (let i = revisions.length; i--;) {
          revisions.push(`${revisions[i]}:stream`);
        }

        resolve(revisions);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Check the gathered data for consensus
   *
   * @private
   * @param {*} reducedStreamData
   * @param {IChangeDocument} document
   * @returns {Promise<any>}
   */
  private consensusCheck(
    reducedStreamData: any,
    document: IChangeDocument
  ): Promise<any> {
    return new Promise<void>(async (resolve, reject) => {
      const streams = Object.keys(reducedStreamData);
      const promiseHolder = [];

      for (let i = streams.length; i--;) {
        const streamIndex = streams[i];
        const stream = reducedStreamData[streamIndex];

        const revs = Object.keys(stream);

        for (let i = revs.length; i--;) {
          const revisionIndex = revs[i];
          const revisionCount = stream[revisionIndex];

          Helper.metConsensus(revisionCount, true)
            ? promiseHolder.push(
              this.handleStreamFixPromise(streamIndex, revisionIndex)
            )
            : promiseHolder.push(true);
        }
      }

      try {
        const results: unknown[] = await Promise.all(promiseHolder);

        await this.setProcessed(document);

        if (results.some((e: boolean) => e)) {
          ActiveLogger.warn("Data Check - False Positive");
          if (this.attemptUmidDoc) {
            await this.insertUmid(this.umidDoc);
          }
        }

        resolve();
      } catch (error) {
        ActiveLogger.error(error, "All Datafix processes errored");
        // While this is an error, It shouldn't stop the entire processing of the next record
        // This error is most likely a false negative that only this node raised so nothing to compare to.
        // Resolving here just moves onto the next error to be managed while rejecting prevented that
        resolve();
        //reject(error);
      }
    });
  }

  /**
   * Insert the UMID into the database
   *
   * @private
   * @param {*} umidDoc
   */
  private insertUmid(umidDoc: any): Promise<void> {
    return new Promise(async (resolve, reject) => {
      if (umidDoc) {
        try {
          // Create event id for umid 
          // This one will match all nodes so it could be "missed" by a parser
          //const _id = `umid:${new Date(umidDoc.umid.$datetime).getTime()},${umidDoc.umid.$umid}`
          
          // This method will have the umid "out of order" however a parser will not miss it
          const _id = `umid:${new Date().getTime()},${umidDoc.umid.$umid}`

          // Save umids to database
          await Provider.database.bulkDocs([umidDoc], { new_edits: false });
          await Provider.eventDatabase.post({
            _id
          }),

          ActiveLogger.info("UMID Added");
          resolve();
        } catch (error) {
          ActiveLogger.info(error || umidDoc, "Adding UMID failed");
          reject(error);
        }
      } else {
        resolve();
      }
    });
  }

  /**
   * Using the provided data, initialise fixing the stream
   *
   * @private
   * @param {*} streamId
   * @param {*} revision
   * @returns {Promise<boolean>}
   */
  private fixStream(streamId: any, revision: any): Promise<boolean> {
    Helper.output(`Stream ${streamId} revision ${revision} needs fixing...`);
    return new Promise(async (resolve) => {
      try {
        const document: any = await Provider.database.get(streamId);
        // Prevent self harm by malformed id being returned
        document._id = streamId;
        if (document._rev === revision) {
          resolve(false);
        } else {
          Helper.output("Revision not found fixing", document);

          try {
            await this.fixDocument(document, streamId, revision, false);
            Helper.output("Document fixed");
            resolve(true);
          } catch (error) {
            resolve(false);
          }
        }
      } catch (error) {
        Helper.output("Error getting document found fixing");

        try {
          this.fixDocument({ _id: streamId }, streamId, revision, false);
          Helper.output("Document fixed");
          resolve(true);
        } catch (error) {
          resolve(false);
        }
      }
    });
  }

  /**
   * Pass the data through to rebuildData
   *
   * @private
   * @param {*} document
   * @param {string} streamId
   * @param {string} revision
   * @param {boolean} volatile
   * @returns {Promise<boolean>}
   */
  private fixDocument(
    document: any,
    streamId: string,
    revision: string,
    volatile: boolean
  ): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      Helper.output("Fixing document");
      await this.rebuildData(document, streamId, revision, volatile);

      resolve();
    });
  }

  /**
   * Using data from the network rebuild the broken stream
   *
   * @private
   * @param {IChangeDocument} document
   * @param {string} $stream
   * @param {string} $rev
   * @param {boolean} volatile
   * @returns {Promise<any>}
   */
  private rebuildData(
    document: IChangeDocument,
    $stream: string,
    $rev: string,
    volatile: boolean
  ): Promise<boolean> {
    return new Promise<boolean>(async (resolve) => {
      Helper.output(
        "Fetching neighbourhood stream data, beginning door duty..."
      );
      try {
        const streams: any = await Provider.network.neighbourhood.knockAll(
          "stream",
          { $stream, $rev },
          true
        );
        Helper.output("Received the following data: ", streams);

        const promises: Promise<boolean>[] = [];
        const docProcessed: string[] = [];

        for (let i = streams.length; i--;) {
          const stream = streams[i];
          if (stream && !stream.error) {
            if (this.isDocMissing(document)) {
              document._id = document.docId;
            }
            Helper.output(
              "Checking stream correct: " +
              this.isStreamDefinedAndNotEmptyArray(stream),
              stream ? stream : "No stream data"
            );
            if (this.isStreamDefinedAndNotEmptyArray(stream)) {
              // We Only need to run this once, All returns "should" be the same
              // however they may not be so hashing each one and updating only once
              // of course the one we update maybe wrong but then it will just error again and
              // the whole procress starts of again.
              const docContent = ActiveCrypto.Hash.getHash(
                JSON.stringify(stream)
              );

              if (docProcessed.indexOf(docContent) === -1) {
                docProcessed.push(docContent);
                if (Provider.isSelfhost) {
                  Helper.output("Self host enabled, rebuilding self.");
                  promises.push(this.rebuildSelf(document, stream));
                } else {
                  Helper.output("Rebuilding remote.");
                  promises.push(this.rebuildRemote(document, stream, volatile));
                }
              }
            }
          } else {
            Helper.output("Stream contains an error...", stream);
          }
        }

        // Wait for all the promises to finish
        await Promise.all(promises);
        Helper.output("Rebuild complete");
        resolve(true);
      } catch (error) {
        ActiveLogger.error(error, "Error Message");
        ActiveLogger.warn(document, "Document");
        resolve(false);
      }
    });
  }

  /**
   * Rebuild data on a node that is not running locally to this restore instance
   *
   * @private
   * @param {*} document
   * @param {*} stream
   * @param {boolean} volatile
   * @returns {Promise<any>}
   */
  private rebuildRemote(
    document: any,
    stream: any,
    volatile: boolean
  ): Promise<any> {
    // With purge support in couchdb 2.3 should be able to follow same pattern
    return this.rebuildSelf(document, stream);
  }

  /**
   * Rebuild data on node running locally to this instance
   *
   * @private
   * @param {*} document
   * @param {*} stream
   * @returns {Promise<boolean>}
   */
  private rebuildSelf(document: any, stream: any): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Beginning data rebuild process on self");

      try {
        await Provider.database.purge(document);

        await Provider.database.bulkDocs([stream], { new_edits: false });
        Helper.output("Finished self data rebuild");
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Get and process stream data from the network
   *
   * @private
   * @param {string[]} $streams
   * @returns {Promise<any>}
   */
  private getNetworkStreamData($streams: string[]): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        const streamData: any = await Provider.network.neighbourhood.knockAll(
          "stream",
          { $streams },
          true
        );

        let reduction = {};

        for (let i = streamData.length; i--;) {
          const streams = streamData[i];
          if (!streams.error) {
            reduction = this.reduceStreamData(streams, reduction);
          }
        }

        Helper.output("Reduction complete", reduction);

        resolve(reduction);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Reduce the streams provided
   *
   * @private
   * @param {*} streams
   * @param {*} reduction
   * @returns {*}
   */
  private reduceStreamData(streams: any, reduction: any): any {
    Helper.output("Current reduction:", reduction);
    Helper.output("Reducing: ", streams);
    for (let i = streams.length; i--;) {
      const stream = streams[i];

      if (!reduction) {
        reduction = {};
      }

      // Is the stream ID already there
      if (!reduction[stream._id]) {
        reduction[stream._id] = {};
      }

      // Is the revision already there
      if (!reduction[stream._id][stream._rev]) {
        reduction[stream._id][stream._rev] = 0;
      }

      reduction[stream._id][stream._rev]++;
    }

    return reduction;
  }

  /**
   * Set the processed flag in a document to true
   *
   * @private
   * @param {IChangeDocument} document
   * @returns {Promise<void>}
   */
  private setProcessed(document: IChangeDocument): Promise<void> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Setting document processed flag to true");
      document.processed = true;
      document.processedAt = new Date();

      try {
        // Move to archive
        await this.archive(document);

        Helper.output("Document updated");
        resolve();
      } catch (error) {
        Helper.output("Error updating document");

        // There may be conflicts as there are multiple streams per transaction, so multiple may have the haveProcessed flag
        // In the future this will be handled differently, but for now just resolve
        reject(error);
      }
    });
  }

  /**
   * Move document to archives
   *
   * @private
   * @param {IChangeDocument} document
   * @returns {Promise<void>}
   */
  private async archive(document: IChangeDocument): Promise<void> {
    await Provider.errorDatabase.purge(document);

    // Sometimes there is similair auto id with revision collisions
    // Instead of rewrite revision (as this data is not important) we will create a new
    // timestamped document everytime so we can track all errors which have processed.
    document._id = document._id + ":" + Date.now();
    await Provider.errorArchive.put(document);
  }
}
