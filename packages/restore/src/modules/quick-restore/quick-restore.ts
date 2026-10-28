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
  IRestoreStream,
  IKnockData,
  IConsensusData,
  IBaseData,
  INeighbourhood
} from "../../interfaces/quick-restore.interface";
import { Helper } from "../helper/helper";
import { Contract } from "../contract/contract";
import { Throttle } from "../helper/throttle";
import { SyncContext, walkUmidHistory } from "@activeledger/activesync";
import { ActiveOptions } from "@activeledger/activeoptions";

/** How many times a stream is asked for before it is reported as not restored */
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_MS = 500;
/** How often, in streams, progress is logged */
const PROGRESS_EVERY = 500;
/** The history pass goes the whole way back, and a pause between network hops keeps it gentle */
const HISTORY_WALK_LIMIT = 1000000;
const HISTORY_HOP_DELAY_MS = 50;

/**
 * Perform a full restore on a nodes database
 *
 * @export
 * @class QuickRestore
 */
export class QuickRestore {
  /**
   * Creates an instance of QuickRestore.
   */
  constructor() {
    this.runQuickFullRestore();
  }

  /**
   * Check that a node is not this one
   *
   * @private
   */
  private isNotThisNode = (node: string) =>
    node !== ActiveNetwork.Home.reference;

  /**
   * Run the restoration process
   *
   * @private
   * @returns {Promise<void>}
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
      const streamInformation: IStreamInformation[] = await this.processRebuildPromises(
        promises
      );
      const needed = Helper.votesNeeded();
      if (!Number.isFinite(needed)) {
        // Nothing can be a majority without it, so say why nothing happens
        ActiveLogger.error(
          "consensus.reached is not set in the config file, so no revision can be a majority and nothing will be restored"
        );
      }
      const consensusData: IConsensusData[] = Helper.majority(
        streamInformation,
        needed
      );
      const skipHistory = ActiveOptions.get<boolean>("skip-history", false);
      const historyOnly = ActiveOptions.get<boolean>("history-only", false);
      if (skipHistory && historyOnly) {
        ActiveLogger.error(
          "--skip-history and --history-only together leave nothing to do"
        );
        return;
      }
      // The state is what the node needs to run, so it comes first. History
      // is a separate run for when the node is back and there is time.
      if (!historyOnly) await this.fetchDocuments(consensusData);
      const duration = Date.now() - startTime;
      ActiveLogger.info(
        historyOnly
          ? "Rebuild skipped (--history-only)"
          : `Rebuild Complete; Duration: ${duration}ms`
      );
      await this.restoreHistory(consensusData);
    } catch (error) {
      ActiveLogger.error(
        error,
        `There was an error running quick full restore: ${
          (error as Error)?.message ?? JSON.stringify(error)
        }`
      );
    }
  }

  /**
   * The last and lowest priority pass: every stream's chain of umids.
   *
   * The node is fully usable before this runs, nothing in operation needs the
   * history. The listing already brought across every umid document a
   * majority holds; this finds the ones it could not, walking each stream's
   * chain back from the umid its meta names and fetching any that is missing
   * from the neighbours' best-supported answer. A chain stops where a umid
   * has no `prev` (older transactions), which is the start as far as the
   * ledger can tell.
   *
   * Throttled like the rest, and safe to stop: a rerun reads what it holds
   * and fetches only what is still missing. `restore.history: false` or
   * `--skip-history` leaves it out.
   *
   * @private
   * @param {IConsensusData[]} consensusData
   * @returns {Promise<void>}
   */
  private async restoreHistory(consensusData: IConsensusData[]): Promise<void> {
    const section = ActiveOptions.get<any>("restore", {});
    if (
      section?.history === false ||
      ActiveOptions.get<boolean>("skip-history", false)
    ) {
      ActiveLogger.info("History pass skipped");
      return;
    }
    const given = section?.history && typeof section.history === "object" ? section.history : {};
    const ctx: SyncContext = {
      store: Provider.database,
      events: Provider.eventDatabase,
      peers: {
        umid: (umid: string) =>
          Provider.network.neighbourhood.knockAll(`umid/${umid}`, null, true),
      },
      walkLimit: Number.isFinite(given.walkLimit) ? given.walkLimit : HISTORY_WALK_LIMIT,
      hopDelayMs: Number.isFinite(given.hopDelayMs) ? given.hopDelayMs : HISTORY_HOP_DELAY_MS,
      continuePastHeld: true,
      minAgree: Number.isFinite(given.minAgree) ? given.minAgree : 1,
    };
    const throttle = Throttle.fromConfig(
      section,
      ActiveOptions.get<boolean>("fast", false)
    );

    const streams = consensusData.filter(
      (c) => QuickRestore.isStateDocument(c.stream) && c.stream.indexOf(":") === -1
    );
    ActiveLogger.info(`History pass: ${streams.length} stream(s)`);
    const started = Date.now();
    let recovered = 0;
    const incomplete: string[] = [];

    for (let i = 0; i < streams.length; i++) {
      const id = streams[i].stream;
      if (i && i % PROGRESS_EVERY === 0) {
        ActiveLogger.info(`History progress: ${i}/${streams.length} (${recovered} umid(s) recovered)`);
      }
      let umid: string | undefined;
      try {
        umid = (await Provider.database.get(`${id}:stream`))?.umid;
      } catch {
        continue;
      }
      if (!umid) continue;

      const fetchStarted = Date.now();
      try {
        const walk = await walkUmidHistory(ctx, id, umid);
        recovered += walk.recovered.length;
        if (!walk.complete) incomplete.push(`${id} (${walk.stoppedAt})`);
        // Only a walk that went to the network is worth pausing for
        if (walk.recovered.length) {
          await throttle.wait();
          throttle.record(Date.now() - fetchStarted);
        }
      } catch (error) {
        incomplete.push(`${id} (${(error as Error)?.message ?? "failed"})`);
      }
    }

    ActiveLogger.info(
      `History Complete; Duration: ${Date.now() - started}ms; ${recovered} umid(s) recovered`
    );
    if (incomplete.length) {
      ActiveLogger.warn(
        `${incomplete.length} stream(s) have a chain that could not be completed, e.g. ${incomplete.slice(0, 3).join("; ")}`
      );
    }
  }

  /**
   * Fetch data from around the network
   *
   * @private
   * @param {*} consensusData
   * @returns {Promise<void>}
   */
  private fetchDocuments(consensusData: IConsensusData[]): Promise<void> {
    const streamData = (data: IConsensusData) =>
      Provider.network.neighbourhood.knockAll(
        "stream",
        { $stream: data.stream, $rev: data.revision },
        true
      );

    return new Promise(async (resolve, reject) => {
      try {
        Helper.output("Fetch documents: Conesensus data", consensusData);
        const contracts: unknown[] = [];
        const unrestored: string[] = [];
        const throttle = Throttle.fromConfig(
          ActiveOptions.get<any>("restore", {}),
          ActiveOptions.get<boolean>("fast", false)
        );
        let held = 0;
        let fetched = 0;

        for (let i = consensusData.length; i--; ) {
          const activity = consensusData[i];
          const done = consensusData.length - i;
          if (done % PROGRESS_EVERY === 0) {
            ActiveLogger.info(
              `Restore progress: ${done}/${consensusData.length} (${fetched} fetched, ${held} already held)`
            );
          }

          // Already here at the revision the network agreed on: nothing to
          // fetch. A contract stream still has its files rebuilt, from the
          // copy this node holds.
          const local = await Provider.database.get(activity.stream).catch(() => null);
          if (local && local._rev === activity.revision) {
            held++;
            if (
              typeof local._id === "string" &&
              QuickRestore.isStateDocument(local._id) &&
              local.namespace &&
              local.contract &&
              local.compiled
            ) {
              contracts.push(local);
            }
            continue;
          }

          await throttle.wait();
          const fetchStarted = Date.now();
          ActiveLogger.info(`[Fetching] ${activity.stream}`);
          // Under load a neighbour can fail to answer, and every answer
          // being unusable used to skip the stream without a word. Ask
          // again, and say so when it still cannot be had.
          let networkData: INetworkData = { documents: [] };
          for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
            const answers = await streamData(activity).catch(() => []);
            networkData = await this.handleNetworkData(answers);
            if (networkData.documents.length) break;
            if (attempt < FETCH_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, FETCH_RETRY_MS * attempt));
            }
          }
          if (!networkData.documents.length) {
            unrestored.push(activity.stream);
            ActiveLogger.error(
              `[Not restored] ${activity.stream} at ${activity.revision}: no neighbour supplied it after ${FETCH_ATTEMPTS} attempts`
            );
            continue;
          }
          ActiveLogger.info(`[Fetching Complete] ${activity.stream}`);
          await this.uploadData(networkData);
          fetched++;
          throttle.record(Date.now() - fetchStarted);
          contracts.push(...(networkData.contracts || []));
        }

        // A contract's source lives in the umid of the transaction that
        // deployed it, which is a document of its own. Rebuilding as each
        // stream arrived worked only when that umid happened to be restored
        // first, so on an empty database it depended on the order of the
        // streams. Every document is written by now.
        for (const contract of contracts) {
          await Contract.rebuild(contract);
        }

        ActiveLogger.info(
          `Restored ${fetched} stream(s); ${held} already held at the network's revision`
        );

        if (unrestored.length) {
          ActiveLogger.error(
            `${unrestored.length} stream(s) could not be restored, run the restore again to retry them`
          );
        }

        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Write one restored document, choosing the write mode from what this
   * node currently holds.
   *
   * - absent locally: new_edits:false, which is the only mode that keeps
   *   the network's revision on a create (new_edits:true would mint a
   *   fresh "1-<md5>" and leave this node claiming position 1 for a
   *   stream the rest of the network has at position 39).
   * - present but on a different revision: new_edits:true + force_rev, the
   *   only combination levelme allows to overwrite a divergent document.
   * - already in agreement: nothing to do.
   *
   * @private
   * @static
   * @param {IBaseData} doc
   * @returns {Promise<void>}
   */
  /** A state document: not a stream meta, umid or design document */
  private static isStateDocument(id: string): boolean {
    return (
      id.indexOf(":stream") === -1 &&
      id.indexOf(":umid") === -1 &&
      id.indexOf("_design") === -1
    );
  }

  private static async adoptDocument(doc: IBaseData): Promise<void> {
    let local: { _rev?: string } | null = null;

    try {
      local = await Provider.database.get(doc._id);
    } catch {
      // A missing document is a normal outcome here, not a failure
      local = null;
    }

    if (!local || !local._rev) {
      await Provider.database.bulkDocs([doc], { new_edits: false });
      return;
    }

    if (local._rev !== doc._rev) {
      ActiveLogger.warn(
        `[Diverged] ${doc._id} local ${local._rev} -> network ${doc._rev}`
      );
      await Provider.database.bulkDocs([doc], {
        new_edits: true,
        force_rev: doc._rev
      });
    }
  }

  /**
   * Upload the data to the database
   *
   * @private
   * @param {INetworkData} networkData
   * @returns {Promise<void>}
   */
  private uploadData(networkData: INetworkData): Promise<void> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Processing Network Data", networkData);

      try {
        // Written one document at a time, and with the write mode chosen
        // per document, because the two cases need different modes and
        // force_rev applies to a whole batch rather than per document.
        //
        // A single bulkDocs(docs, { new_edits: false }) could only ever
        // restore documents this node was MISSING. levelme's
        // prepareForWrite() throws "Revision Mismatch" the moment a
        // new_edits:false write meets a local document whose _rev differs,
        // which aborts the batch - so a node holding a present-but-stale
        // (divergent) copy of a stream was never repaired by a full
        // restore, it just logged the failure and moved on. That is the
        // state a node ends up in when it misses a single committed
        // update, and nothing else in the codebase repairs it either
        // (activerestore's interagent only backfills umid documents).
        for (let i = networkData.documents.length; i--;) {
          const doc = networkData.documents[i] as IBaseData;

          // Every :umid document just restored belongs to a transaction
          // this node never ran itself (that's the whole point of a bulk
          // catch-up), so replay whatever events it raised - same
          // reasoning as interagent.ts's per-error insertUmid().
          //
          // Events first, the umid document last. A restore that is stopped
          // part way skips whatever it already holds when it is run again,
          // so the umid document is what says "done": stopped after it, the
          // events would never be replayed. Replaying twice is harmless,
          // each event keeps its own _id.
          if (doc._id && doc._id.indexOf(":umid") !== -1) {
            await Helper.replayEvents(doc);
          }
          await QuickRestore.adoptDocument(doc);
        }
      } catch (error) {
        ActiveLogger.error(
          "Error occurred in processNetworkData: Uploading documents to database"
        );
        return reject(error);
      }

      resolve();
    });
  }

  /**
   * Process the data, rebuild contracts, add volatiles
   *
   * @private
   * @param {Promise<unknown>[]} promises
   * @returns {Promise<INetworkData>}
   */
  private async handleNetworkData(activityData: any): Promise<INetworkData> {
    // A node that does not hold the stream answers with an empty array (or
    // nothing), which has no document in it to adopt
    const hasNotErrored = (data: IBaseData) =>
      !!data && typeof data._id === "string" && !data.error;

    const isNotStreamOrUmid = (data: IBaseData) =>
      data._id.indexOf(":stream") === -1 &&
      data._id.indexOf(":umid") === -1 &&
      data._id.indexOf("_design") === -1;

    const hasRequiredData = (data: IBaseData) =>
      !!(data.namespace && data.contract && data.compiled);

    const documents: unknown[] = [];
    const contracts: unknown[] = [];

    for (let r = activityData.length; r--; ) {
      const data: IBaseData = activityData[r] as IBaseData;

      if (hasNotErrored(data)) {
        documents.push(data);

        if (isNotStreamOrUmid(data)) {
          hasRequiredData(data)
            ? contracts.push(data)
            : Helper.output("Data does not have required fields", data);
        }
        // Only need to find one non-erroring stream
        break;
      }
    }

    return { documents, contracts };
  }

  /**
   * Process the data rebuild promises and clean the returned data.
   *
   * @private
   * @param {Promise<IStreamInformation>[]} promises
   * @returns {Promise<IStreamInformation[]>}
   */
  private processRebuildPromises(
    promises: Promise<IStreamInformation>[]
  ): Promise<IStreamInformation[]> {
    const streamDataCorrect = (data: IStreamInformation) =>
      !!data;

    return new Promise(async (resolve, reject) => {
      try {
        const streamInformation = await Promise.all(promises);
        const cleanedStreamInformation = streamInformation.filter(
          streamDataCorrect
        );

        Helper.output("cleanedStreamInformation", cleanedStreamInformation);

        Object.keys(cleanedStreamInformation).length > 0
          ? resolve(cleanedStreamInformation)
          : reject("No data to process");
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Get the data needed for the rebuild from the network
   *
   * @private
   * @param {ActiveNetwork.Neighbour} node
   * @returns {(Promise<IStreamInformation>)}
   */
  private getRebuildData(
    node: ActiveNetwork.Neighbour
  ): Promise<IStreamInformation> {
    return new Promise(async (resolve, reject) => {
      let streams: IRestoreStream[] = [];
      let knockResults: IKnockData = {} as IKnockData;

      // We need to loop here to get additional streams (limit of 500 - N)
      try {
        do {
          const start = streams.length ? streams[streams.length - 1].id : "";
          knockResults = await node.knock("all/" + start);
          // push (not [...streams, ...knockResults.data]) - the spread
          // re-copied every already-fetched stream on every page of this
          // loop, an O(n^2) cost across the whole ledger on a full
          // bootstrap restore.
          streams.push(...knockResults.data);
          ActiveLogger.info(
            "[" + node.reference + "]Running Total: " + streams.length
          );
        } while (knockResults.data.length);
      } catch (error) {
        ActiveLogger.error(
          "An error occured in getRebuildData: node.knock('all')"
        );
        reject(error);
      }

      streams.length > 0
        ? resolve({
            reference: node.reference,
            streams
          })
        : reject("No Data");
    });
  }
}
