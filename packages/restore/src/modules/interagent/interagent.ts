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

import { Provider } from "../provider/provider";
import { Helper } from "../helper/helper";
import {
  IChangeDocument,
  IResponse,
} from "../../interfaces/document.interfaces";
import { ActiveLogger } from "@activeledger/activelogger";
import { ErrorCodes } from "./error-codes.enum";
import { ActiveCrypto } from "@activeledger/activecrypto";

const REMOVE_CACHE_TIMER = 5 * 60 * 1000;

/**
 * Interagent that listens for error events and attempts to fix them
 *
 * @export
 * @class Interagent
 */
export class Interagent {
  private errorCodes = [
    ErrorCodes.StreamNotFound,
    //ErrorCodes.StateNotFound,
    //ErrorCodes.VoteFailedNetworkOk,
    //ErrorCodes.InternalBusyLocked,
    //ErrorCodes.StreamPositionIncorrect,// never came
    //ErrorCodes.ReadOnlyStreamNotFound,
    //ErrorCodes.NodeFinalReject, // They voted no as their data was different?
    //ErrorCodes.FailedToSave, // We do position incorrect fix real time
    //ErrorCodes.Unknown,
    //ErrorCodes.FailedToGetResponse,
  ];

  private skippedErrorInterval: Function;

  /**
   * Sometimes multiple entries occur, This will filter them out
   *
   * @private
   * @type {{
   *     [index:string]: Date;
   *   }}
   */
  // private processedUmid: {
  //   [index: string]: Date;
  // } = {};

  /**
   * Creates an instance of Interagent.
   */
  constructor() {
    // Routine check for any documents missed due to restarts
    this.skippedErrorInterval = async () => {
      try {
        await this.skippedChecker();
      } catch (error) {
        ActiveLogger.error(error, "Skipped Error Checker");
      } finally {
        setTimeout(() => {
          this.skippedErrorInterval();
        }, 5000);
      }
    }; //300000

    ActiveLogger.info("Interagent Started");
    // Start up delay
    setTimeout(() => {
      ActiveLogger.info("Interagent Starting Error Checker");
      this.skippedErrorInterval();
      //this.timerUnCache();
    }, 5000);
  }

  /**
   * Clears Cache
   *
   * @private
   */
  // private timerUnCache() {
  //   setTimeout(() => {
  //     const umids = Object.keys(this.processedUmid);
  //     const nowMinus = new Date(Date.now() - REMOVE_CACHE_TIMER);
  //     for (let i = umids.length; i--; ) {
  //       if (this.processedUmid[umids[i]] < nowMinus) {
  //         // 30 seconds has passed without accessing it so lets clear
  //         delete this.processedUmid[umids[i]];
  //       }
  //     }
  //     this.timerUnCache();
  //   }, REMOVE_CACHE_TIMER);
  // }

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

    if (docs?.rows.length) {
      ActiveLogger.info(`Interagent Checking ${docs.rows.length} Documents`);
      // Provider.errorFeed.pause();
      for (let i = docs.rows.length; i--; ) {
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
   * Does the transaction have an error code
   *
   * @private
   */
  private hasErrorCode = (changeDoc: any) =>
    this.errorCodes.indexOf(changeDoc.code) !== -1;

  /**
   * Handle a document not having the processed flag
   *
   * @private
   */
  private async processDocument(changeDoc: any): Promise<void> {
    // Check the error codes
    if (
      this.hasErrorCode(changeDoc) // &&
      //!this.processedUmid[changeDoc.umid]
      //changeDoc.reason.indexOf("Stream Position") === -1
    ) {
      ActiveLogger.info(
        `Processing Error Document ${changeDoc._id} with umid ${changeDoc.umid}`
      );
      // Make sure we don't have it

      if (await this.verifyUmidNotFound(changeDoc.umid)) {
        ActiveLogger.info(`UMID ${changeDoc.umid} not found lets fetch it`);

        // Only want to create umids here
        const responses: IResponse[] =
          await Provider.network.neighbourhood.knockAll(
            `umid/${changeDoc.umid}`,
            null,
            true
          );

        // We need to group the umids and pick the most correct one
        const umids: any = {};

        for (let i = responses.length; i--; ) {
          const response = responses[i] as any;
          if (response.umid?.$umid) {
            const hash = ActiveCrypto.Hash.getHash(JSON.stringify(response));
            if (!umids[hash]) {
              umids[hash] = {
                count: 0,
                doc: response,
              };
            } else {
              umids[hash].count++;
            }
          }
        }

        // order umids and select top
        const versions = Object.keys(umids);
        if (versions.length) {
          const umidKeys = versions.sort(
            (a, b) => umids[b].count - umids[a].count
          );
          const umidDoc = umids[umidKeys[0]].doc;

          if (umidDoc.umid?.$umid) {
            await this.insertUmid(umidDoc);
            return await this.setProcessed(changeDoc, true);
          } else {
            ActiveLogger.error(`UMID ${changeDoc.umid} not found`);
            return await this.setProcessed(changeDoc, false);
          }
        } else {
          ActiveLogger.error(`UMID ${changeDoc.umid} not found #2`);
          return await this.setProcessed(changeDoc, false);
        }
        //}
      } else {
        ActiveLogger.info(`UMID ${changeDoc.umid} already exists`);
      }
    }
    return await this.setProcessed(changeDoc, false);
  }

  /**
   * Verify UMID exists
   *
   * @private
   * @param {*} umidDoc
   */
  private async verifyUmidNotFound(umid: any): Promise<boolean> {
    //umidDoc.umid?.$umid
    // if (umidDoc.umid?.$umid) {
    if (await Provider.database.exists(umid + ":umid")) {
      // Sometimes exists returns true so lets fetch as a backup
      try {
        await Provider.database.get(umid + ":umid");
        return false;
      } catch {
        return true;
      }
    } else {
      return true;
    }
    //}
    //return false;
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
        // This method will have the umid "out of order" however a parser will not miss it
        const _id = `umid:${new Date().getTime()},${umidDoc.umid.$umid}`;

        try {
          // Create event id for umid
          // This one will match all nodes so it could be "missed" by a parser
          //const _id = `umid:${new Date(umidDoc.umid.$datetime).getTime()},${umidDoc.umid.$umid}`

          // Save umids to database
          await Provider.database.bulkDocs([umidDoc], { new_edits: false });
          await Provider.eventDatabase.post({
            _id,
          }),
            ActiveLogger.info(`UMID Added ${_id}`);

          // This node never ran this transaction's own commit() itself
          // (that's why it needed restoring), so its own events database
          // would otherwise never see whatever this transaction's
          // contract raised - replay them now they're here.
          await Helper.replayEvents(umidDoc);

          resolve();
        } catch (error) {
          ActiveLogger.info(
            error || umidDoc,
            `Adding UMID failed ${_id} / ${umidDoc._id}`
          );
          reject(error);
        }
      } else {
        resolve();
      }
    });
  }

  /**
   * Set the processed flag in a document to true
   *
   * @private
   * @param {IChangeDocument} document
   * @returns {Promise<void>}
   */
  private setProcessed(
    document: IChangeDocument,
    storeArchive: boolean = false
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      ActiveLogger.info(`Setting Document Processed ${document._id}`);
      document.processed = true;
      document.processedAt = new Date();

      try {
        // Move to archive
        await this.archive(document, storeArchive);
        resolve();
      } catch (error) {
        ActiveLogger.error(error, `Error Archiving Document ${document._id}`);
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
  private async archive(
    document: IChangeDocument,
    storeArchive?: boolean
  ): Promise<void> {
    await Provider.errorDatabase.purge(document);
    ActiveLogger.info(`Document Removed ${document._id}`);

    // Store only data changing in archive
    if (storeArchive) {
      // Sometimes there is similair auto id with revision collisions
      // Instead of rewrite revision (as this data is not important) we will create a new
      // timestamped document everytime so we can track all errors which have processed.
      //document._id = document._id + ":" + Date.now();
      //document._id = Date.now() + ":" + document._id;
      await Provider.errorArchive.purge(document);
      await Provider.errorArchive.put(document);
      ActiveLogger.info(`Document Archived ${document._id}`);
    }
  }
}
