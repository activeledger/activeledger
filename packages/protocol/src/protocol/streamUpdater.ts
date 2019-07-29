import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { IReferenceStreams } from "./interfaces/process.interface";
import { Shared } from "./shared";
import { IVirtualMachine } from "./interfaces/vm.interface";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "../../../logger/src/index";
import { EventEmitter } from "events";
export class StreamUpdater {
  private docs: any;

  private streams: ActiveDefinitions.LedgerStream[];

  private inputs: ActiveDefinitions.LedgerStream[];

  private skip: string[];

  private collisions: string[];

  private nhkCheck: boolean;

  private refStreams: IReferenceStreams;

  constructor(
    private entry: ActiveDefinitions.LedgerEntry,
    private virtualMachine: IVirtualMachine,
    private reference: string,
    private nodeResponse: any,
    private earlyCommit: any,
    private db: ActiveDSConnect,
    private emitter: EventEmitter,
    private shared: Shared
  ) {
    // Get the changed data streams
    this.streams = this.virtualMachine.getActivityStreamsFromVM(
      this.entry.$umid
    );

    // Get current working inputs to compare and update if not modified above
    this.inputs = this.virtualMachine.getInputs(this.entry.$umid);

    // Determanistic Collision Managamenent
    this.collisions = [];

    this.skip = [];

    // Cache Harden Key Flag
    this.nhkCheck = ActiveOptions.get<any>("security", {})
      .hardenedKeys as boolean;
  }

  public updateStreams(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.streams.length ? this.processStreams() : this.processNoStreams();
    });
  }

  private async processNoStreams() {
    // Nothing to store which is _no longer_ strange contract may not make changes!
    // Were we first?
    if (!this.entry.$territoriality) {
      this.entry.$territoriality = this.reference;
    }

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

      // Return Data for this nodes contract run
      this.nodeResponse.return = this.virtualMachine.getReturnContractData(
        this.entry.$umid
      );

      // Clearing All node comms?
      // Todo: move to shared
      this.entry = this.shared.clearAllComms(this.virtualMachine);

      // Remember to let other nodes know
      if (this.earlyCommit) this.shared.earlyCommit();

      // Respond with the possible early commited
      this.emitter.emit("commited");
    } catch (error) {
      // Don't let local error stop other nodes
      if (this.earlyCommit) this.shared.earlyCommit();
      // Ignore errors for now, As commit was still a success
      this.emitter.emit("commited");
    }
  }

  private processStreams() {
    this.docs = [];

    this.buildReferenceStreams();

    // Any inputs left (Means not modified, Unmodified outputs can be ignored)
    // Now we need to append transaction to the inputs of the transaction
    if (this.inputs && this.inputs.length) this.handleInputs();

    // Create umid document containing the transaction details
    this.docs.push({
      _id: this.entry.$umid + ":umid",
      umid: this.compactTxEntry(),
      streams: this.refStreams
    });

    this.detectCollisions();
  }

  /**
   * Creates a smaller trasnaction entry for ledger walking. This will also
   * keep the value deterministic (not including nodes)
   *
   * @private
   * @returns
   * @memberof Process
   * */
  private compactTxEntry() {
    return {
      $umid: this.entry.$umid,
      $tx: this.entry.$tx,
      $sigs: this.entry.$sigs,
      $revs: this.entry.$revs,
      $selfsign: this.entry.$selfsign ? this.entry.$selfsign : false
    };
  }

  private handleInputs() {
    const notInSkip = (index: number) =>
      this.skip.indexOf(this.inputs[i].meta._id as string) === -1;

    let i = this.inputs.length;
    while (i--) {
      if (
        notInSkip(i) &&
        this.inputs[i].meta.txs &&
        this.inputs[i].meta.txs.length
      ) {
        // Add compact transaction
        this.inputs[i].meta.txs.push(this.entry.$umid);

        // Hardened keys?
        if (this.inputs[i].state._id && this.nhkCheck) {
          this.handleNHPK(this.inputs[i]);
        }

        // Push the metadata to the docs array
        this.docs.push(this.inputs[i].meta);
      }
    }
  }

  private handleNHPK(input: any) {
    const inputLabel = this.shared.getLabelIOMap(true, input.state
      ._id as string);
    const nhpk = this.entry.$tx.$i[inputLabel].$nhpk;

    // Loop Signatures as they should be rewritten with authoritied nested
    // That way if any new auths were added they will be skipped
    const txSigAuthKeys = Object.keys(
      this.entry.$sigs[input.state._id as string]
    );

    const authorities = input.meta.authorities;
    const keys = Object.keys(authorities);

    // Loop all authorities to try and find a match
    let i = keys.length;
    while (i--) {
      const authority: ActiveDefinitions.ILedgerAuthority =
        authorities[keys[i]];

      // Get tx auth signature if existed
      const txSigAuthKey = txSigAuthKeys.indexOf(authority.hash as string);

      if (txSigAuthKey === -1) {
        authority.public = nhpk[txSigAuthKeys[txSigAuthKey]];
      }
    }
  }

  /**
   * Compile streams for umid & return reference
   *
   * @private
   * @memberof StreamUpdater
   */
  private buildReferenceStreams() {
    // Loop Streams
    let i = this.streams.length;
    while (i--) {
      // New or Updating?
      // New streams will have a volatile set as {}
      if (!this.streams[i].meta._rev) {
        // Make sure we have an id
        if (!this.streams[i].meta._id) {
          // New (Need to set ids)
          this.streams[i].state._id = this.entry.$umid + i;
          this.streams[i].meta._id = this.streams[i].state._id + ":stream";
          this.streams[i].volatile!._id =
            this.streams[i].state._id + ":volatile";
        }

        // Need to add transaction to all meta documents
        this.streams[i].meta.txs = [this.entry.$umid];
        // Also set as intalisiser stream (stream constructor)
        this.streams[i].meta.$constructor = true;

        // Need to remove rev
        delete this.streams[i].state._rev;
        delete this.streams[i].meta._rev;
        delete this.streams[i].volatile!._rev;

        // New Streams need to check if collision will happen
        if (this.streams[i].meta.umid !== this.entry.$umid) {
          this.collisions.push(this.streams[i].meta._id as string);
        }

        // Add to reference
        this.refStreams.new.push({
          id: this.streams[i].state._id,
          name: this.streams[i].meta.name
        });
      } else {
        // Updated Streams, These could be inputs
        // So update the transaction and remove for inputs for later processing
        if (this.streams[i].meta.txs && this.streams[i].meta.txs.length) {
          this.streams[i].meta.txs.push(this.entry.$umid);
          this.skip.push(this.streams[i].meta._id as string);
        }

        // Hardened Keys?
        if (this.streams[i].state._id && this.nhkCheck) {
          // Get nhpk
          let nhpk = this.entry.$tx.$i[
            this.shared.getLabelIOMap(true, this.streams[i].state._id as string)
          ].$nhpk;

          // Loop Signatures as they should be rewritten with authoritied nested
          // That way if any new auths were added they will be skipped
          let txSigAuthsKeys = Object.keys(
            this.entry.$sigs[this.streams[i].state._id as string]
          );

          // Loop all authorities to try and find a match
          this.streams[i].meta.authorities.forEach(
            (authority: ActiveDefinitions.ILedgerAuthority) => {
              // Get tx auth signature if existed
              const txSigAuthKey = txSigAuthsKeys.indexOf(
                authority.hash as string
              );
              if (txSigAuthKey !== -1) {
                (authority as any).public = nhpk[txSigAuthsKeys[txSigAuthKey]];
              }
            }
          );
        }

        // Add to reference
        this.refStreams.updated.push({
          id: this.streams[i].state._id,
          name: this.streams[i].meta.name
        });
      }

      // Data State (Developers Control)
      if (this.streams[i].state._id) this.docs.push(this.streams[i].state);

      // Meta (Stream Data) for internal usage
      if (this.streams[i].meta._id) this.docs.push(this.streams[i].meta);

      // Volatile data which cannot really be trusted
      if (this.streams[i].volatile && this.streams[i].volatile!._id)
        this.docs.push(this.streams[i].volatile);
    }
  }

  private async append() {
    let continueProcessing = true,
      emit = true;

    try {
      await this.db.bulkDocs(this.docs);
    } catch (error) {
      continueProcessing = emit = false;

      ActiveLogger.debug(error, "Datatore Failure");
      // TODO: Put in shared
      this.shared.raiseLedgerError(1510, new Error("Failed to save"));
    }

    if (continueProcessing) {
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

      try {
        // Handle post processing if it exists
        const post = await this.virtualMachine.postProcess(
          this.entry.$territoriality === this.reference,
          this.entry.$territoriality,
          this.entry.$umid
        );

        this.nodeResponse.post = post;

        // Update in communication (Recommended pre commit only but can be edge use cases)
        this.nodeResponse.incomms = this.virtualMachine.getInternodeCommsFromVM(
          this.entry.$umid
        );

        // Return Data for this nodes contract run
        this.nodeResponse.return = this.virtualMachine.getReturnContractData(
          this.entry.$umid
        );

        // Clearing All node comms?
        this.entry = this.shared.clearAllComms(this.virtualMachine);
      } catch (error) {
        continueProcessing = false;
      }
    }

    // Remember to let other nodes know
    if (this.earlyCommit) {
      this.shared.earlyCommit();
    }

    if (emit) {
      // Respond with the possible early commited
      this.emitter.emit("commited");
    }
  }

  private detectCollisions() {
    if (this.collisions.length) {
      ActiveLogger.info("Deterministic streams to be checked");

      // Store the promises to wait on.
      let streamColCheck: any[] = [];

      let i = this.collisions.length;
      while (i--) {
        const streamId: string = this.collisions[i];

        // Query datastore for streams
        streamColCheck.push(this.db.get(streamId));
      }

      // Wait for all the checks
      try {
        const streams = Promise.all(streamColCheck);

        // Problem streams exist
        ActiveLogger.debug(streams, "Deterministic Stream Name Exists");

        // Update commit
        this.nodeResponse.commit = false;
        this.shared.raiseLedgerError(
          1530,
          new Error("Deterministic Stream Name Exists")
        );
      } catch (error) {
        // ? Continue (Error being document not found)
        this.append();
      }
    } else {
      // Continue
      this.append();
    }
  }
}
