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

/**
 * Class controls the processing of this nodes consensus
 *
 * @export
 * @class Process
 * @extends {EventEmitter}
 */
export class Process extends EventEmitter {
  /**
   * Hosts the VM instance
   *
   * @private
   * @type {VirtualMachine}
   * @memberof Process
   */
  private static generalContractVM: VirtualMachine;

  private static defaultContractsVM: VirtualMachine;

  private static singleContractVMHolder: IVMContractHolder;

  private isDefault: boolean = false;

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
   * Maps streamId to their labels
   *
   * @private
   * @memberof Process
   */
  private ioLabelMap: any = { i: {}, o: {} };

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

    // Reference node response
    this.nodeResponse = entry.$nodes[reference];

    // We don't need to verify the code unless we suspect server has been
    // comprimised. We will verify with the "install" routine
    // TODO: Fix temp path solution (Param? PATH? Global?)
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
  public destroy(): void {
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
    (Process.generalContractVM as any) = null;
    (this.entry as any) = null;
  }

  /**
   * Starts the consensus and commit phase processing
   *
   * @memberof Process
   */
  public async start() {
    ActiveLogger.info("New TX : " + this.entry.$umid);
    ActiveLogger.debug(this.entry, "Starting TX");

    // Compiled Contracts sit in another location
    if (this.entry.$tx.$namespace == "default") {
      // Default Contract Location
      this.contractLocation = `${ActiveOptions.get("__base", "./")}/contracts/${
        this.entry.$tx.$namespace
      }/${this.entry.$tx.$contract}.js`;
    } else {
      // Ledger Transpiled Contract Location
      this.contractLocation = `${process.cwd()}/contracts/${
        this.entry.$tx.$namespace
      }/${this.entry.$tx.$contract}.js`;
    }

    // Get contract file (Or From Database)
    if (fs.existsSync(this.contractLocation)) {
      // Now we know we can execute the contract now or more costly cpu checks
      ActiveLogger.debug("Fetching Inputs");

      // Build Inputs Key Maps (Reference is Stream)
      this.inputs = Object.keys(this.entry.$tx.$i || {});

      // We must have inputs (New Inputs can create brand new unknown outputs)
      if (!this.inputs.length)
        this.raiseLedgerError(1101, new Error("Inputs cannot be null"));

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

        // Check the input revisions
        this.permissionsCheck()
          .then((inputStreams: ActiveDefinitions.LedgerStream[]) => {
            // Check the output revisions
            this.permissionsCheck(false)
              .then((outputStreams: ActiveDefinitions.LedgerStream[]) => {
                this.process(inputStreams, outputStreams);
              })
              .catch((error) => {
                // Forward Error On
                // We may not have the output stream, So we need to pass over the knocks
                this.postVote({
                  code: error.code,
                  reason: error.reason || error.message
                });
              });
          })
          .catch((error) => {
            // Forward Error On
            // We may not have the input stream, So we need to pass over the knocks
            this.postVote({
              code: error.code,
              reason: error.reason || error.message
            });
          });
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

            // Make sure we have an input (Can Skip otherwise maybe onboarded)
            if (input) {
              // Check the input has a public key
              if (input.publicKey) {
                if (
                  !this.signatureCheck(
                    input.publicKey,
                    signature as string,
                    input.type ? input.type : "rsa"
                  )
                ) {
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
              return this.raiseLedgerError(
                1245,
                new Error("Self signed signature missing input pairing")
              );
            }
          }
        }

        // No input streams, Maybe Output
        this.permissionsCheck(false)
          .then((outputStreams: ActiveDefinitions.LedgerStream[]) => {
            this.process([], outputStreams);
          })
          .catch((error) => {
            // Forward Error On
            this.postVote({
              code: error.code,
              reason: error.reason || error.message
            });
          });
      }
    } else {
      // Contract not found
      this.postVote({
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
      this.commit();
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

  private processDefaultContracts(
    payload: IVMDataPayload,
    contractName: string
  ) {
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
        console.trace("Debug A");
        throw new Error(error);
      }
    }

    this.handleVM(Process.defaultContractsVM, payload, contractName);
  }

  private processUnsafeContracts(
    payload: IVMDataPayload,
    contractName: string,
    extraBuiltins: string[]
  ) {
    this.contractRef = contractName + Date.now();

    try {
      Process.singleContractVMHolder[this.contractRef] = new VirtualMachine(
        this.selfHost,
        this.secured,
        this.db,
        this.dbev
      );

      Process.singleContractVMHolder[this.contractRef].initialiseVirtualMachine(
        extraBuiltins
      );
    } catch (error) {
      throw new Error(error);
    }

    this.handleVM(
      Process.singleContractVMHolder[this.contractRef],
      payload,
      contractName
    );
  }

  private handleVM(
    virtualMachine: IVirtualMachine,
    payload: IVMDataPayload,
    contractName: string
  ) {
    console.log("Debug 0 - Pre Init");
    // Initalise contract VM
    virtualMachine
      .initialise(payload, contractName)
      .then(() => {
        console.log("Debug 1 - After init");
        // Verify Transaction details in the contract
        // Also allow the contract to verify it likes signatureless transactions
        virtualMachine
          .verify(this.entry.$selfsign, this.entry.$umid)
          .then(() => {
            console.log("Debug 2 - After Verify");
            // Get Vote (May change to string as it can contain the reason)
            // Or in the VM we can catch any thrown errors messages
            virtualMachine
              .vote(this.entry.$umid)
              .then(() => {
                console.log("Debug 3 - After Vote");
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
                this.clearAllComms();

                // Continue to next nodes vote
                this.postVote();
              })
              .catch((error: Error) => {
                // Vote failed (Not and error continue casting vote on the network)
                ActiveLogger.debug(error, "Vote Failure");

                // Update errors (Dont know what the contract will reject as so string)
                this.storeError(
                  1000,
                  new Error("Vote Failure - " + JSON.stringify(error)),
                  10
                )
                  .then(() => {
                    // Continue Execution of consensus
                    // Update Error
                    this.nodeResponse.error = error.message;

                    // Continue to next nodes vote
                    this.postVote();
                  })
                  .catch((error) => {
                    // Continue Execution of consensus even with this failing
                    // Just add a fatal message
                    ActiveLogger.fatal(error, "Voting Error Log Issues");

                    // Update Error
                    this.nodeResponse.error = error;

                    // Continue to next nodes vote
                    this.postVote();
                  });
              });
          })
          .catch((error) => {
            ActiveLogger.debug(error, "Verify Failure");
            // Verification Failure
            this.raiseLedgerError(1310, new Error(error));
          });
      })
      .catch((e) => {
        // Contract not found / failed to start
        ActiveLogger.debug(e, "VM initialisation failed");
        this.raiseLedgerError(
          1401,
          new Error("VM Init Failure - " + JSON.stringify(e.message || e))
        );
      });
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
  private process(inputs: ActiveDefinitions.LedgerStream[]): void;
  private process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[]
  ): void;
  private process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[] = []
  ): void {
    this.getReadOnlyStreams()
      .then((readonly) => {
        ActiveLogger.info("Beginning contract execution");

        const loadedContractString = fs.readFileSync(
          this.contractLocation,
          "utf-8"
        );

        const contractName = this.contractLocation.substr(
          this.contractLocation.lastIndexOf("/") + 1
        );

        const payload: IVMDataPayload = {
          contractString: loadedContractString,
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

        if (payload.transaction.$namespace === "default") {
          console.log("Debug - Is Default contract");
          this.processDefaultContracts(payload, contractName);
        } else {
          // Now check configuration for allowed standard libs for this namespace
          const security = ActiveOptions.get<any>("security", {});
          const builtin: string[] = [];
          // Check to see if this namespace exists
          if (
            security.namespace &&
            security.namespace[payload.transaction.$namespace]
          ) {
            console.log("Debug - Is unsafe contract");
            security.namespace[payload.transaction.$namespace].std.forEach(
              (item: string) => {
                // Add to builtin VM
                builtin.push(item);
              }
            );
            this.processUnsafeContracts(payload, contractName, builtin);
          } else {
            console.log("Debug - Is normal contract");
            this.handleVM(Process.generalContractVM, payload, contractName);
          }
        }
      })
      .catch(() => {
        // error fetch read only streams
        this.raiseLedgerError(1210, new Error("Read Only Stream Error"));
      });
  }

  /**
   * Manages the protocol process after this node has voted
   *
   * @private
   * @memberof Process
   */
  private postVote(error: any = false): void {
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
      this.emit("broadcast", this.entry);

      // Check we will be commiting (So we don't process as failed tx)
      if (this.canCommit()) {
        // Try run commit! (May have reach consensus here)
        this.commit();
      }
    } else {
      // Knock our right neighbour with this trasnaction if they are not the origin
      if (this.right.reference != this.entry.$origin) {
        // Send back early if consensus has been reached and not the end of the network
        // (Early commit, Then Forward to network)
        this.commit(() => {
          this.right
            .knock("init", this.entry)
            .then((response: any) => {
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
              this.commit();
            })
            .catch((error: any) => {
              // Need to manage errors this would mean the node is unreachable
              ActiveLogger.debug(error, "Knock Failure");

              // if debug mode forward
              // IF error has status and error this came from another node which has erroed (not unreachable)
              if (ActiveOptions.get<boolean>("debug", false)) {
                // rethrow same error
                this.raiseLedgerError(
                  error.status || 1502,
                  new Error(error.error)
                );
              } else {
                // Generic error 404/ 500
                this.raiseLedgerError(1501, new Error("Bad Knock Transaction"));
              }
            });
        });
      } else {
        ActiveLogger.debug("Origin is next (Sending Back)");
        if (error) {
          // Ofcourse if next is origin we need to send back for the promises!
          this.raiseLedgerError(error.code, error.reason);
        } else {
          // Run the Commit Phase
          this.commit();
        }
      }
    }
  }

  /**
   * Decides if consensus has been reached for commit phase to start
   *
   * @private
   * @returns {boolean}
   * @memberof Process
   */
  private canCommit(): boolean {
    // Time to count the votes (Need to recache keys)
    let networkNodes: string[] = Object.keys(this.entry.$nodes);
    let i = networkNodes.length;
    this.currentVotes = 0;

    // Small performance boost if we voted no
    if (this.nodeResponse.vote) {
      while (i--) {
        if (this.entry.$nodes[networkNodes[i]].vote) this.currentVotes++;
      }
    }

    // Return if consensus has been reached
    return (
      (this.nodeResponse.vote &&
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
   * @param {() => void} [earlyCommit]
   * @returns {void}
   * @memberof Process
   */
  private commit(earlyCommit?: () => void): void {
    // If we haven't commited process as normal
    if (!this.nodeResponse.commit) {
      // check we can commit still
      if (this.canCommit()) {
        // Consensus reached commit phase
        this.commiting = true;
        // Pass Nodes for possible INC injection
        Process.generalContractVM
          .commit(
            this.entry.$nodes,
            this.entry.$territoriality == this.reference,
            this.entry.$umid
          )
          .then(() => {
            // Update Commit Entry
            this.nodeResponse.commit = true;

            // Update in communication (Recommended pre commit only but can be edge use cases)
            this.nodeResponse.incomms = Process.generalContractVM.getInternodeCommsFromVM(
              this.entry.$umid
            );

            // Return Data for this nodes contract run
            this.nodeResponse.return = Process.generalContractVM.getReturnContractData(
              this.entry.$umid
            );

            // Clearing All node comms?
            this.clearAllComms();

            // Are we throwing to another ledger(s)?
            let throws = Process.generalContractVM.getThrowsFromVM(
              this.entry.$umid
            );

            // Emit to network handler
            if (throws && throws.length) {
              this.emit("throw", { locations: throws });
            }

            // Get the changed data streams
            let streams: ActiveDefinitions.LedgerStream[] = Process.generalContractVM.getActivityStreamsFromVM(
              this.entry.$umid
            );

            // Get current working inputs to compare and update if not modified above
            let inputs: ActiveDefinitions.LedgerStream[] = Process.generalContractVM.getInputs(
              this.entry.$umid
            );

            let skip: string[] = [];

            // Determanistic Collision Managamenent
            let collisions: any[] = [];

            // Compile streams for umid & return reference
            let refStreams = {
              new: [] as any[],
              updated: [] as any[]
            };

            // Cache Harden Key Flag
            let nhkCheck = ActiveOptions.get<any>("security", {})
              .hardenedKeys as boolean;

            // Any Changes
            if (streams.length) {
              // Process Changes to the database
              // Bulk Insert Docs
              let docs: any[] = [];

              // Loop Streams
              let i = streams.length;
              while (i--) {
                // New or Updating?
                if (!streams[i].meta._rev) {
                  // Make sure we have an id
                  if (!streams[i].meta._id) {
                    // New (Need to set ids)
                    streams[i].state._id = this.entry.$umid + i;
                    streams[i].meta._id = streams[i].state._id + ":stream";
                    streams[i].volatile._id =
                      streams[i].state._id + ":volatile";
                  }

                  // Need to add transaction to all meta documents
                  streams[i].meta.txs = [this.entry.$umid];
                  // Also set as intalisiser stream (stream constructor)
                  streams[i].meta.$constructor = true;

                  // Need to remove rev
                  delete streams[i].state._rev;
                  delete streams[i].meta._rev;
                  delete streams[i].volatile._rev;

                  // New Streams need to check if collision will happen
                  if (streams[i].meta.umid !== this.entry.$umid) {
                    collisions.push(streams[i].meta._id);
                  }

                  // Add to reference
                  refStreams.new.push({
                    id: streams[i].state._id,
                    name: streams[i].meta.name
                  });
                } else {
                  // Updated Streams, These could be inputs
                  // So update the transaction and remove for inputs for later processing
                  if (streams[i].meta.txs && streams[i].meta.txs.length) {
                    streams[i].meta.txs.push(this.entry.$umid);
                    skip.push(streams[i].meta._id as string);
                  }

                  // Hardened Keys?
                  if (streams[i].state._id && nhkCheck) {
                    // Get nhpk
                    let nhpk = this.entry.$tx.$i[
                      this.getLabelIOMap(true, streams[i].state._id as string)
                    ].$nhpk;

                    // Loop Signatures as they should be rewritten with authoritied nested
                    // That way if any new auths were added they will be skipped
                    let txSigAuthsKeys = Object.keys(
                      this.entry.$sigs[streams[i].state._id as string]
                    );

                    // Loop all authorities to try and find a match
                    streams[i].meta.authorities.forEach(
                      (authority: ActiveDefinitions.ILedgerAuthority) => {
                        // Get tx auth signature if existed
                        const txSigAuthKey = txSigAuthsKeys.indexOf(
                          authority.hash as string
                        );
                        if (txSigAuthKey !== -1) {
                          (authority as any).public =
                            nhpk[txSigAuthsKeys[txSigAuthKey]];
                        }
                      }
                    );
                  }

                  // Add to reference
                  refStreams.updated.push({
                    id: streams[i].state._id,
                    name: streams[i].meta.name
                  });
                }

                // Data State (Developers Control)
                if (streams[i].state._id) docs.push(streams[i].state);

                // Meta (Stream Data) for internal usage
                if (streams[i].meta._id) docs.push(streams[i].meta);

                // Volatile data which cannot really be trusted
                if (streams[i].volatile._id) docs.push(streams[i].volatile);
              }

              // Any inputs left (Means not modified, Unmodified outputs can be ignored)
              // Now we need to append transaction to the inputs of the transaction
              if (inputs && inputs.length) {
                // Add to all docs
                let i = inputs.length;
                while (i--) {
                  if (
                    skip.indexOf(inputs[i].meta._id as string) === -1 &&
                    inputs[i].meta.txs &&
                    inputs[i].meta.txs.length
                  ) {
                    // Add Compact Transaction
                    inputs[i].meta.txs.push(this.entry.$umid);

                    // Hardened Keys?
                    if (inputs[i].state._id && nhkCheck) {
                      // Get nhpk
                      let nhpk = this.entry.$tx.$i[
                        this.getLabelIOMap(true, inputs[i].state._id as string)
                      ].$nhpk;

                      // Loop Signatures as they should be rewritten with authoritied nested
                      // That way if any new auths were added they will be skipped
                      let txSigAuthsKeys = Object.keys(
                        this.entry.$sigs[inputs[i].state._id as string]
                      );

                      // Loop all authorities to try and find a match
                      inputs[i].meta.authorities.forEach(
                        (authority: ActiveDefinitions.ILedgerAuthority) => {
                          // Get tx auth signature if existed
                          const txSigAuthKey = txSigAuthsKeys.indexOf(
                            authority.hash as string
                          );
                          if (txSigAuthKey !== -1) {
                            (authority as any).public =
                              nhpk[txSigAuthsKeys[txSigAuthKey]];
                          }
                        }
                      );
                    }

                    // Push to docs (Only Meta)
                    docs.push(inputs[i].meta);
                  }
                }
              }

              // Create umid document containing the transaction details
              docs.push({
                _id: this.entry.$umid + ":umid",
                umid: this.compactTxEntry(),
                streams: refStreams
              });

              /**
               * Delegate Function
               * Attempt to atomicaly save to the datastore
               * Allow for delay execution for deterministic test
               */
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
                    Process.generalContractVM
                      .postProcess(
                        this.entry.$territoriality == this.reference,
                        this.entry.$territoriality,
                        this.entry.$umid
                      )
                      .then((post) => {
                        this.nodeResponse.post = post;

                        // Update in communication (Recommended pre commit only but can be edge use cases)
                        this.nodeResponse.incomms = Process.generalContractVM.getInternodeCommsFromVM(
                          this.entry.$umid
                        );

                        // Return Data for this nodes contract run
                        this.nodeResponse.return = Process.generalContractVM.getReturnContractData(
                          this.entry.$umid
                        );

                        // Clearing All node comms?
                        this.clearAllComms();

                        // Remember to let other nodes know
                        if (earlyCommit) earlyCommit();

                        // Respond with the possible early commited
                        this.emit("commited", { tx: this.compactTxEntry() });
                      })
                      .catch((error: Error) => {
                        // Don't let local error stop other nodes
                        if (earlyCommit) earlyCommit();

                        // Ignore errors for now, As commit was still a success
                        this.emit("commited", { tx: this.compactTxEntry() });
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
                    ActiveLogger.debug(
                      streams,
                      "Deterministic Stream Name Exists"
                    );
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
              // Nothing to store which is _no longer_ strange contract may not make changes!
              // Were we first?
              if (!this.entry.$territoriality)
                this.entry.$territoriality = this.reference;

              // Manage Post Processing (If Exists)
              Process.generalContractVM
                .postProcess(
                  this.entry.$territoriality == this.reference,
                  this.entry.$territoriality,
                  this.entry.$umid
                )
                .then((post) => {
                  this.nodeResponse.post = post;

                  // Update in communication (Recommended pre commit only but can be edge use cases)
                  this.nodeResponse.incomms = Process.generalContractVM.getInternodeCommsFromVM(
                    this.entry.$umid
                  );

                  // Return Data for this nodes contract run
                  this.nodeResponse.return = Process.generalContractVM.getReturnContractData(
                    this.entry.$umid
                  );

                  // Clearing All node comms?
                  this.clearAllComms();

                  // Remember to let other nodes know
                  if (earlyCommit) earlyCommit();

                  // Respond with the possible early commited
                  this.emit("commited", { tx: this.compactTxEntry() });
                })
                .catch((error) => {
                  // Don't let local error stop other nodes
                  if (earlyCommit) earlyCommit();
                  // Ignore errors for now, As commit was still a success
                  this.emit("commited", { tx: this.compactTxEntry() });
                });
            }
          })
          .catch((error) => {
            // Don't let local error stop other nodes
            if (earlyCommit) earlyCommit();
            ActiveLogger.debug(error, "VM Commit Failure");

            // If debug mode forward full error
            if (ActiveOptions.get<boolean>("debug", false)) {
              this.raiseLedgerError(
                1302,
                new Error(
                  "Commit Failure - " + JSON.stringify(error.message || error)
                )
              );
            } else {
              this.raiseLedgerError(
                1301,
                new Error("Failed Commit Transaction")
              );
            }
          });
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

          // Because we voted no doesn't mean the network should error
          this.emit("commited");
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
      this.emit("commited");
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
            // Get Meta data
            this.db
              .get(item + ":stream")
              .then((meta: any) => {
                // Check Script Lock
                let iMeta: ActiveDefinitions.IMeta = meta as ActiveDefinitions.IMeta;
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
                  iMeta.namespaceLock.indexOf(this.entry.$tx.$namespace) === -1
                ) {
                  // We have a lock but not for the current contract request
                  return reject({
                    code: 1710,
                    reason: "Stream namespace locked"
                  });
                }

                // Got the meta, Now for real stream
                this.db
                  .get(item)
                  .then((state: any) => {
                    // Got the state now for volatile
                    this.db
                      .get(item + ":volatile")
                      .then((volatile: any) => {
                        // Resolve the whole stream
                        resolve({
                          meta: meta,
                          state: state,
                          volatile: volatile
                        });
                      })
                      .catch((error: any) => {
                        // Add Info
                        error.code = 960;
                        error.reason = "Volatile not found";
                        // Rethrow
                        reject(error);
                      });
                  })
                  .catch((error: any) => {
                    // Add Info
                    error.code = 960;
                    error.reason = "State not found";
                    // Rethrow
                    reject(error);
                  });
              })
              .catch((error: any) => {
                // Add Info
                error.code = 950;
                error.reason = "Stream not found";
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
            let streamId: string = (stream[i].meta as any)._id as string;

            // Remove :stream
            streamId = streamId.substring(0, streamId.length - 7);

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
              // let nhpkCheckIOMap = inputs
              //   ? this.ioLabelMap.i
              //   : this.ioLabelMap.o;
              let nhpkCheckIO = inputs ? this.entry.$tx.$i : this.entry.$tx.$o;
              // Check to see if key hardening is enabled and done
              if (ActiveOptions.get<any>("security", {}).hardenedKeys) {
                // Maybe specific authority of the stream now, $nhpk could be string or object of strings
                // Need to map over because it may not be stream id!
                if (!nhpkCheckIO[this.getLabelIOMap(inputs, streamId)].$nhpk) {
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
                          !nhpkCheckIO[this.getLabelIOMap(inputs, streamId)]
                            .$nhpk[sigStream]
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
                              !nhpkCheckIO[this.getLabelIOMap(inputs, streamId)]
                                .$nhpk
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
    // Get Reference for inputs
    let streams = this.inputs;
    let txIO = this.entry.$tx.$i;
    let map = this.ioLabelMap.i;

    // Override for outputs
    if (outputs) {
      streams = this.outputs;
      txIO = this.entry.$tx.$o;
      map = this.ioLabelMap.o;
    }

    // Check the first one, If labelled then loop all.
    // Means first has to be labelled but we don't want to loop when not needed
    if (txIO[streams[0]].$stream) {
      let i = streams.length;
      while (i--) {
        // Stream label or self
        let streamId = txIO[streams[i]].$stream || streams[i];
        map[streamId] = streams[i];
        streams[i] = streamId;
      }
    }
  }

  /**
   * Get the correct input for Label or key
   *
   * @private
   * @param {boolean} inputs
   * @param {string} streamId
   * @returns {string}
   * @memberof Process
   */
  private getLabelIOMap(inputs: boolean, streamId: string): string {
    // Get Correct Map
    let checkIOMap = inputs ? this.ioLabelMap.i : this.ioLabelMap.o;

    // If map empty default to key stream
    if (!Object.keys(checkIOMap).length) {
      return streamId;
    }
    return checkIOMap[streamId];
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
  private clearAllComms() {
    if (
      Process.generalContractVM.clearingInternodeCommsFromVM(this.entry.$umid)
    ) {
      Object.values(this.entry.$nodes).forEach((node) => {
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

    if (!this.storeSingleError) {
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
