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

import * as fs from "fs";
import { EventEmitter } from "events";
import { VirtualMachine } from "./vm";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import {
  IVMDataPayload,
  IVMContractHolder,
  IVirtualMachine
} from "./interfaces/vm.interface";
import {
  ISecurityCache,
  IReferenceStreams
} from "./interfaces/process.interface";
import { Shared } from "./shared";

/**
 * Class controls the processing of this nodes consensus
 *
 * @export
 * @class Process
 * @extends {EventEmitter}
 */
export class Process extends EventEmitter {
  // #region Class variables

  /**
   * Holds the instance that controls general contracts
   *
   * @private
   * @type {VirtualMachine}
   * @memberof Process
   */
  private static generalContractVM: VirtualMachine;

  /**
   * Holds the instance that controls the default contracts (anything in the default namespace)
   *
   * @private
   * @static
   * @type {VirtualMachine}
   * @memberof Process
   */
  private static defaultContractsVM: VirtualMachine;

  /**
   * Holds an object of individual VM controller instances for unsafe contracts
   * Unsafe contracts are separated by namespace, so these instances will still run multiple contracts
   *
   * @private
   * @static
   * @type {IVMContractHolder}
   * @memberof Process
   */
  private static singleContractVMHolder: IVMContractHolder;

  /**
   * Is this instance of Process dealing with a default contract
   *
   * @private
   * @type {boolean}
   * @memberof Process
   */
  private isDefault: boolean = false;

  /**
   * A reference to a contract in singleContractVMHolder, via namespace
   *
   * @private
   * @type {string}
   * @memberof Process
   */
  private contractRef: string;

  /**
   * Holds string reference of inputs streams
   *
   * @private
   * @type {string[]}
   * @memberof Process
   */
  private inputs: string[];

  /**
   * Holds string reference of output streams
   *
   * @private
   * @type {string[]}
   * @memberof Process
   */
  private outputs: string[];

  /**
   * Flag for checking or setting revisions
   *
   * @private
   * @type {boolean}
   * @memberof Process
   */
  private checkRevs: boolean = true;

  /**
   * Contains reference to this nodes node response
   *
   * @private
   * @type {ActiveDefinitions.INodeResponse}
   * @memberof Process
   */
  private nodeResponse: ActiveDefinitions.INodeResponse;

  /**
   * Default Contracts & Compiled Contracts are in differntlocations
   *
   * @private
   * @type {string}
   * @memberof Process
   */
  private contractLocation: string;

  /**
   * Commiting State
   *
   * @private
   * @memberof Process
   */
  private commiting = false;

  /**
   *  Voting State
   *
   * @private
   * @memberof Process
   */
  private voting = true;

  /**
   * So we only restore once per tx
   * we use this as a flag for the storeError
   *
   * @private
   * @memberof Process
   */
  private storeSingleError = false;

  /**
   * Prioritise the error sent to the requestee
   *
   * @private
   * @memberof Process
   */
  private errorOut = {
    code: 0,
    reason: "",
    priority: 0
  };

  /**
   * Holds the broadcast timeout object
   *
   * @private
   * @type {NodeJS.Timeout}
   * @memberof Process
   */
  private broadcastTimeout: NodeJS.Timeout;

  /**
   * Current Voting Round
   *
   * @private
   * @type {number}
   * @memberof Process
   */
  private currentVotes: number;

  /**
   * A cache of the secure namespaces
   *
   * @private
   * @type {string[]}
   * @memberof Process
   */
  private securityCache: ISecurityCache | null;

  private shared: Shared;

  // #endregion

  /**
   * Creates an instance of Process.
   *
   * @param {ActiveDefinitions.LedgerEntry} entry
   * @param {string} selfHost
   * @param {string} reference
   * @param {*} right
   * @param {ActiveDSConnect} db
   * @param {ActiveDSConnect} error
   * @param {ActiveDSConnect} events
   * @param {ActiveCrypto.Secured} secured
   * @memberof Process
   */
  constructor(
    private entry: ActiveDefinitions.LedgerEntry,
    private selfHost: string,
    private reference: string,
    private right: ActiveDefinitions.INeighbourBase,
    private db: ActiveDSConnect,
    private dbe: ActiveDSConnect,
    private dbev: ActiveDSConnect,
    private secured: ActiveCrypto.Secured
  ) {
    super();

    this.shared = new Shared();

    // Reference node response
    this.nodeResponse = entry.$nodes[reference];

    try {
      Process.generalContractVM = new VirtualMachine(
        this.selfHost,
        this.secured,
        this.db,
        this.dbev
      );

      Process.generalContractVM.initialiseVirtualMachine();
    } catch (error) {
      throw new Error(error);
    }
  }

  /**
   * Destroy the process object from memory
   *
   * @memberof Process
   */
  public destroy(umid: string): void {
    // Record un commited transactions as an error
    if (!this.nodeResponse.commit) {
      this.raiseLedgerError(
        1600,
        new Error("Failed to commit before timeout"),
        true
      );
    }

    // Make sure broadcast timeout is cleared
    clearTimeout(this.broadcastTimeout);

    // Close VM and entry (cirular reference)
    this.isDefault
      ? Process.defaultContractsVM.destroy(umid)
      : this.contractRef
      ? Process.singleContractVMHolder[this.contractRef].destroy(umid)
      : Process.generalContractVM.destroy(umid);

    delete this.entry;
  }

  /**
   * Starts the consensus and commit phase processing
   *
   * @memberof Process
   */
  public async start() {
    // Compiled Contracts sit in another location
    const setupDefaultLocation = () => {
      // Set isDefault flag to true
      this.isDefault = true;

      // Default Contract Location
      this.contractLocation = `${ActiveOptions.get("__base", "./")}/contracts/${
        this.entry.$tx.$namespace
      }/${this.entry.$tx.$contract}.js`;
    };

    // Ledger Transpiled Contract Location
    const setupLocation = () =>
      (this.contractLocation = `${process.cwd()}/contracts/${
        this.entry.$tx.$namespace
      }/${this.entry.$tx.$contract}.js`);

    // Is this a default contract
    this.entry.$tx.$namespace === "default"
      ? setupDefaultLocation()
      : setupLocation();

    // Setup the virtual machine for this process
    const virtualMachine: IVirtualMachine = this.isDefault
      ? Process.defaultContractsVM
      : this.contractRef
      ? Process.singleContractVMHolder[this.contractRef]
      : Process.generalContractVM;

    // Get contract file (Or From Database)
    if (fs.existsSync(this.contractLocation)) {
      // Now we know we can execute the contract now or more costly cpu checks
      ActiveLogger.debug("Fetching Inputs");

      // Build Inputs Key Maps (Reference is Stream)
      this.inputs = Object.keys(this.entry.$tx.$i || {});

      // We must have inputs (New Inputs can create brand new unknown outputs)
      if (!this.inputs.length) {
        this.raiseLedgerError(1101, new Error("Inputs cannot be null"));
      }

      // Which $i lookup are we using. Are they labelled or stream names
      this.labelOrKey();

      // Build Outputs Key Maps (Reference is Stream)
      ActiveLogger.debug("Fetching Outputs");
      this.outputs = Object.keys(this.entry.$tx.$o || {});

      // Which $o lookup are we using. Are they labelled or stream names
      // Make sure we have outputs as they're optional
      if (this.outputs.length) {
        // Which $o lookup are we using. Are they labelled or stream names
        this.labelOrKey(true);
      }

      // Are we checking revisions or setting?
      if (!this.entry.$revs) {
        this.checkRevs = false;
        this.entry.$revs = {
          $i: {},
          $o: {}
        };
      }

      // If Signatureless transaction (Such as a new account there cannot be a revision)
      if (!this.entry.$selfsign) {
        // Prefixes
        // [umid] : Holds the data state (Prefix may be removed)
        // [umid]:stream : Activeledger Meta Data
        // [umid]:volatile : Data that can be lost

        try {
          // Check the input revisions
          const inputStreams: ActiveDefinitions.LedgerStream[] = await this.permissionsCheck();

          // Check the output revisions
          const outputStreams: ActiveDefinitions.LedgerStream[] = await this.permissionsCheck(
            false
          );

          this.process(inputStreams, outputStreams);
        } catch (error) {
          // Forward Error On
          // We may not have the output stream, So we need to pass over the knocks
          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message
          });
        }
      } else {
        ActiveLogger.debug("Self signed Transaction");

        // If there are sigs we can enforce for the developer
        let sigs = Object.keys(this.entry.$sigs);
        if (sigs.length > 0) {
          // Loop Signatures and match against inputs
          let i = sigs.length;
          while (i--) {
            let signature = this.entry.$sigs[sigs[i]];
            let input = this.entry.$tx.$i[sigs[i]];

            const validSignature = () =>
              this.signatureCheck(
                input.publicKey,
                signature as string,
                input.type ? input.type : "rsa"
              );

            // Make sure we have an input (Can Skip otherwise maybe onboarded)
            if (input) {
              // Check the input has a public key
              if (input.publicKey) {
                if (!validSignature()) {
                  return this.raiseLedgerError(
                    1250,
                    new Error("Self signed signature not matching")
                  );
                }
              } else {
                // We don't have the public key to check
                return this.raiseLedgerError(
                  1255,
                  new Error(
                    "Self signed publicKey property not found in $i " + sigs[i]
                  )
                );
              }
            } else {
              return;
            }
          }
        }

        try {
          // No input streams, Maybe Output
          const outputStreams: ActiveDefinitions.LedgerStream[] = await this.permissionsCheck(
            false
          );
          this.process([], outputStreams);
        } catch (error) {
          // Forward Error On
          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message
          });
        }
      }
    } else {
      // Contract not found
      this.postVote(virtualMachine, {
        code: 1401,
        reason: "Contract Not Found"
      });
    }
  }

  /**
   * Updates VM transaction entry from other node broadcasts
   *
   * @param {*} node
   * @returns {ActiveDefinitions.INodeResponse}
   * @memberof Process
   */
  public updatedFromBroadcast(node?: any): ActiveDefinitions.INodeResponse {
    // Update networks response into local object
    this.entry.$nodes = Object.assign(this.entry.$nodes, node);
    // Make sure we haven't already reached consensus
    if (!this.isCommiting() && !this.voting) {
      // Reset Reference node response
      this.nodeResponse = this.entry.$nodes[this.reference];
      // Try run commit!

      // Get the correct VM instance reference
      this.isDefault
        ? this.commit(Process.defaultContractsVM)
        : this.contractRef
        ? this.commit(Process.singleContractVMHolder[this.contractRef])
        : this.commit(Process.generalContractVM);
    }

    return this.nodeResponse;
  }

  /**
   * Returns Commiting State (Broadcast)
   *
   * @returns {boolean}
   * @memberof Process
   */
  public isCommiting(): boolean {
    return this.commiting;
  }

  /**
   * Initialise the default contracts VM instance if needed and/or pass through the data
   *
   * @private
   * @param {IVMDataPayload} payload
   * @param {string} contractName
   * @memberof Process
   */
  private processDefaultContracts(
    payload: IVMDataPayload,
    contractName: string
  ) {
    // Check if the holder needs to be initialised
    if (!Process.defaultContractsVM) {
      // Setup for default contracts
      const external = [];
      const builtin = [];
      switch (payload.transaction.$contract) {
        case "contract":
          external.push("typescript");
          builtin.push("fs", "path", "os", "crypto");
          break;
        case "setup":
          builtin.push("fs", "path");
          break;
      }

      try {
        Process.defaultContractsVM = new VirtualMachine(
          this.selfHost,
          this.secured,
          this.db,
          this.dbev
        );

        Process.defaultContractsVM.initialiseVirtualMachine(builtin, external);
      } catch (error) {
        throw new Error(error);
      }
    }

    // Pass through the VM holder and data to the VM Handler
    this.handleVM(Process.defaultContractsVM, payload, contractName);
  }

  /**
   * Handle the initialisation and pass through of data for unsafe contracts
   *
   * @private
   * @param {IVMDataPayload} payload
   * @param {string} namespace
   * @param {string} contractName
   * @param {string[]} extraBuiltins
   * @memberof Process
   */
  private processUnsafeContracts(
    payload: IVMDataPayload,
    namespace: string,
    contractName: string,
    extraBuiltins: string[]
  ) {
    this.contractRef = namespace;

    // If we have initialised an instance for this namespace reuse it
    // Otherwise we should create an instance for it
    if (!Process.singleContractVMHolder[this.contractRef]) {
      try {
        Process.singleContractVMHolder[this.contractRef] = new VirtualMachine(
          this.selfHost,
          this.secured,
          this.db,
          this.dbev
        );

        Process.singleContractVMHolder[
          this.contractRef
        ].initialiseVirtualMachine(extraBuiltins);
      } catch (error) {
        throw new Error(error);
      }
    }

    // Pass VM instance and data to the VM Handler
    this.handleVM(
      Process.singleContractVMHolder[this.contractRef],
      payload,
      contractName
    );
  }

  /**
   * Handler processing of a transaction using a specified pre-initialised VM instance
   *
   * @private
   * @param {IVirtualMachine} virtualMachine
   * @param {IVMDataPayload} payload
   * @param {string} contractName
   * @memberof Process
   */
  private async handleVM(
    virtualMachine: IVirtualMachine,
    payload: IVMDataPayload,
    contractName: string
  ) {
    // Internal micro functions

    // Handle a vote error
    const handleVoteError = async (error: Error) => {
      try {
        await this.storeError(
          1000,
          new Error("Vote Failure - " + JSON.stringify(error)),
          10
        );
      } catch (storeError) {
        // Continue Execution of consensus even with this failing
        // Just add a fatal message
        ActiveLogger.fatal(error, "Voting Error Log Issues");
      } finally {
        // Continue Execution of consensus
        // Update Error
        this.nodeResponse.error = error.message;

        // Continue to next nodes vote
        this.postVote(virtualMachine);
      }
    };

    // If there is an error processing should stop
    let continueProcessing = true;

    // Initialise the contract in the VM
    try {
      await virtualMachine.initialise(payload, contractName);
    } catch (error) {
      // Contract not found / failed to start
      ActiveLogger.debug(error, "VM initialisation failed");
      this.raiseLedgerError(
        1401,
        new Error("VM Init Failure - " + JSON.stringify(error.message || error))
      );

      // Stop processing
      continueProcessing = false;
    }

    // Run the verification round
    try {
      if (continueProcessing)
        await virtualMachine.verify(this.entry.$selfsign, this.entry.$umid);
    } catch (error) {
      ActiveLogger.debug(error, "Verify Failure");
      // Verification Failure
      this.raiseLedgerError(1310, new Error(error));

      // Stop processing
      continueProcessing = false;
    }

    // Run the vote round
    try {
      if (continueProcessing) await virtualMachine.vote(this.entry.$umid);
    } catch (error) {
      // Do something with the error
      handleVoteError(error);

      // Stop processing
      continueProcessing = false;
    }

    // All previous rounds successful continue processing
    if (continueProcessing) {
      // Update Vote Entry
      this.nodeResponse.vote = true;

      // Internode Communication picked up here, Doesn't mean every node
      // Will get all values (Early send back) but gives the best chance of getting most of the nodes communicating
      this.nodeResponse.incomms = virtualMachine.getInternodeCommsFromVM(
        this.entry.$umid
      );

      // Return Data for this nodes contract run (Useful for $instant request expected id's)
      this.nodeResponse.return = virtualMachine.getReturnContractData(
        this.entry.$umid
      );

      // Clearing All node comms?
      this.clearAllComms(virtualMachine);

      // Continue to next nodes vote
      this.postVote(virtualMachine);
    }
  }

  /**
   * Processes the transaction through the contract phases
   * Verify, Vote, Commit.
   * Vote phase is in memory blocked during conensus unless instant transaction
   *
   * @private
   * @param {LedgerStream[]} inputs
   * @memberof Process
   */
  private async process(
    inputs: ActiveDefinitions.LedgerStream[]
  ): Promise<void>;
  private async process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[]
  ): Promise<void>;
  private async process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[] = []
  ): Promise<void> {
    try {
      // Get readonly data
      const readonly = await this.getReadOnlyStreams();

      const contractName = this.contractLocation.substr(
        this.contractLocation.lastIndexOf("/") + 1
      );

      // Build the contract payload
      const payload: IVMDataPayload = {
        contractLocation: this.contractLocation,
        umid: this.entry.$umid,
        date: this.entry.$datetime,
        remoteAddress: this.entry.$remoteAddr,
        transaction: this.entry.$tx,
        signatures: this.entry.$sigs,
        inputs,
        outputs,
        readonly,
        key: Math.floor(Math.random() * 100)
      };

      // Check if the security data has been cached
      if (!this.securityCache) {
        this.securityCache = ActiveOptions.get<any>("security", null);
      }

      if (
        !this.securityCache &&
        !this.securityCache!.namespace &&
        !this.securityCache!.namespace[payload.transaction.$namespace] &&
        payload.transaction.$namespace !== "default"
      ) {
        // Use the General contract VM
        this.handleVM(Process.generalContractVM, payload, contractName);
      } else if (
        this.securityCache &&
        this.securityCache.namespace &&
        this.securityCache.namespace[payload.transaction.$namespace]
      ) {
        const builtin: string[] = [];
        // Use the Unsafe contract VM, first we need to build a custom builtin array to use to initialise the VM
        this.securityCache.namespace[
          payload.transaction.$namespace
        ].std.forEach((item: string) => {
          builtin.push(item);
        });

        // Initialise the unsafe contract VM
        this.processUnsafeContracts(
          payload,
          payload.transaction.$namespace,
          contractName,
          builtin
        );
      } else {
        // Use the Default contract VM (for contracts that are built into Activeledger)
        this.processDefaultContracts(payload, contractName);
      }
    } catch (error) {
      // error fetch read only streams
      this.raiseLedgerError(1210, new Error("Read Only Stream Error"));
    }
  }

  /**
   * Manages the protocol process after this node has voted
   *
   * @private
   * @memberof Process
   */
  private postVote(virtualMachine: IVirtualMachine, error: any = false): void {
    // Set voting completed state
    this.voting = false;

    // Instant Transaction Return right away
    if (!error && this.entry.$instant) {
      this.emit("commited", { instant: true });
      // Rewrite trasnaction to no longer be instant for standard background consensus
      this.entry.$instant = false;
    }

    // Which Peering mode?
    if (this.entry.$broadcast) {
      if (error) {
        // Add error to the broadcast for passing back to the client
        this.entry.$nodes[this.reference].error = error.reason;
      }
      // Let all other nodes know about this transaction and our opinion
      this.emit("broadcast");

      // Check we will be commiting (So we don't process as failed tx)
      if (this.canCommit()) {
        // Try run commit! (May have reach consensus here)
        this.commit(virtualMachine);
      }
    } else {
      // Knock our right neighbour with this trasnaction if they are not the origin
      if (this.right.reference != this.entry.$origin) {
        // Send back early if consensus has been reached and not the end of the network
        // (Early commit, Then Forward to network)
        this.commit(virtualMachine, async () => {
          try {
            const response = await this.right.knock("init", this.entry);

            // Check we didn't commit early
            if (!this.nodeResponse.commit) {
              // Territoriality set?
              this.entry.$territoriality = (response.data as ActiveDefinitions.LedgerEntry).$territoriality;

              // Append new $nodes
              this.entry.$nodes = (response.data as ActiveDefinitions.LedgerEntry).$nodes;

              // Reset Reference node response
              this.nodeResponse = this.entry.$nodes[this.reference];

              // Normal, Or getting other node opinions?
              if (error) {
                this.raiseLedgerError(error.code, error.reason, true, 10);
              }

              // Run the Commit Phase
              this.commit(virtualMachine);
            }
          } catch (error) {
            // Need to manage errors this would mean the node is unreachable
            ActiveLogger.debug(error, "Knock Failure");

            // if debug mode forward
            // IF error has status and error this came from another node which has erroed (not unreachable)
            ActiveOptions.get<boolean>("debug", false)
              ? this.raiseLedgerError(
                  error.status || 1502,
                  new Error(error.error)
                ) // rethrow same error
              : this.raiseLedgerError(1501, new Error("Bad Knock Transaction")); // Generic error 404/ 500
          }
        });
      } else {
        ActiveLogger.debug("Origin is next (Sending Back)");

        error
          ? this.raiseLedgerError(error.code, error.reason) // Of course if next is origin we need to send back for the promises!
          : this.commit(virtualMachine); // Run the Commit Phase
      }
    }
  }

  /**
   * Decides if consensus has been reached for commit phase to start
   *
   * @private
   * @param {boolean} [skipBoost=false]
   * @returns {boolean}
   * @memberof Process
   */
  private canCommit(skipBoost = false): boolean {
    // Time to count the votes (Need to recache keys)
    let networkNodes: string[] = Object.keys(this.entry.$nodes);
    this.currentVotes = 0;

    // Small performance boost if we voted no
    if (skipBoost || this.nodeResponse.vote) {
      let i = networkNodes.length;
      while (i--) {
        if (this.entry.$nodes[networkNodes[i]].vote) this.currentVotes++;
      }
    }

    // Return if consensus has been reached
    return (
      ((skipBoost || this.nodeResponse.vote) &&
        (this.currentVotes /
          ActiveOptions.get<Array<any>>("neighbourhood", []).length) *
          100 >=
          ActiveOptions.get<any>("consensus", {}).reached) ||
      false
    );
  }

  /**
   * Checks voting round and runs the commit phase of the contract
   * The use of callback is because it fits better than a promise in the flow and the performance is a bonus
   *
   * @private
   * @param {Function} [earlyCommit]
   * @returns {void}
   * @memberof Process
   */
  private async commit(
    virtualMachine: IVirtualMachine,
    earlyCommit?: () => void
  ): Promise<void> {
    // If we haven't commited process as normal
    if (!this.nodeResponse.commit) {
      // check we can commit still
      if (this.canCommit()) {
        // Consensus reached commit phase
        this.commiting = true;

        // Pass Nodes for possible INC injection
        try {
          await virtualMachine.commit(
            this.entry.$nodes,
            this.entry.$territoriality === this.reference,
            this.entry.$umid
          );

          // Update Commit Entry
          this.nodeResponse.commit = true;

          // Update in communication (Recommended pre commit only but can be edge use cases)
          this.nodeResponse.incomms = virtualMachine.getInternodeCommsFromVM(
            this.entry.$umid
          );

          // Return Data for this nodes contract run
          this.nodeResponse.return = virtualMachine.getReturnContractData(
            this.entry.$umid
          );

          // Clearing All node comms?
          this.clearAllComms(virtualMachine);

          // Are we throwing to another ledger(s)?
          let throws = virtualMachine.getThrowsFromVM(this.entry.$umid);

          // Emit to network handler
          if (throws && throws.length) {
            this.emit("throw", { locations: throws });
          }

          // Update Streams
          this.updateStreams(virtualMachine, earlyCommit);
        } catch (error) {
          // Don't let local error stop other nodes
          if (earlyCommit) earlyCommit();

          ActiveLogger.debug(error, "VM Commit Failure");

          // If debug mode forward full error
          ActiveOptions.get<boolean>("debug", false)
            ? this.raiseLedgerError(
                1302,
                new Error(
                  "Commit Failure - " + JSON.stringify(error.message || error)
                )
              )
            : this.raiseLedgerError(
                1301,
                new Error("Failed Commit Transaction")
              );
        }
      } else {
        // If Early commit we don't need to manage these errors
        if (earlyCommit) return earlyCommit();

        // Consensus not reached
        if (!this.nodeResponse.vote) {
          // We didn't vote right
          ActiveLogger.debug(
            this.nodeResponse,
            "VM Commit Failure, We voted NO"
          );

          // We voted false, Need to process
          // Still required as broadcast will skip over 1000
          this.raiseLedgerError(
            1505,
            new Error("This node voted false"),
            false
          );

          //TODO: Consensus Vote Reconciling not available on broadcast p2p method
          if (!this.entry.$broadcast) {
            //? Reminder : Contract Voted False to be here not pre-flights
            // How can we tell the network commited? I guess we should count the votes?
            if (this.canCommit(true)) {
              ActiveLogger.debug(
                "Network Consensus reached without me (Reconciling)"
              );

              try {
                const reconciled: boolean = await virtualMachine.reconcile(
                  this.entry.$nodes,
                  this.entry.$umid
                );
                // Contract ran its own reconcile procedure
                if (reconciled) {
                  ActiveLogger.info("Self Renconcile Successful");
                  // tx is for hybrid, Do we want to broadcast a reconciled one? if so we can do this within the function
                  this.updateStreams(virtualMachine);
                } else {
                  // No move onto internal attempts
                  // Upgrade error code so restore will process it
                  if (this.errorOut.code === 1000) {
                    ActiveLogger.info(
                      "Self Renconcile Failed & Upgrading Error Code for Auto Restore"
                    );
                    // reset single error as 1000 is skipped anyway
                    this.storeSingleError = false;
                    // try/catch to finish execution
                    this.storeError(1001, new Error(this.errorOut.reason), 11)
                      .then(() => {
                        this.emit("commited");
                      })
                      .catch(() => {
                        this.emit("commited");
                      });
                  } else {
                    // Because we voted no doesn't mean the network should error
                    this.emit("commited");
                  }
                }
              } catch (error) {
                // Timed out
                ActiveLogger.debug(error);
                this.emit("commited");
              }
            }
          } else {
            // Because we voted no doesn't mean the network should error
            this.emit("commited");
          }
        } else {
          if (!this.entry.$broadcast) {
            // Network didn't reach consensus
            ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
            this.raiseLedgerError(
              1510,
              new Error("Failed Network Voting Round")
            );
          } else {
            // Are there any outstanding node responses which could mean consensus can still be reached
            const neighbours = ActiveOptions.get<Array<any>>(
              "neighbourhood",
              []
            ).length;
            const consensusNeeded = ActiveOptions.get<any>("consensus", {})
              .reached;
            const outstandingVoters =
              neighbours - Object.keys(this.entry.$nodes).length;

            // Basic check, If no nodes to respond and we failed to reach consensus we will fail
            if (!outstandingVoters) {
              // Clear current timeout to prevent it from running
              clearTimeout(this.broadcastTimeout);
              // Entire Network didn't reach consensus
              ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
              return this.raiseLedgerError(
                1510,
                new Error("Failed Network Voting Round")
              );
            } else {
              // Clear current timeout to prevent it from running
              clearTimeout(this.broadcastTimeout);
              // Solution:
              // Find how many current votes their currently is if the rest of the nodes will vote yes can we reach consensus
              if (
                ((this.currentVotes + outstandingVoters) / neighbours) * 100 >=
                consensusNeeded
              ) {
                // It *should* be possible to still reach consensus
                // Nodes may also be down meaning we never respond so need to manage a timeout
                // ! This method does mean it will hold the client tx connection open which could timeout
                // TODO: We could improve this when we have access to isHome
                this.broadcastTimeout = setTimeout(() => {
                  // Entire Network didn't reach consensus in time
                  ActiveLogger.debug("VM Commit Failure, NETWORK Timeout");
                  return this.raiseLedgerError(
                    1510,
                    new Error("Failed Network Voting Timeout")
                  );
                }, 20000);
              } else {
                // Even if the other nodes voted yes we will still not reach conesnsus
                ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
                return this.raiseLedgerError(
                  1510,
                  new Error("Failed Network Voting Round")
                );
              }
            }
          }
        }
      }
    } else {
      // We have committed do nothing.
      // Headers should be sent already but just in case emit commit
      if (earlyCommit) earlyCommit();
      //? this.emit("commited");
    }
  }

  private updateStreams(
    virtualMachine: IVirtualMachine,
    earlyCommit?: Function
  ) {
    // Any Changes
    if (streams.length) {
      // Process Changes to the database
      // Bulk Insert Docs
      let docs: any[] = [];

      /**
       * Delegate Function
       * Attempt to atomicaly save to the datastore
       * Allow for delay execution for deterministic test
       */
      // ! Working from here
      let append = () => {
        this.db
          .bulkDocs(docs)
          .then(() => {
            // Set datetime to reflect when data is set from memory to disk
            this.nodeResponse.datetime = new Date();

            // Were we first?
            if (!this.entry.$territoriality)
              this.entry.$territoriality = this.reference;

            // If Origin Explain streams in output
            if (this.reference == this.entry.$origin) {
              this.entry.$streams = refStreams;
            }

            // Manage Post Processing (If Exists)
            virtualMachine
              .postProcess(
                this.entry.$territoriality == this.reference,
                this.entry.$territoriality,
                this.entry.$umid
              )
              .then((post) => {
                this.nodeResponse.post = post;

                // Update in communication (Recommended pre commit only but can be edge use cases)
                this.nodeResponse.incomms = virtualMachine.getInternodeCommsFromVM(
                  this.entry.$umid
                );

                // Return Data for this nodes contract run
                this.nodeResponse.return = virtualMachine.getReturnContractData(
                  this.entry.$umid
                );

                // Clearing All node comms?
                this.clearAllComms(virtualMachine);

                // Remember to let other nodes know
                if (earlyCommit) earlyCommit();

                // Respond with the possible early commited
                this.emit("commited");
              })
              .catch(() => {
                // Don't let local error stop other nodes
                if (earlyCommit) earlyCommit();

                // Ignore errors for now, As commit was still a success
                this.emit("commited");
              });
          })
          .catch((error: Error) => {
            // Don't let local error stop other nodes
            if (earlyCommit) earlyCommit();
            ActiveLogger.debug(error, "Datatore Failure");
            this.raiseLedgerError(1510, new Error("Failed to save"));
          });
      };

      // Detect Collisions
      if (collisions.length) {
        ActiveLogger.info("Deterministic streams to be checked");

        // Store the promises to wait on.
        let streamColCheck: any[] = [];

        // Loop all streams
        collisions.forEach((streamId: string) => {
          // Query datastore for streams
          streamColCheck.push(this.db.get(streamId));
        });

        // Wait for all checks
        Promise.all(streamColCheck)
          .then((streams) => {
            // Problem Streams Exist
            ActiveLogger.debug(streams, "Deterministic Stream Name Exists");
            // Update commit
            this.nodeResponse.commit = false;
            this.raiseLedgerError(
              1530,
              new Error("Deterministic Stream Name Exists")
            );
          })
          .catch(() => {
            // Continue (Error being document not found)
            append();
          });
      } else {
        // Continue
        append();
      }
    } else {
      // processNoStreams()
    }
  }

  /**
   * Manages the permissions of revisions and signatures of each stream type
   *
   * @private
   * @param {string[]} check
   * @returns {Promise<any>}
   * @memberof Process
   */
  private permissionsCheck(inputs: boolean = true): Promise<any> {
    // Backwards compatibile will need to be managed here as stream wont exist
    // Then on "commit" phase we can create the stream file for this to work

    // Test the right object
    let check = this.inputs;
    if (!inputs) check = this.outputs;

    // Return as promise for execution
    return new Promise((resolve, reject) => {
      // Process all promises at "once"
      Promise.all(
        // Map all the objects to get their promises
        check.map((item) => {
          // Create promise to manage all revisions at once
          return new Promise((resolve, reject) => {
            this.db
              .allDocs({
                keys: [item + ":stream", item],
                include_docs: true
              })
              .then((docs: any) => {
                // Check Documents
                if (docs.rows.length === 3) {
                  // Get Documents
                  const [meta, state]: any = docs.rows as string[];

                  // Check meta
                  // Check Script Lock
                  let iMeta: ActiveDefinitions.IMeta = meta.doc as ActiveDefinitions.IMeta;
                  if (
                    iMeta.contractlock &&
                    iMeta.contractlock.length &&
                    iMeta.contractlock.indexOf(this.entry.$tx.$contract) === -1
                  ) {
                    // We have a lock but not for the current contract request
                    return reject({
                      code: 1700,
                      reason: "Stream contract locked"
                    });
                  }
                  // Check Namespace Lock
                  if (
                    iMeta.namespaceLock &&
                    iMeta.namespaceLock.length &&
                    iMeta.namespaceLock.indexOf(this.entry.$tx.$namespace) ===
                      -1
                  ) {
                    // We have a lock but not for the current contract request
                    return reject({
                      code: 1710,
                      reason: "Stream namespace locked"
                    });
                  }

                  // Resolve the whole stream
                  resolve({
                    meta: meta.doc,
                    state: state.doc
                  });
                } else {
                  reject({ code: 995, reason: "Stream(s) not found" });
                }
              })
              .catch((error: any) => {
                // Add Info
                error.code = 990;
                error.reason = "Stream(s) not found";
                // Rethrow
                reject(error);
              });
          });
        })
      )
        // Now have all the streams to process from the database
        .then((stream: ActiveDefinitions.LedgerStream[]) => {
          // All streams documents, May need to convert to promises but all this code is sync
          let i = stream.length;
          while (i--) {
            // Quick Reference
            let streamId: string = (stream[i].state as any)._id as string;

            // Get Revision type
            let revType = this.entry.$revs.$i;
            if (!inputs) revType = this.entry.$revs.$o;

            // Check or set Revisions
            if (this.checkRevs) {
              if (
                revType[streamId] !==
                (stream[i].meta._rev as any) +
                  ":" +
                  (stream[i].state._rev as any)
              )
                // Break loop and reject
                return reject({
                  code: 1200,
                  reason:
                    (inputs ? "Input" : "Output") + " Stream Position Incorrect"
                });
            } else {
              revType[streamId] =
                (stream[i].meta._rev as any) +
                ":" +
                (stream[i].state._rev as any);
            }

            // Signature Check & Hardened Keys (Inputs and maybe Outputs based on configuration)
            if (
              inputs ||
              ActiveOptions.get<any>("security", {}).signedOutputs
            ) {
              // Authorities need to be check flag
              let nhpkCheck = false;
              // Label or Key support
              let nhpkCheckIO = inputs ? this.entry.$tx.$i : this.entry.$tx.$o;
              // Check to see if key hardening is enabled and done
              if (ActiveOptions.get<any>("security", {}).hardenedKeys) {
                // Maybe specific authority of the stream now, $nhpk could be string or object of strings
                // Need to map over because it may not be stream id!
                if (
                  !nhpkCheckIO[this.shared.getLabelIOMap(inputs, streamId)]
                    .$nhpk
                ) {
                  return reject({
                    code: 1230,
                    reason:
                      (inputs ? "Input" : "Output") +
                      " Security Hardened Key Transactions Only"
                  });
                } else {
                  // Now need to check if $nhpk is nested with authorities
                  nhpkCheck = true;
                }
              }

              // Now can check signature
              if ((stream[i].meta as any).authorities) {
                // Some will return true early. At this stage we only need 1
                // The Smart contract developer can use the other signatures to create
                // a mini consensus within their own application (Such as ownership)

                if (
                  ActiveDefinitions.LedgerTypeChecks.isLedgerAuthSignatures(
                    this.entry.$sigs[streamId]
                  )
                ) {
                  // Multiple signatures passed
                  // Check that they haven't sent more signatures than we have authorities
                  let sigStreamKeys = Object.keys(this.entry.$sigs[streamId]);
                  if (
                    sigStreamKeys.length >
                    (stream[i].meta as any).authorities.length
                  ) {
                    return reject({
                      code: 1225,
                      reason:
                        (inputs ? "Input" : "Output") +
                        " Incorrect Signature List Length"
                    });
                  }

                  // Loop over signatures
                  // Every supplied signature should exist and pass
                  if (
                    !sigStreamKeys.every((sigStream: string) => {
                      // Get Signature form tx object
                      const signature = (this.entry.$sigs[
                        streamId
                      ] as ActiveDefinitions.LedgerAuthSignatures)[sigStream];

                      // Have all the supplied keys given new public keys
                      if (nhpkCheck) {
                        if (
                          !nhpkCheckIO[
                            this.shared.getLabelIOMap(inputs, streamId)
                          ].$nhpk[sigStream]
                        ) {
                          return reject({
                            code: 1230,
                            reason:
                              (inputs ? "Input" : "Output") +
                              " Security Hardened Key Transactions Only"
                          });
                        }
                      }

                      // Loop authorities and find a match
                      return (stream[i].meta as any).authorities.some(
                        (authority: ActiveDefinitions.ILedgerAuthority) => {
                          // If matching hash do sig check
                          if (authority.hash == sigStream) {
                            return this.signatureCheck(
                              authority.public,
                              signature,
                              authority.type
                            );
                          } else {
                            return false;
                          }
                        }
                      );
                    })
                  ) {
                    // Break loop and reject
                    return reject({
                      code: 1228,
                      reason:
                        (inputs ? "Input" : "Output") +
                        " Signature List Incorrect"
                    });
                  }
                } else {
                  // Only one signature passed (Do not need to check for nhpk as its done above with 1:1)
                  if (
                    !(stream[i].meta as any).authorities.some(
                      (authority: ActiveDefinitions.ILedgerAuthority) => {
                        if (
                          authority.hash &&
                          this.signatureCheck(
                            authority.public,
                            this.entry.$sigs[streamId] as string,
                            authority.type
                          )
                        ) {
                          // Check for new keys for this authority
                          if (nhpkCheck) {
                            if (
                              !nhpkCheckIO[
                                this.shared.getLabelIOMap(inputs, streamId)
                              ].$nhpk
                            ) {
                              return reject({
                                code: 1230,
                                reason:
                                  (inputs ? "Input" : "Output") +
                                  " Security Hardened Key Transactions Only"
                              });
                            }
                          }

                          // Remap $sigs for later consumption
                          this.entry.$sigs[streamId] = {
                            [authority.hash]: this.entry.$sigs[
                              streamId
                            ] as string
                          };
                          return true;
                        }
                        return false;
                      }
                    )
                  ) {
                    // Break loop and reject
                    return reject({
                      code: 1220,
                      reason:
                        (inputs ? "Input" : "Output") + " Signature Incorrect"
                    });
                  }
                }
              } else {
                // Backwards Compatible Check
                if (
                  !this.signatureCheck(
                    (stream[i].meta as any).public,
                    this.entry.$sigs[streamId] as string,
                    (stream[i].meta as any).type
                      ? (stream[i].meta as any).type
                      : "rsa"
                  )
                ) {
                  // Break loop and reject
                  return reject({
                    code: 1220,
                    reason:
                      (inputs ? "Input" : "Output") + " Signature Incorrect"
                  });
                }
              }
            }
          }
          // Everything is good
          resolve(stream);
        })
        .catch((error) => {
          // Rethrow error
          reject(error);
        });
    });
  }

  /**
   * Fetches streams for read only consumption
   *
   * @private
   * @returns {Promise<boolean>}
   * @memberof Process
   */
  private getReadOnlyStreams(): Promise<ActiveDefinitions.LedgerIORputs> {
    return new Promise((resolve, reject) => {
      // Holds the read only stream data
      let readonlyStreams: ActiveDefinitions.LedgerIORputs = {};

      if (this.entry.$tx.$r) {
        // Reference for solving linter errors
        let readOnly = this.entry.$tx.$r;
        // Get Index
        let keyRefs = Object.keys(readOnly);

        Promise.all(
          // Map all the objects to get their promises
          keyRefs.map((reference) => {
            // Create promise to manage all revisions at once
            return new Promise((resolve, reject) => {
              // Get Meta data
              this.db
                .get(readOnly[reference])
                .then((read: any) => {
                  // Remove _id and _rev
                  delete read._id;
                  delete read._rev;

                  // Overwrite reference with state
                  readonlyStreams[reference] = read;
                  resolve(read);
                })
                .catch((error: Error) => {
                  // Rethrow
                  reject(error);
                });
            });
          })
        )
          .then(() => {
            // Shoudln't need to do anything as reference object has been updated
            resolve(readonlyStreams);
          })
          .catch((error) => {
            // Rethrow
            reject(error);
          });
      } else {
        resolve(readonlyStreams);
      }
    });
  }

  /**
   * Validate signature for the transaction
   *
   * @private
   * @param {string} publicKey
   * @param {string} signature
   * @param {string} rsa
   * @returns {boolean}
   * @memberof Process
   */
  private signatureCheck(
    publicKey: string,
    signature: string,
    type: string = "rsa"
  ): boolean {
    try {
      // Get Key Object
      let key: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair(type, publicKey);

      // Return Valid or not
      return key.verify(this.entry.$tx, signature);
    } catch (error) {
      ActiveLogger.error(error, "Signature Check Error");
      return false;
    }
  }

  /**
   * Transaction $i/o type for stream names
   * Which $i/o lookup are we using. Are they labelled or stream names
   *
   * @private
   * @param {boolean} [outputs=false]
   * @memberof Process
   */
  private labelOrKey(outputs: boolean = false): void {
    // Get reference for input or output
    const streams = outputs ? this.outputs : this.inputs;
    const txIO = outputs ? this.entry.$tx.$o : this.entry.$tx.$i;
    const map = outputs ? this.shared.ioLabelMap.o : this.shared.ioLabelMap.i;

    // Check the first one, If labelled then loop all.
    // Means first has to be labelled but we don't want to loop when not needed
    if (txIO[streams[0]].$stream) {
      for (let i = 0; i < streams.length; i++) {
        // Stream label or self
        let streamId = txIO[streams[i]].$stream || streams[i];
        map[streamId] = streams[i];
        streams[i] = streamId;
      }
    }
  }

  /**
   * Creates a smaler trasnaction entry for ledger walking. This will also
   * keep the value deterministic (not including nodes)
   *
   * @private
   * @returns
   * @memberof Process
   */
  private compactTxEntry() {
    return {
      $umid: this.entry.$umid,
      $tx: this.entry.$tx,
      $sigs: this.entry.$sigs,
      $revs: this.entry.$revs,
      $selfsign: this.entry.$selfsign ? this.entry.$selfsign : false
    };
  }

  /**
   * Clears all Internode Communication if contract requests
   *
   * @private
   * @memberof Process
   */
  private clearAllComms(virtualMachine: IVirtualMachine) {
    if (virtualMachine.clearingInternodeCommsFromVM(this.entry.$umid)) {
      Object.values(this.entry.$nodes).forEach((node: any) => {
        node.incomms = null;
      });
    }
  }

  /**
   * Manage all errors from the Process & VM to put into the activerestore. So activerestore
   * can verify if it failed due to local coniditions or just a bad entry
   *
   * @private
   * @param {number} code
   * @param {Error} reason
   * @param {Boolean} [stop]
   * @memberof Process
   */
  private raiseLedgerError(
    code: number,
    reason: Error,
    stop: Boolean = false,
    priority: number = 0
  ): void {
    // Store in database for activesrestore to review
    this.storeError(code, reason, priority)
      .then(() => {
        // Emit failed event for execution
        if (!stop) {
          this.emit("failed", {
            status: this.errorOut.code,
            error: this.errorOut.reason
          });
        }
      })
      .catch((error) => {
        // Problem could be serious (Database down?)
        // However if this errors we need to just emit to let the ledger continue
        ActiveLogger.fatal(error, "Database Error Log Issues");

        // Emit failed event for execution
        if (!stop) {
          this.emit("failed", {
            status: code,
            error: error
          });
        }
      });
  }

  /**
   * Store Error into Database
   * TODO: Defer storing into the database until after execution or on crash
   *
   * @private
   * @param {number} code
   * @param {Error} reason
   * @param {number} priority
   * @returns {Promise<any>}
   * @memberof Process
   */
  private storeError(
    code: number,
    reason: Error,
    priority: number = 0
  ): Promise<any> {
    // Only want to send 1 error to the browser as well.
    // As we may only need to store one we may need to manage Contract errors
    if (priority >= this.errorOut.priority) {
      this.errorOut.code = code;
      this.errorOut.reason = (reason && reason.message
        ? reason.message
        : reason) as string;
      this.errorOut.priority = priority;
    }

    if (!this.storeSingleError && this.entry) {
      // Build Document for couch
      let doc = {
        code: code,
        processed: this.storeSingleError,
        umid: this.entry.$umid, // Easier umid lookup
        transaction: this.entry,
        reason: reason && reason.message ? reason.message : reason
      };

      // Now if we store another error it wont be prossed
      this.storeSingleError = true;

      // Return
      return this.dbe.post(doc);
    } else {
      return Promise.resolve();
    }
  }
}
