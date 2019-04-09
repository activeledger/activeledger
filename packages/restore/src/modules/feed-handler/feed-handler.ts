import { Helper } from "../helper/helper";
import { Provider } from "../provider/provider";
import {
  IChange,
  IChangeDocument,
  IResponse
} from "../../interfaces/document.interfaces";
import { ActiveLogger } from "@activeledger/activelogger";
import { Sledgehammer } from "../sledgehammer/sledgehammer";
import { Contract } from "../contract/contract";
import { ErrorCodes } from "./error-codes.enum";

export class FeedHandler {
  private errorCodes = [
    ErrorCodes.StreamNotFound,
    ErrorCodes.StateNotFound,
    ErrorCodes.StreamPositionIncorrect,
    ErrorCodes.ReadOnlyStreamNotFound,
    ErrorCodes.FailedToSave,
    ErrorCodes.Unknown,
    ErrorCodes.FailedToGetResponse
  ];

  private attemptUmidDoc = false;

  private umidDoc: any;

  constructor() {
    this.listener();
  }

  private listener(): void {
    Provider.errorFeed.on("change", (change: IChange) => {
      Helper.output("Change event received, pausing error feed.");
      // Pause error feed to process
      Provider.errorFeed.pause();

      const changeDoc = change.doc;

      Helper.output("Checking if document already processed.");

      // Has the document been processed?
      if (!changeDoc.processed) this.processDocument(changeDoc);

      Provider.errorFeed.resume();
      Helper.output("Restoration complete.");
    });
  }

  // #region Micro functions

  /**
   * Check if a transaction has votes
   *
   * @private
   * @memberof FeedHandler
   */
  private hasVote = (data: any) => (data.vote ? true : false);

  /**
   * Handle consensus not being met
   *
   * @private
   * @memberof FeedHandler
   */
  private handleConsensusNotMet(changeDoc: any): Promise<void> {
    Helper.output("Conensus not met.");
    return changeDoc.code === ErrorCodes.StreamPositionIncorrect // 1200
      ? this.dataIntegrityCheck(changeDoc)
      : this.setProcessed(changeDoc);
  }

  /**
   * Does the transaction have an error code
   *
   * @private
   * @memberof FeedHandler
   */
  private hasErrorCode = (changeDoc: any) =>
    this.errorCodes.indexOf(changeDoc.code) !== -1 ? true : false;

  /**
   * Check that a transaction is compatible
   *
   * @private
   * @memberof FeedHandler
   */
  private isCompatibleTransaction = (changeDoc: any) =>
    changeDoc.code !== ErrorCodes.FailedToSave && // 1510
    changeDoc.code !== ErrorCodes.VoteFailed && // 1000
    !changeDoc.transaction.$broadcast
      ? true
      : false;

  /**
   * Check if revision already stored
   *
   * @private
   * @memberof FeedHandler
   */
  private revisionAlreadyStored = (revisions: any, revision: any) =>
    revisions[revision] ? true : false;

  /**
   * Check if the response has an error
   *
   * @private
   * @memberof FeedHandler
   */
  private responseHasError = (data: any) => (data.error ? true : false);

  /**
   * Create a cache of streams
   *
   * @private
   * @memberof FeedHandler
   */
  private createStreamCache = (data: any) => {
    this.umidDoc = data;
    let concatArray;

    data.streams
      ? (concatArray = [...data.streams.new, ...data.streams.updated])
      : (concatArray = []);

    return concatArray;
  };

  /**
   * Create a fix stream promise element
   *
   * @private
   * @memberof FeedHandler
   */
  private handleStreamFixPromise = (streamIndex: any, revisionIndex: any) => {
    ActiveLogger.info(`WW🐔D - ${streamIndex}@${revisionIndex}`);
    return this.fixStream(streamIndex, revisionIndex);
  };

  /**
   * Check if stream data is volatile
   *
   * @private
   * @memberof FeedHandler
   */
  private isVolatileStreamData = (volatile: boolean, data: any) =>
    volatile && data._id.indexOf(":stream") > -1 ? true : false;

  /**
   * Check if stream contains required data
   *
   * @private
   * @memberof FeedHandler
   */
  private isRequiredStreamData = (stream: any) =>
    stream.namespace && stream.contract && stream.compiled ? true : false;

  /**
   * Check if document is missing
   *
   * @private
   * @memberof FeedHandler
   */
  private isDocMissing = (document: any) =>
    document.error &&
    document.status &&
    document.message &&
    document.docId &&
    document.status === 404 &&
    document.message === "missing"
      ? true
      : false;

  /**
   * Check if the stream data is in a correct format
   *
   * @private
   * @memberof FeedHandler
   */
  private isStreamDefinedAndNotEmptyArray = (stream: any) =>
    stream && !Array.isArray(stream) ? true : false;
  // #endregion

  /**
   * Handle a document not having the processed flag
   *
   * @private
   * @memberof FeedHandler
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
   * @memberof FeedHandler
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
   * @memberof FeedHandler
   */
  private async dataIntegrityCheck(document: IChangeDocument): Promise<void> {
    ActiveLogger.info("Data Check - Blocking Network");

    // Delay to allow network to finish processing
    setTimeout(async () => {
      ActiveLogger.info("Data Check - Resuming");

      try {
        //  Get the revisions
        Helper.output("Getting revisions");
        const revs = await this.getRevisions(document);

        // Output possible stream changes
        ActiveLogger.info(revs, "$stream revisions");

        Helper.output("Getting network stream data");
        const reducedStreamData = await this.getNetworkStreamData(revs);

        Helper.output("Checking for consensus");
        await this.consensusCheck(reducedStreamData, document);
      } catch (error) {
        Promise.reject(error);
      } finally {
        Promise.resolve();
      }
    }, 500);
  }

  /**
   * Get the documents revisions
   *
   * @private
   * @param {IChangeDocument} document
   * @returns {Promise<string[]>}
   * @memberof FeedHandler
   */
  private getRevisions(document: IChangeDocument): Promise<string[]> {
    return new Promise((resolve, reject) => {
      Helper.output("Getting revisions");
      const transaction = document.transaction;

      const revisions: string[] = [
        ...(Object.keys(transaction.$revs.$i || {}) as string[]),
        ...(Object.keys(transaction.$revs.$o || {}) as string[]),
        ...(Object.values(transaction.$tx.$r || {}) as string[])
      ];

      Helper.output(`Getting data from network. Using UMID:`, document.umid);
      Provider.network.neighbourhood
        .knockAll(`umid/${document.umid}`, null, true)
        .then((responses: IResponse[]) => {
          let streamCache: any[] = [];

          Helper.output("Network data", responses);

          // Merge streams from responses
          for (let i = responses.length; i--; ) {
            const response = responses[i];

            this.responseHasError(response)
              ? streamCache.push(...this.createStreamCache(response))
              : !this.attemptUmidDoc
              ? // The error could be on this node
                // Attempt to try and add the UMID
                (this.attemptUmidDoc = true)
              : reject("Unable to retrieve necessary data");
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

  /**
   * Check the gathered data for consensus
   *
   * @private
   * @param {*} reducedStreamData
   * @param {IChangeDocument} document
   * @returns {Promise<any>}
   * @memberof FeedHandler
   */
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

          Helper.metConsensus(revisionCount, true)
            ? promiseHolder.push(
                this.handleStreamFixPromise(streamIndex, revisionIndex)
              )
            : promiseHolder.push(true);
        }
      }

      Promise.all(promiseHolder)
        .then((results: unknown[]) => {
          this.setProcessed(document);

          if (results.some((e: boolean) => e)) {
            Helper.output("Fetching hammer");
            this.hammerTime();
          } else {
            ActiveLogger.warn("Data Check - False Positive");

            if (this.attemptUmidDoc) {
              this.insertUmid(this.umidDoc);
            }
          }
          resolve();
        })
        .catch((error: Error) => {
          ActiveLogger.error(error, "All Datafix processes errored");
          reject(error);
        });
    });
  }

  /**
   * Hammer the data into submission
   *
   * @private
   * @returns {Promise<any>}
   * @memberof FeedHandler
   */
  private hammerTime(): Promise<any> {
    return new Promise((resolve, reject) => {
      Sledgehammer.smash()
        .then(() => {
          ActiveLogger.info("Smashing complete");

          if (this.attemptUmidDoc) {
            this.insertUmid(this.umidDoc);
          }

          resolve();
        })
        .catch((error: Error) => {
          ActiveLogger.error(error, "Hammer broke");
          reject(error);
        });
    });
  }

  /**
   * Insert the UMID into the database
   *
   * @private
   * @param {*} umidDoc
   * @memberof FeedHandler
   */
  private insertUmid(umidDoc: any): void {
    if (umidDoc) {
      Provider.database
        .bulkDocs([umidDoc], { new_edits: false })
        .then(() => {
          ActiveLogger.info("UMID Added");
        })
        .catch((error: Error) => {
          ActiveLogger.info(error || umidDoc, "Adding UMID failed");
        });
    }
  }

  /**
   * Using the provided data, initialise fixing the stream
   *
   * @private
   * @param {*} streamId
   * @param {*} revision
   * @returns {Promise<boolean>}
   * @memberof FeedHandler
   */
  private fixStream(streamId: any, revision: any): Promise<boolean> {
    Helper.output(`Stream ${streamId} revision ${revision} needs fixing...`);
    return new Promise((resolve, reject) => {
      Provider.database
        .get(streamId)
        .then((document: any) => {
          if (document._rev === revision) {
            resolve(false);
          } else {
            Helper.output("Revision not found fixing", document);
            this.fixDocument(document, streamId, revision, false)
              .then(() => {
                Helper.output("Document fixed");
                resolve(true);
              })
              .catch(() => {
                resolve(false);
              });
          }
        })
        .catch((err: unknown) => {
          Helper.output("Error getting document found fixing");
          this.fixDocument({ _id: streamId }, streamId, revision, false)
            .then(() => {
              Helper.output("Document fixed");
              resolve(true);
            })
            .catch(() => {
              resolve(false);
            });
        });
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
   * @memberof FeedHandler
   */
  private fixDocument(
    document: any,
    streamId: string,
    revision: string,
    volatile: boolean
  ): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
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
   * @memberof FeedHandler
   */
  private rebuildData(
    document: IChangeDocument,
    $stream: string,
    $rev: string,
    volatile: boolean
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      Helper.output(
        "Fetching neighbourhood stream data, beginning door duty..."
      );
      Provider.network.neighbourhood
        .knockAll("stream", { $stream, $rev }, true)
        .then((streams: any) => {
          Helper.output("Received the following data: ", streams);

          const promises: Promise<boolean>[] = [];

          for (let i = streams.length; i--; ) {
            const stream = streams[i];
            if (!stream.error) {
              if (this.isDocMissing(document)) {
                document._id = document.docId;
              }

              Helper.output(
                "Checking stream correct: " +
                  this.isStreamDefinedAndNotEmptyArray(stream),
                stream ? stream : "No stream data"
              );
              if (this.isStreamDefinedAndNotEmptyArray(stream)) {
                if (Provider.isSelfhost) {
                  Helper.output("Self host enabled, rebuilding self.");
                  promises.push(this.rebuildSelf(document, stream));
                } else {
                  Helper.output("Rebuilding remote.");
                  promises.push(this.rebuildRemote(document, stream, volatile));
                }
              }
            } else {
              Helper.output("Stream contains an error...", stream);
            }
          }

          return Promise.all(promises);
        })
        .then(() => {
          Helper.output("Rebuild complete");
          resolve();
        })
        .catch((error: Error) => {
          ActiveLogger.error(error, "Error Message");
          ActiveLogger.warn(document, "Document");
          resolve(false);
        });
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
   * @memberof FeedHandler
   */
  private rebuildRemote(
    document: any,
    stream: any,
    volatile: boolean
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Begginning data remote rebuild process");
      Helper.output("Re-writing stream");
      document.$activeledger = {
        delete: true,
        rewrite: stream
      };

      Helper.output("Attempting to add updated document to database");
      try {
        await Provider.database.put(document);
      } catch (error) {
        reject(error);
      }

      Helper.output("Checking stream data");
      this.isRequiredStreamData(stream)
        ? Contract.rebuild(stream)
        : Helper.output("Stream data does not contain required data");

      Helper.output("Checking for volatile");
      this.isVolatileStreamData(volatile, document)
        ? await Provider.database.put({
            _id: document._id.replace(":stream", ":volatile"),
            _rev: document._rev
          })
        : Helper.output("Data is not volatile");

      resolve(true);
    });
  }

  /**
   * Rebuild data on node running locally to this instance
   *
   * @private
   * @param {*} document
   * @param {*} stream
   * @returns {Promise<boolean>}
   * @memberof FeedHandler
   */
  private rebuildSelf(document: any, stream: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      Helper.output("Beginning data rebuild process on self");
      Provider.database
        .purge(document)
        .then(() => {
          return Provider.database.bulkDocs([stream], { new_edits: false });
        })
        .then(() => {
          Helper.output("Finished self data rebuild");
          resolve(true);
        })
        .catch((error: Error) => {
          reject(error);
        });
    });
  }

  /**
   * Get and process stream data from the network
   *
   * @private
   * @param {string[]} $streams
   * @returns {Promise<any>}
   * @memberof FeedHandler
   */
  private getNetworkStreamData($streams: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      Provider.network.neighbourhood
        .knockAll("stream", { $streams }, true)
        .then((streamData: any) => {
          let reduction = {};

          for (let i = streamData.length; i--; ) {
            const streams = streamData[i];
            if (!streams.error) {
              reduction = this.reduceStreamData(streams, reduction);
            }
          }

          Helper.output("Reduction complete", reduction);

          resolve(reduction);
        })
        .catch((error: Error) => {
          reject(error);
        });
    });
  }

  /**
   * Reduce the streams provided
   *
   * @private
   * @param {*} streams
   * @param {*} reduction
   * @returns {*}
   * @memberof FeedHandler
   */
  private reduceStreamData(streams: any, reduction: any): any {
    Helper.output("Current reduction:", reduction);
    Helper.output("Reducing: ", streams);
    for (let i = streams.length; i--; ) {
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
   * @memberof FeedHandler
   */
  private setProcessed(document: IChangeDocument): Promise<void> {
    return new Promise((resolve, reject) => {
      Helper.output("Setting document processed flag to true");
      document.processed = true;
      document.processedAt = new Date();

      Provider.errorDatabase
        .put(document)
        .then(() => {
          Helper.output("Document updated");
          resolve();
        })
        .catch((error: Error) => {
          Helper.output("Error updating document");

          // There may be conflicts as there are multiple streams per transaction, so multiple may have the haveProcessed flag
          // In the future this will be handled differently, but for now just resolve
          reject(error);
        });
    });
  }
}
