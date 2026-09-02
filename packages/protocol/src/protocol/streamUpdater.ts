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

import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { IReferenceStreams } from "./interfaces/process.interface";
import { Shared } from "./shared";
import { IVirtualMachine } from "./interfaces/vm.interface";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { EventEmitter } from "events";
import { ActiveLogger } from "@activeledger/activelogger";

/**
 * Handles updating the streams
 *
 * @export
 * @class StreamUpdater
 */
export class StreamUpdater {
  /**
   * Holds the docs
   *
   * @private
   * @type {*}
   */
  private docs: any;

  /**
   * Holds the streams being updated
   *
   * @private
   * @type {ActiveDefinitions.LedgerStream[]}
   */
  private streams: ActiveDefinitions.LedgerStream[];

  /**
   * Holds the inputs
   *
   * @private
   * @type {ActiveDefinitions.LedgerStream[]}
   */
  //private inputs: ActiveDefinitions.LedgerStream[];

  /**
   * Should this be skipped
   *
   * @private
   * @type {string[]}
   */
  //private skip: string[];

  /**
   * Holds collisions
   *
   * @private
   * @type {string[]}
   */
  private collisions: string[];

  /**
   * Non Hardened Key Pair check flag
   *
   * @private
   * @type {boolean}
   */
  //private nhkpCheck: boolean;

  /**
   * Holds reference streams
   *
   * @private
   * @type {IReferenceStreams}
   */
  private refStreams: IReferenceStreams;

  /**
   * Holds the earlyCommit callback function
   *
   * @private
   * @type {Function}
   */
  private earlyCommit: Function;

  constructor(
    private entry: ActiveDefinitions.LedgerEntry,
    private virtualMachine: IVirtualMachine,
    private reference: string,
    private nodeResponse: ActiveDefinitions.INodeResponse,
    private db: ActiveDSConnect,
    private dbev: ActiveDSConnect,
    private emitter: EventEmitter,
    private shared: Shared,
    private contractId: string
  ) {
    // Determanistic Collision Managamenent
    this.collisions = [];

    // Setup refStreams
    this.refStreams = {
      new: [] as any[],
      updated: [] as any[],
    };
    // Get the changed data streams
    this.streams = this.virtualMachine.getActivityStreamsFromVM(
      this.entry.$umid
    );

    // Get current working inputs to compare and update if not modified above
    // this.inputs = this.virtualMachine.getInputs(this.entry.$umid);
  }

  public async updateStreams(earlyCommit?: Function): Promise<void> {
    if (earlyCommit) this.earlyCommit = earlyCommit;

    this.streams.length
      ? await this.processStreams()
      : await this.processNoStreams();
  }

  private async processNoStreams() {

    // Should we store the umid still?
    // Nothing to store which is _no longer_ strange contract may not make changes!
    // Were we first?
    if (!this.entry.$territoriality) {
      this.entry.$territoriality = this.reference;
    }

    // Return Data for this nodes contract run
    this.nodeResponse.return = this.virtualMachine.getReturnContractData(
      this.entry.$umid
    );

    // Respond with the possible early committed
    this.emitter.emit("commited");

    // Manage Post Processing (If Exists)
    try {
      this.nodeResponse.post = await this.virtualMachine.postProcess(
        this.entry.$territoriality === this.reference,
        this.entry.$territoriality,
        this.entry.$umid
      );

      // Update in communication (Recommended pre commit only but can be edge use cases)
      this.nodeResponse.incomms = this.virtualMachine.getInternodeCommsFromVM(
        this.entry.$umid
      );

      // Clearing All node comms?
      this.entry = this.shared.clearAllComms(
        this.virtualMachine,
        this.nodeResponse.incomms
      );

      // Remember to let other nodes know
      this.earlyCommit?.();

      // // Respond with the possible early committed
      // this.emitter.emit("commited");
    } catch (error) {
      // Don't let local error stop other nodes
      this.earlyCommit?.();
      // Ignore errors for now, As commit was still a success
      this.emitter.emit("commited");
    }
  }

  private async processStreams() {
    this.docs = [];

    this.buildReferenceStreams();

    // Any inputs left (Means not modified, Unmodified outputs can be ignored)
    // Now we need to append transaction to the inputs of the transaction
    //if (this.inputs && this.inputs.length) this.handleInputs();

    // Create umid document containing the transaction details. Includes
    // every event this transaction's contract raised (sibling to umid/
    // streams, not nested inside compactTxEntry() - matches the shape
    // Endpoints.umid() serves back as-is via db.get(umid + ":umid"), which
    // is what restore/interagent.ts's insertUmid() and quick-restore.ts
    // read to replay them on a node that's restoring this transaction
    // having missed it the first time).
    this.docs.push({
      _id: this.entry.$umid + ":umid",
      umid: this.compactTxEntry(),
      streams: this.refStreams,
      events: this.virtualMachine.getEvents(this.entry.$umid),
    });

    // Was previously fire-and-forget (unawaited). Since detectCollisions()
    // is what actually decides commit/reject and calls append() (the real
    // stream write), not awaiting it let updateStreams() resolve before
    // that decision existed yet - the caller (Process.commit()) would move
    // on believing the streams step was done while it was still in flight.
    await this.detectCollisions();
  }

  /**
   * Creates a smaller trasnaction entry for ledger walking. This will also
   * keep the value deterministic (not including nodes)
   *
   * (Events are attached as a sibling field in processStreams()'s
   * docs.push(), not here - see getEvents() above.)
   *
   * @private
   * @returns
   * */
  private compactTxEntry() {
    return {
      $umid: this.entry.$umid,
      $tx: this.entry.$tx,
      $sigs: this.entry.$sigs,
      $revs: this.entry.$revs,
      $selfsign: this.entry.$selfsign ? this.entry.$selfsign : false,
      $datetime: this.entry.$datetime,
      //$nodes: this.entry.$nodes, // This is to different! Umid recovery not working
      $origin: this.entry.$origin,
      $remoteAddr: this.entry.$remoteAddr,
    };
  }

  /**
   * Handle data that is to be stored specifically against a contract
   *
   * @private
   */
  private handleContractDataStream(
    contractData: ActiveDefinitions.IContractData
  ) {
    // Replace contract label with ID if required
    const [contract, suffix] = contractData._id.split(":");
    if (contract.length < 64) {
      contractData._id = `${this.contractId}:${suffix}`;
    }

    this.docs.push(contractData);
  }

  /**
   * Compile streams for umid & return reference
   *
   * @private
   */
  private buildReferenceStreams() {
    // Loop Streams
    let i = this.streams.length;
    while (i--) {
      if (
        (
          this.streams[i] as unknown as ActiveDefinitions.IContractData
        )._id?.indexOf(":data") > -1
      ) {
        this.handleContractDataStream(
          this.streams[i] as unknown as ActiveDefinitions.IContractData
        );
        continue;
      }

      // New or Updating? New streams will have a volatile set as {}
      if (this.streams[i].meta && !this.streams[i].meta._rev) {
        // Make sure we have an id
        if (!this.streams[i].meta._id) {
          // New (Need to set ids)
          this.streams[i].state._id = this.entry.$umid + i;
          this.streams[i].meta._id = this.streams[i].state._id + ":stream";
          this.streams[i].volatile!._id =
            this.streams[i].state._id + ":volatile";
        }

        // Need to add transaction to all meta documents Lets keep the root transaction still
        this.streams[i].meta.txs = [this.entry.$umid];

        // Need to remove rev
        delete this.streams[i].state._rev;
        delete this.streams[i].meta._rev;
        delete this.streams[i].volatile!._rev;

        // New Streams need to check if collision will happen
        if (this.streams[i].meta.umid !== this.entry.$umid) {
          this.collisions.push(this.streams[i].meta._id as string);
        }

        // Add to new stream reference
        this.refStreams.new.push({
          id: this.shared.assumedVirtualPrefix + this.streams[i].state._id,
          name: this.streams[i].meta.name,
        });
      } else {
        // Add to updated stream reference
        this.refStreams.updated.push({
          id: this.shared.filterPrefix(this.streams[i].state._id as string),
        });

        // meta.umid was previously left untouched on every update after
        // creation - permanently pointing at whichever transaction first
        // created this stream, no matter how many times it's been updated
        // since (live-confirmed: a stream updated a dozen+ times still had
        // meta._rev "1-..." and meta.umid equal to its creating
        // transaction). umid's original purpose - a durable record of the
        // creating transaction - now lives in meta.origin instead (set
        // once, at creation, in Activity's own constructor - never touched
        // here or anywhere else), which is why overwriting umid on every
        // update below is safe: nothing still depends on umid meaning
        // "creation transaction" once origin exists. The one other reader
        // of meta.umid in this codebase, the collision check a few lines
        // up (`this.streams[i].meta.umid !== this.entry.$umid`), only ever
        // runs in the mutually-exclusive *new*-stream branch above, before
        // this class has ever had a chance to overwrite anything - so it's
        // unaffected either way, but origin is the more honest field name
        // for what it actually checks. Not touching meta.txs - nothing in
        // this codebase reads it, so leaving it as a creation-time record
        // avoids unbounded growth on a stream updated many times, for no
        // current benefit.
        if (this.streams[i].meta) {
          this.streams[i].meta.umid = this.entry.$umid;
        }
      }

      // Data State (Developers Control)
      if (this.streams[i].state._id) this.docs.push(this.streams[i].state);

      // Meta (Stream Data) for internal usage
      if (this.streams[i].meta?._id) {
        this.docs.push(this.streams[i].meta);
      }

      // Volatile data which cannot really be trusted
      if (this.streams[i].volatile?._id)
        this.docs.push(this.streams[i].volatile);
    }
  }

  private async append() {
    try {
      const bulkWriteResult = await this.db.bulkDocs(this.docs);
      if (!bulkWriteResult) {
        throw new Error("Bulk Doc Insert Failed");
      }

      // Only post to event db if bulk write was successful
      await this.dbev.post({
        _id: `umid:${new Date(this.entry.$datetime).getTime()},${this.entry.$umid
          }`,
      });
    } catch (error) {
      ActiveLogger.debug(error, "Datastore Failure");
      this.shared.raiseLedgerError(1510, new Error("Failed to save streams"));
      return; // Stop processing on DB failure
    }

    // Set datetime to reflect when data is set from memory to disk
    this.nodeResponse.datetime = new Date();

    // Were we first?
    if (!this.entry.$territoriality) {
      this.entry.$territoriality = this.reference;
    }

    // If Origin Explain streams in output
    if (this.reference === this.entry.$origin) {
      this.entry.$streams = this.refStreams;
    }

    // Update response object to send to client if entry node failed
    this.nodeResponse.streams = this.refStreams;

    // Return Data for this nodes contract run
    this.nodeResponse.return = this.virtualMachine.getReturnContractData(
      this.entry.$umid
    );

    if (this.virtualMachine.getNewContractData(this.entry.$umid)) {
      this.emitter.emit("contractData", {
        contract: this.contractId,
        data: null, // Set to null and it will refresh next call
      });
    }

    try {
      // Handle post processing if it exists
      this.nodeResponse.post = await this.virtualMachine.postProcess(
        this.entry.$territoriality === this.reference,
        this.entry.$territoriality,
        this.entry.$umid
      );

      // Update in communication (Recommended pre commit only but can be edge use cases)
      this.nodeResponse.incomms = this.virtualMachine.getInternodeCommsFromVM(
        this.entry.$umid
      );

      // Clearing All node comms?
      this.entry = this.shared.clearAllComms(
        this.virtualMachine,
        this.nodeResponse.incomms
      );
    } catch (error) {
      // Post-processing error is not critical to the commit itself, but should be logged.
      ActiveLogger.error(error, "Post-processing failed");
    }

    // Broadcast commit & returns
    if (!this.nodeResponse.leader) {
      this.emitter.emit("broadcast");
    }

    // Remember to let other nodes know
    this.earlyCommit?.();

    // Respond with the possible early committed
    this.emitter.emit("commited");
  }

  private async detectCollisions() {
    if (this.collisions.length) {
      ActiveLogger.info("Deterministic streams to be checked");

      // Store the promises to wait on.
      const existenceChecks: Promise<Boolean>[] = [];

      let i = this.collisions.length;
      while (i--) {
        const streamId: string = this.collisions[i];

        // Query datastore for streams. ActiveRequest.send() (the transport
        // underneath ActiveDSConnect.get()) never rejects on a non-2xx
        // status - it resolves { data: <body> } for a 404 the same as a
        // 200, by design (see its own "deposit wants to treat 404 as 200"
        // comment). get().then(() => true).catch(() => false) therefore
        // always resolved true here, even for a genuinely missing stream -
        // exists() is the version of this check that's actually correct,
        // since it inspects the resolved body for a real _id instead of
        // relying on rejection to mean "not found".
        existenceChecks.push(this.db.exists(streamId));
      }

      // Wait for all the checks
      try {
        const existingStreams = await Promise.all(existenceChecks);

        if (existingStreams.some(exists => exists)) {
          // Problem streams exist
          ActiveLogger.debug(this.collisions, "Deterministic Stream Name Exists");

          // Update commit
          this.nodeResponse.commit = false;
          this.shared.raiseLedgerError(
            1530,
            new Error("Deterministic Stream Name Exists"),
            false,
            0,
            true
          );
        } else {
          // No collisions found
          await this.append();
        }
      } catch (error) {
        // This block should ideally not be reached if errors are caught in the map
        // But as a fallback, assume no collision and proceed.
        await this.append();
      }
    } else {
      // Continue
      await this.append();
    }
  }
}