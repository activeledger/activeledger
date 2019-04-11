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

import { ActiveLogger } from "@activeledger/activelogger";
import { Provider } from "../provider/provider";
import { ActiveNetwork } from "@activeledger/activenetwork";
import {
  IStreamInformation,
  INetworkData,
  IReductionData,
  IRestoreStream,
  IKnockData,
  IConsensusData,
  IBaseData,
  INeighbourhood
} from "../../interfaces/quick-restore.interface";
import { Helper } from "../helper/helper";
import { Contract } from "../contract/contract";

/**
 * Perform a full restore on a nodes database
 *
 * @export
 * @class QuickRestore
 */
export class QuickRestore {
  /**
   * Creates an instance of QuickRestore.
   * @memberof QuickRestore
   */
  constructor() {
    this.runQuickFullRestore();
  }

  /**
   * Check that a node is not this one
   *
   * @private
   * @memberof QuickRestore
   */
  private isNotThisNode = (node: string) =>
    node !== ActiveNetwork.Home.reference;

  /**
   * Run the restoration process
   *
   * @private
   * @returns {Promise<void>}
   * @memberof QuickRestore
   */
  private async runQuickFullRestore(): Promise<void> {
    const preparePromise = (node: string) =>
      this.getRebuildData(neighbourhood[node]);

    const startTime = Date.now();

    ActiveLogger.info("Starting Quick Full Restore");

    const neighbourhood: INeighbourhood = Provider.network.neighbourhood.get();
    const nodes: string[] = Object.keys(neighbourhood);

    const promises: Promise<IStreamInformation>[] = nodes
      .filter(this.isNotThisNode)
      .map(preparePromise);

    try {
      const streamInformation: IReductionData = await this.processRebuildPromises(
        promises
      );
      const consensusData: IConsensusData[] = await this.checkConsensus(
        streamInformation
      );
      await this.fetchDocuments(consensusData);
      const duration = Date.now() - startTime;
      ActiveLogger.info(`Rebuild Complete; Duration: ${duration}ms`);
    } catch (error) {
      ActiveLogger.error(
        error,
        "There was an error running quick full restore"
      );
    }
  }

  /**
   * Fetch data from around the network
   *
   * @private
   * @param {*} consensusData
   * @returns {Promise<void>}
   * @memberof QuickRestore
   */
  private fetchDocuments(consensusData: IConsensusData[]): Promise<void> {
    const preparePromise = (data: IConsensusData) =>
      Provider.network.neighbourhood.knockAll(
        "stream",
        { $stream: data.stream, $rev: data.revision },
        true
      );

    return new Promise(async (resolve, reject) => {
      try {
        Helper.output("Fetch documents: Conesensus data", consensusData);
        const promises: Promise<unknown>[] = consensusData.map(preparePromise);

        const networkData: INetworkData = await this.handleNetworkData(
          promises
        );

        await this.uploadData(networkData);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Upload the data to the database
   *
   * @private
   * @param {INetworkData} networkData
   * @returns {Promise<void>}
   * @memberof QuickRestore
   */
  private uploadData(networkData: INetworkData): Promise<void> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Processing Network Data", networkData);

      try {
        await Provider.database.bulkDocs(networkData.documents, {
          new_edits: false
        });
      } catch (error) {
        ActiveLogger.error(
          "Error occurred in processNetworkData: Uploading documents to database"
        );
        reject(error);
      }

      try {
        await Provider.database.bulkDocs(networkData.volatile, {
          new_edits: true
        });
        resolve();
      } catch (error) {
        ActiveLogger.error(
          "Error occurred in processNetworkData: Uploading volatile to database"
        );
        reject(error);
      }
    });
  }

  /**
   * Process the data, rebuild contracts, add volatiles
   *
   * @private
   * @param {Promise<unknown>[]} promises
   * @returns {Promise<INetworkData>}
   * @memberof QuickRestore
   */
  private handleNetworkData(
    promises: Promise<unknown>[]
  ): Promise<INetworkData> {
    const hasNotErrored = (data: IBaseData) => (data.error ? false : true);

    const isNotStreamOrUmid = (data: IBaseData) =>
      data._id.indexOf(":stream") === -1 &&
      data._id.indexOf(":umid") === -1 &&
      data._id.indexOf("_design") === -1
        ? true
        : false;

    const hasRequiredData = (data: IBaseData) =>
      data.namespace && data.contract && data.compiled ? true : false;

    return new Promise((resolve, reject) => {
      const documents: unknown[] = [];
      const volatile: unknown[] = [];

      Promise.all(promises)
        .then((responses: unknown[]) => {
          for (let i = responses.length; i--; ) {
            const response: unknown[] = responses[i] as unknown[];

            for (let r = response.length; r--; ) {
              const data: IBaseData = response[r] as IBaseData;

              if (hasNotErrored(data)) {
                documents.push(data);

                if (isNotStreamOrUmid(data)) {
                  volatile.push({ _id: `${data._id}:volatile` });

                  hasRequiredData(data)
                    ? Contract.rebuild(data)
                    : Helper.output("Data does not have required fields", data);
                }
                // Only need to find one non-erroring stream
                break;
              }
            }
          }

          resolve({ documents, volatile });
        })
        .catch((error: Error) => {
          reject(error);
        });
    });
  }

  /**
   * Check the consensus data of a stream
   *
   * @private
   * @param {*} streamInformation
   * @returns {Promise<IConsensusData[]>}
   * @memberof QuickRestore
   */
  private checkConsensus(
    streamInformation: IReductionData
  ): Promise<IConsensusData[]> {
    const streamIdCorrect = (streamId: string) =>
      streamId && streamId !== "undefined" ? true : false;

    return new Promise((resolve) => {
      const consensusReached: IConsensusData[] = [];
      const streams = Object.keys(streamInformation);

      for (let i = streams.length; i--; ) {
        const streamId = streams[i];

        if (streamIdCorrect(streamId)) {
          const stream = streamInformation[streamId];
          const revisions = Object.keys(stream);

          for (let i = revisions.length; i--; ) {
            const revision = revisions[i];
            const vote = stream[revision];

            Helper.output("Check Consensus: Adding", {
              stream: streamId,
              revision
            });

            if (Helper.metConsensus(vote)) {
              consensusReached.push({ stream: streamId, revision });
              break;
            }
          }
        }
      }

      resolve(consensusReached);
    });
  }

  /**
   * Process the data rebuild promises, clean the returned data and reduce it.
   *
   * @private
   * @param {Promise<IStreamInformation>[]} promises
   * @returns {Promise<IReductionData>}
   * @memberof QuickRestore
   */
  private processRebuildPromises(
    promises: Promise<IStreamInformation>[]
  ): Promise<IReductionData> {
    const streamDataCorrect = (data: IStreamInformation) =>
      data ? true : false;

    return new Promise((resolve, reject) => {
      Promise.all(promises)
        .then((streamInformation) => {
          const cleanedStreamInformation = streamInformation.filter(
            streamDataCorrect
          );

          Helper.output("cleanedStreamInformation", cleanedStreamInformation);

          Object.keys(cleanedStreamInformation).length > 0
            ? resolve(this.reduceStreamInformation(cleanedStreamInformation))
            : reject("No data to process");
        })
        .catch((error: Error) => {
          reject(error);
        });
    });
  }

  /**
   *  Reduce the given stream information
   *
   * @private
   * @param {IStreamInformation[]} streamInformation
   * @returns {*}
   * @memberof QuickRestore
   */
  private reduceStreamInformation(
    streamInformation: IStreamInformation[]
  ): IReductionData {
    const haveStream = (stream: IRestoreStream) =>
      reduction[stream.id] ? true : false;

    const haveRevision = (stream: IRestoreStream) =>
      reduction[stream.id][stream.rev] ? true : false;

    const incrementStreamRevisionCounter = (stream: IRestoreStream) =>
      reduction[stream.id][stream.rev]++;

    const startStreamRevisionCounter = (stream: IRestoreStream) =>
      (reduction[stream.id][stream.rev] = 1);

    const initialiseStreamCounter = (stream: IRestoreStream) =>
      (reduction[stream.id] = { [stream.rev]: 1 });

    let reduction: IReductionData = {};

    Helper.output("Stream Information", streamInformation);

    for (let i = streamInformation.length; i--; ) {
      if (streamInformation[i] && streamInformation[i].streams) {
        const streams = Object.values(streamInformation[i].streams);
        Helper.output(`Reducing ${streams.length} streams`);

        for (let s = streams.length; s--; ) {
          const stream = streams[s];

          if (stream) {
            Helper.output("Reducing stream", stream);

            haveStream(stream)
              ? haveRevision(stream)
                ? incrementStreamRevisionCounter(stream)
                : startStreamRevisionCounter(stream)
              : initialiseStreamCounter(stream);
          }
        }
      }
    }

    Helper.output("Reduction", reduction);

    return reduction;
  }

  /**
   * Get the data needed for the rebuild from the network
   *
   * @private
   * @param {ActiveNetwork.Neighbour} node
   * @returns {(Promise<IStreamInformation>)}
   * @memberof QuickRestore
   */
  private getRebuildData(
    node: ActiveNetwork.Neighbour
  ): Promise<IStreamInformation> {
    const hasData = (knockData: IKnockData) =>
      knockData.data && knockData.data.length > 0 ? true : false;

    const getId = (knockData: IKnockData) =>
      knockData.data[knockData.data.length - 1]["id"];

    return new Promise(async (resolve, reject) => {
      let streams: IRestoreStream[] = [];
      let knockResults: IKnockData = {} as IKnockData;

      try {
        knockResults = await node.knock("all");
      } catch (error) {
        ActiveLogger.error(
          "An error occured in getRebuildData: node.knock('all')"
        );
        reject(error);
      }

      try {
        if (hasData(knockResults)) {
          const knockResult: IKnockData = await node.knock(
            `all/${getId(knockResults)}`
          );
          streams = knockResult.data;
        }
      } catch (error) {
        ActiveLogger.error(
          `An error occured in getRebuildData: node.knock("all/${getId(
            knockResults
          )}")`
        );
        reject(error);
      }

      streams.length > 0
        ? resolve({
            reference: node.reference,
            streams
          })
        : resolve(undefined);
    });
  }
}
