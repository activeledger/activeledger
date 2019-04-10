import { ActiveLogger } from "@activeledger/activelogger";
import { Provider } from "../provider/provider";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { IStreamInformation } from "./quick-restore.interface";
import { Helper } from "../helper/helper";
import { Contract } from "../contract/contract";
import { rejects } from "assert";

export class QuickRestore {
  constructor() {
    this.runQuickFullRestore();
  }

  private isNotThisNode = (node: any) =>
    node.reference !== ActiveNetwork.Home.reference;

  private async runQuickFullRestore(): Promise<void> {
    const preparePromise = (node: any) =>
      this.asyncRecursiveRebuild(neighbourhood[node]);

    ActiveLogger.info("Starting Quick Full Restore");

    const neighbourhood = Provider.network.neighbourhood.get();
    const nodes = Object.keys(neighbourhood);

    const promises: Promise<any>[] = nodes
      .filter(this.isNotThisNode)
      .map(preparePromise);

    try {
      const streamInformation = await this.processPromises(promises);
      const consensusData = await this.checkConsensus(streamInformation);
      await this.fetchDocuments(consensusData);
    } catch (error) {
      ActiveLogger.error(
        "There was an error running quick full restore",
        error
      );
    }
  }

  private fetchDocuments(consensusData: any): Promise<any> {
    const preparePromise = (data: any) =>
      Provider.network.neighbourhood.knockAll(
        "stream",
        { $stream: data.stream, $rev: data.rev },
        true
      );

    return new Promise(async (resolve, reject) => {
      try {
        const promises: Promise<any>[] = consensusData.map(preparePromise);

        const networkData = await this.handleNetworkData(promises);

        await this.processNetworkData(networkData);
      } catch (error) {
        reject(error);
      } finally {
        resolve();
      }
    });
  }

  private processNetworkData(networkData: {
    documents: any;
    volatile: any;
  }): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        await Provider.database.bulkDocs(networkData.documents, {
          new_edits: false
        });
        await Provider.database.bulkDocs(networkData.volatile, {
          new_edits: false
        });
      } catch (error) {
        reject(error);
      } finally {
        resolve();
      }
    });
  }

  private handleNetworkData(
    promises: Promise<any>[]
  ): Promise<{ documents: any; volatile: any }> {
    const hasNotErrored = (data: any) => (data.error ? true : false);

    const isNotStream = (data: any) =>
      data._id.indexOf(":stream") === -1 ? true : false;

    const hasRequiredData = (data: any) =>
      data.namespace && data.contract && data.compiled ? true : false;

    return new Promise((resolve, reject) => {
      const documents: any[] = [];
      const volatile: any[] = [];

      Promise.all(promises)
        .then((responses) => {
          for (let i = responses.length; i--; ) {
            const response = responses[i];

            for (let r = response.length; r--; ) {
              const data = response[r];

              if (hasNotErrored(data)) {
                documents.push(data[r]);

                if (isNotStream(data)) {
                  volatile.push({ _id: `${data._id}: volatile` });

                  if (hasRequiredData) Contract.rebuild(data);
                }
                // Only need to find one non-erroring stream
                break;
              }
            }
          }

          resolve({ documents, volatile });
        })
        .catch((err: unknown) => {
          console.error(err);
        });
    });
  }

  private checkConsensus(streamInformation: any): Promise<any[]> {
    const streamIdCorrect = (streamId: any) =>
      streamId && streamId !== "undefined" ? true : false;

    return new Promise((resolve, reject) => {
      const consensusReached: any[] = [];
      const streams = Object.keys(streamInformation);

      for (let i = streams.length; i--; ) {
        const streamId = streams[i];

        if (streamIdCorrect(streamId)) {
          const stream = streamInformation[streamId];
          const revisions = Object.keys(stream);

          for (let i = revisions.length; i--; ) {
            const revision = revisions[i];
            const vote = stream[revision];

            if (Helper.metConsensus(vote)) {
              consensusReached.push({ stream, revision });
              break;
            }
          }
        }
      }

      resolve(consensusReached);
    });
  }

  private processPromises(promises: Promise<any>[]): Promise<any> {
    const streamDataCorrect = (data: any) =>
      typeof data === "string" ? false : true;

    return new Promise((resolve, reject) => {
      Promise.all(promises)
        .then((streamInformation) => {
          const cleanedStreamInformation = streamInformation.filter(
            streamDataCorrect
          );

          // Helper.output("streamInformation", streamInformation);
          // Helper.output("cleanedStreamInformation", cleanedStreamInformation);

          Object.keys(cleanedStreamInformation).length > 0
            ? resolve(this.reduceStreamInformation(cleanedStreamInformation))
            : reject("No data to process");
        })
        .catch((err: unknown) => {
          reject(err);
        });
    });
  }

  private reduceStreamInformation(
    streamInformation: IStreamInformation[]
  ): any {
    const haveStream = (stream: any) =>
      reduction[stream["id"]] ? true : false;

    const haveRevision = (stream: any) =>
      reduction[stream["id"]][stream.rev] ? true : false;

    const incrementStreamRevisionCounter = (stream: any) =>
      reduction[stream["id"]][stream.rev]++;

    const startStreamRevisionCounter = (stream: any) =>
      (reduction[stream["id"]][stream.rev] = 1);

    const initialiseStreamCounter = (stream: any) =>
      (reduction[stream["id"]] = { [stream.rev]: 1 });

    let reduction: any = {};

    Helper.output("Stream Information", streamInformation);

    for (let i = streamInformation.length; i--; ) {
      if (streamInformation[i] && streamInformation[i].streams) {
        const streams = Object.values(streamInformation[i].streams);
        Helper.output(`Reducing ${streams.length} streams`);

        for (let s = streams.length; s--; ) {
          const stream = streams[s];

          if (stream) {
            // Helper.output("Reduction stream", (streams[s] as any).id);
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

  private asyncRecursiveRebuild(
    node: ActiveNetwork.Neighbour
  ): Promise<IStreamInformation | string> {
    const hasData = (data: any) =>
      data.data && data.data.length > 0 ? true : false;

    const getId = (data: any) => data.data[data.data.length - 1]["id"];

    return new Promise(async (resolve, reject) => {
      let streams: any[] = [];
      const knockResults = await node.knock("all");

      if (hasData(knockResults)) {
        const knockResult = await node.knock(`all/${getId(knockResults)}`);
        streams = knockResult.data;
      }

      streams.length > 0
        ? resolve({
            reference: node.reference,
            streams
          })
        : resolve("No output");
    });
  }
}
