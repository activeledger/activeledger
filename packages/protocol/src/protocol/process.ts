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
  IVirtualMachine,
} from "./interfaces/vm.interface";
import { ISecurityCache } from "./interfaces/process.interface";
import { Shared } from "./shared";
import { StreamUpdater } from "./streamUpdater";
import { PermissionsChecker } from "./permissionsChecker";
import path from "path";

const BROADCAST_TIMEOUT_VOTE = 30 * 1000;
const BROADCAST_TIMEOUT_COMMIT = 60 * 1000;

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
   * Cache total nodes in network
   * TODO: When increasing nodes on attest we need to adjust this cache
   *
   * @private
   * @static
   */
  private static networkNodeLength = 0;

  /**
   * Holds the instance that controls general contracts
   *
   * @private
   * @type {VirtualMachine}
   */
  private static generalContractVM: VirtualMachine;

  /**
   * Holds the instance that controls the default contracts (anything in the default namespace)
   *
   * @private
   * @static
   * @type {VirtualMachine}
   */
  //private static defaultContractsVM: VirtualMachine;

  /**
   * Holds an object of individual VM controller instances for unsafe contracts
   * Unsafe contracts are separated by namespace, so these instances will still run multiple contracts
   *
   * @private
   * @static
   * @type {IVMContractHolder}
   */
  //private static singleContractVMHolder: IVMContractHolder = {};

  /**
   * Is this instance of Process dealing with a default contract
   *
   * @private
   * @type {boolean}
   */
  private isDefault: boolean = false;

  /**
   * A reference to a contract in singleContractVMHolder, via namespace
   *
   * @private
   * @type {string}
   */
  private contractRef: string;

  /**
   * Holds string reference of inputs streams
   *
   * @private
   * @type {string[]}
   */
  private inputs: string[];

  /**
   * Holds string reference of output streams
   *
   * @private
   * @type {string[]}
   */
  private outputs: string[];

  /**
   * Flag for checking or setting revisions
   *
   * @private
   * @type {boolean}
   */
  //private checkRevs: boolean = true;

  /**
   * Contains reference to this nodes node response
   *
   * @private
   * @type {ActiveDefinitions.INodeResponse}
   */
  private nodeResponse: ActiveDefinitions.INodeResponse;

  /**
   * Default Contracts & Compiled Contracts are in differntlocations
   *
   * @private
   * @type {string}
   */
  private contractLocation: string;

  /**
   * The ID of the contract being called
   * Used for contract:data hanlding
   *
   * @private
   * @type {string}
   */
  private contractId: string;

  /**
   * Commiting State
   *
   * @private
   */
  private commiting = false;

  /**
   *  Voting State
   *
   * @private
   */
  private voting = true;

  /**
   * So we only restore once per tx
   * we use this as a flag for the storeError
   *
   * @private
   */
  private storeSingleError = false;

  /**
   * Prioritise the error sent to the requestee
   *
   * @private
   */
  private errorOut = {
    code: 0,
    reason: "",
    priority: 0,
  };

  /**
   * Holds the broadcast timeout object
   *
   * @private
   * @type {NodeJS.Timeout}
   */
  private broadcastTimeout: NodeJS.Timeout;

  /**
   * Current Voting Round
   *
   * @private
   * @type {number}
   */
  private currentVotes: number;

  /**
   * A cache of the secure namespaces
   *
   * @private
   * @type {string[]}
   */
  private securityCache: ISecurityCache | null;

  /**
   * Initialised shared class
   *
   * @private
   * @type {Shared}
   */
  private shared: Shared;

  /**
   * Permission checking class
   *
   * @private
   * @type {PermissionsChecker}
   */
  private permissionChecker: PermissionsChecker;

  /**
   * Holds the failed emit timer information
   *
   * @private
   * @type {NodeJS.Timeout}
   */
  private willEmit: NodeJS.Timeout;

  /**
   * The data that will be emitted as an error
   *
   * @private
   * @type {{ status: number; error: string }}
   */
  private willEmitData: { status: number; error: string | Error } | undefined;

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

    this.shared = new Shared(this.storeSingleError, this.entry, this.dbe, this);

    // Reference node response
    this.nodeResponse = entry.$nodes[reference];

    Process.networkNodeLength = ActiveOptions.get<Array<any>>(
      "neighbourhood",
      []
    ).length;

    try {
      // Initialise the general contract VM
      if (!Process.generalContractVM) {
        Process.generalContractVM = new VirtualMachine(
          this.selfHost,
          this.secured,
          this.db,
          this.dbev
        );

        Process.generalContractVM.initialiseVirtualMachine();
      }
    } catch (error) {
      throw new Error(error);
    }

    // Check if the security data has been cached
    //if (!this.securityCache) {
    this.securityCache = ActiveOptions.get<any>("security", null);
    //}

    // Initialise the permission checker
    this.permissionChecker = new PermissionsChecker(
      this.entry,
      this.db,
      //this.checkRevs,
      this.securityCache as ISecurityCache,
      this.shared
    );
  }

  /**
   * Destroy the process object from memory
   *
   */
  public destroy(umid: string): void {
    // Record un commited transactions as an error
    // No longer needed with "trust the network"
    // Keeping as comments for reference as we may need it but should already have an error log
    // try {
    //   if (!this.nodeResponse.commit) {
    //     this.shared.raiseLedgerError(
    //       1600,
    //       new Error("Failed to commit before timeout"),
    //       true
    //     );
    //   }
    // } catch (e) {
    //   // Something is wrong with node response, Lets still log and continue
    //   this.shared.raiseLedgerError(
    //     1605,
    //     new Error("Failed to commit lacking this node response"),
    //     true
    //   );
    // }

    if (this.entry.$broadcast) {
      // Make sure broadcast timeout is cleared
      clearTimeout(this.broadcastTimeout);

      Process.generalContractVM.destroy(umid);

      // Close VM and entry (cirular reference)
      // if (this.isDefault) {
      //   // DefaultVM created?
      //   if (Process.defaultContractsVM) Process.defaultContractsVM.destroy(umid);
      // } else {
      //   this.contractRef
      //     ? Process.singleContractVMHolder[this.contractRef].destroy(umid)
      //     : Process.generalContractVM.destroy(umid);
      // }

      // Quick solution to delete rules
      delete (this as any).entry;
    } else {
      // early commit calls this to soon so can't send on so simple timeout
      setTimeout(() => {
        Process.generalContractVM.destroy(umid);
        delete (this as any).entry;
      }, 60000);
    }
  }

  /**
   * Semver sorting for latest file detection
   *
   * @private
   * @param {string} a
   * @param {string} b
   * @returns
   */
  private sortVersions(a: string, b: string) {
    const padSorting = (v: string) => {
      return v
        .split(".")
        .map((p: string) => {
          return "00000000".substring(0, 8 - p.length) + p;
        })
        .join(".");
    };

    return padSorting(a).localeCompare(padSorting(b));
  }

  private contractPathCache: {
    [index: string]: string;
  } = {};

  /**
   * Starts the consensus and commit phase processing
   *
   */
  public async start(contractVersion?: string) {
    ActiveLogger.debug("New TX : " + this.entry.$umid);

    // Compiled Contracts sit in another location
    const setupDefaultLocation = () => {
      // Set isDefault flag to true
      this.isDefault = true;

      // Default Contract Location
      // Wrapped in realpathSync to resolve symbolic links
      // This prevents issues with cached contracts
      this.contractLocation = fs.realpathSync(
        `${process.cwd()}/default_contracts/${this.entry.$tx.$contract}.js`
      );
    };

    // Ledger Transpiled Contract Location
    const setupLocation = () => {
      let contract = this.entry.$tx.$contract;

      try {
        // This Cache won't always fetch latest version need to "defeat it"
        if (!this.contractPathCache[this.entry.$tx.$contract]) {
          let contractId: string;
          let namespacePath: string;

          try {
            namespacePath = fs.realpathSync(
              `${process.cwd()}/contracts/${this.entry.$tx.$namespace}/`
            );

            // Make sure the path is not a symlink
            const trueContractPath = fs.realpathSync(
              `${namespacePath}/${contract}.js`
            );

            contractId = path.basename(
              trueContractPath,
              path.extname(trueContractPath)
            );

            // We don't want the version number if the contract has one
            if (contractId.indexOf("@") > -1) {
              contractId = contractId.split("@")[0];
            }
          } catch {
            throw new Error("Contract or Namespace not found");
          }

          this.contractId = contractId;

          // Does the string contain @ then we leave it alone
          if (this.entry.$tx.$contract.indexOf("@") === -1) {
            if (contractVersion) {
              contract = contractVersion;
            } else {
              try {
                // Now we find the latest @ in the file system and include
                // need to remember to update it upon upgrades. This way we don't nned to manage cache
                // Or the VMs
                contract =
                  fs
                    .readdirSync(namespacePath)
                    .filter((fn) => fn.includes(`${this.contractId}@`))
                    .sort(this.sortVersions)
                    .pop()
                    ?.replace(".js", "") || this.contractId;

                // Cache it to parent process handler
                this.emit("contractLatestVersion", {
                  contract: this.entry.$tx.$contract,
                  file: contract,
                });
              } catch {
                throw new Error(`${this.contractId}@latest not found`);
              }
            }
          }

          // Check For Locks Global and Version
          if (fs.existsSync(`${namespacePath}/_LOCK.${this.contractId}`)) {
            throw new Error("Contract Global Lock");
          }

          //
          if (fs.existsSync(`${namespacePath}/_LOCK.${contract}`)) {
            throw new Error(
              `Contract Version Lock ${contract.substring(
                contract.indexOf("@") + 1
              )}`
            );
          }
          // Wrapped in realpathSync to avoid issues with cached contracts
          // And to allow us to get the ID of the contract if a label (symlink) was
          // used in the transaction
          // This needs to be here rather than where trueConrtractPath is as
          // we need the contract ID at that point to look up the latest version
          this.contractPathCache[this.entry.$tx.$contract] = fs.realpathSync(
            `${namespacePath}/${contract}.js`
          );
        }
        this.contractLocation =
          this.contractPathCache[this.entry.$tx.$contract];
      } catch (e) {
        throw e;
      }
    };

    try {
      // Is this a default contract
      this.entry.$tx.$namespace === "default"
        ? setupDefaultLocation()
        : setupLocation();
    } catch (error) {
      // Simple Error Return (Can't use postVote yet due to VM)
      this.entry.$nodes[this.reference].error = `Init Contract Error - ${
        error.message || error
      }`;
      this.emit("commited", { instant: true });
      return;
    }

    // Setup the virtual machine for this process
    // const virtualMachine: IVirtualMachine = this.isDefault
    //   ? Process.defaultContractsVM
    //   : this.contractRef
    //     ? Process.singleContractVMHolder[this.contractRef]
    //     : Process.generalContractVM;

    // Without vm2 we can just use one then maybe remove it as well?
    const virtualMachine: IVirtualMachine = Process.generalContractVM;

    // Get contract file (Or From Database)
    if (fs.existsSync(this.contractLocation)) {
      // Now we know we can execute the contract now or more costly cpu checks
      // Build Inputs Key Maps (Reference is Stream)
      this.inputs = Object.keys(this.entry.$tx.$i || {});

      // We must have inputs (New Inputs can create brand new unknown outputs)

      // Now allowing for read only transactions inputs can be empty
      if (this.inputs.length) {
        //this.shared.raiseLedgerError(1101, new Error("Inputs cannot be null"));

        // Which $i lookup are we using. Are they labelled or stream names
        this.labelOrKey();
      }

      // Build Outputs Key Maps (Reference is Stream)
      this.outputs = Object.keys(this.entry.$tx.$o || {});

      // Which $o lookup are we using. Are they labelled or stream names
      // Make sure we have outputs as they're optional
      if (this.outputs.length) {
        // Which $o lookup are we using. Are they labelled or stream names
        this.labelOrKey(true);
      }

      // Are we checking revisions or setting?
      if (!this.entry.$revs) {
        //this.checkRevs = false;
        this.entry.$revs = {
          $i: {},
          $o: {},
        };
      }

      // If Signatureless transaction (Such as a new account there cannot be a revision)
      if (!this.entry.$selfsign) {
        // Prefixes
        // [umid]           : Holds the data state (Prefix may be removed)
        // [umid]:stream    : Activeledger Meta Data
        // [umid]:volatile  : Data that can be lost
        // [umid]:data      : Data directly linked to a contract, umid should always be a contract ID

        try {
          // Check the input revisions
          const inputStreams: ActiveDefinitions.LedgerStream[] =
            await this.permissionChecker.process(this.inputs);

          // Check the output revisions
          const outputStreams: ActiveDefinitions.LedgerStream[] =
            await this.permissionChecker.process(this.outputs, false);

          //let contractData: ActiveDefinitions.IContractData | undefined =
          //  undefined;

          // // Default Contracts don't use context and are not available from the database
          // if (!this.isDefault) {
          //   try {
          //     const contractDataStreams = await this.permissionChecker.process(
          //       [`${this.contractId}:data`],
          //       false
          //     );

          //     if (contractDataStreams.length > 0) {
          //       contractData = contractDataStreams[0]
          //         .state as unknown as ActiveDefinitions.IContractData;
          //     }
          //   } catch (e) {
          //     // This catch block is used for when a contract doesn't have a data file yet
          //     // Need to make sure we still restore correctly if it is just a single node missing
          //     // the data file for that contract.
          //     if (e.code === 1200) {
          //       // 1200 means the _rev map didn't match so position error (defaults as output)
          //       throw e;
          //     }
          //   }
          // }

          this.process(inputStreams, outputStreams);
        } catch (error) {
          // Forward Error On
          // We may not have the output stream, So we need to pass over the knocks
          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message || error,
          });
        }
      } else {
        ActiveLogger.debug("Self signed Transaction");

        // If there are sigs we can enforce for the developer
        const inputs = Object.keys(this.entry.$tx.$i);

        if (inputs.length > 0) {
          // Loop Signatures and match against inputs
          let i = inputs.length;

          while (i--) {
            const signature = this.entry.$sigs[inputs[i]];
            const input = this.entry.$tx.$i[inputs[i]];

            // No matching signature found
            if (!signature) {
              return this.shared.raiseLedgerError(
                1260,
                new Error("Self signed signature not found")
              );
            }

            const validSignature = () =>
              this.shared.signatureCheck(
                input.publicKey,
                signature as string,
                input.type ? input.type : "rsa"
              );

            // Make sure we have an input (Can Skip otherwise maybe onboarded)
            if (input) {
              // Check the input has a public key
              if (input.publicKey) {
                if (!validSignature()) {
                  return this.shared.raiseLedgerError(
                    1250,
                    new Error("Self signed signature not matching")
                  );
                }
              } else {
                // We don't have the public key to check
                return this.shared.raiseLedgerError(
                  1255,
                  new Error(
                    "Self signed publicKey property not found in $i " +
                      inputs[i]
                  )
                );
              }
            }
          }
        }

        try {
          // No input streams, Maybe Output
          const outputStreams: ActiveDefinitions.LedgerStream[] =
            await this.permissionChecker.process(this.outputs, false);

          this.process([], outputStreams);
        } catch (error) {
          // Forward Error On

          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message || error,
          });
        }
      }
    } else {
      // Contract not found
      this.postVote(virtualMachine, {
        code: 1401,
        reason: "Contract Not Found",
      });
    }
  }

  /**
   * Updates VM transaction entry from other node broadcasts
   *
   * @param {*} node
   * @returns {void}
   */
  public updatedFromBroadcast(node?: any): void {
    if (this.isCommiting()) {
      return;
    }

    // Don't overwrite self
    if (node[this.reference]) {
      delete node[this.reference];
    }

    // TODO could probably work out this here instead of will emit
    // Update networks response into local object
    this.entry.$nodes = Object.assign(this.entry.$nodes, node);
    if (this.willEmit) {
      // need to make sure streams exists
      const nodes = Object.keys(this.entry.$nodes);
      // Do we have any votes left if not can fast forward
      if (!this.hasOutstandingVotes(nodes.length) && !this.canCommit()) {
        this.emitFailed(this.willEmitData);
      } else {
        // Waiting on commit confirmation for streams
        for (let i = nodes.length; i--; ) {
          if (this.entry.$nodes[nodes[i]].streams) {
            // We have 1 nodes $stream record can fast forward the error throwing
            this.emitFailed(this.willEmitData);
            break;
          }
        }
      }
    } else {
      // Make sure we haven't already reached consensus
      if (!this.isCommiting() && !this.voting) {
        // Reset Reference node response
        // Instead of setting remove it from incoming
        // this.nodeResponse = this.entry.$nodes[this.reference];
        // Try run commit!
        this.commit(Process.generalContractVM);
      }
    }
  }

  /**
   * Returns Commiting State (Broadcast)
   *
   * @returns {boolean}
   */
  public isCommiting(): boolean {
    return this.commiting;
  }

  /**
   * Handler processing of a transaction using a specified pre-initialised VM instance
   *
   * @private
   * @param {IVirtualMachine} virtualMachine
   * @param {IVMDataPayload} payload
   * @param {string} contractName
   */
  private async handleVM(
    virtualMachine: IVirtualMachine,
    payload: IVMDataPayload,
    contractName: string
  ) {
    // Internal micro functions

    // Handle a vote error
    const handleVoteError = async (error: Error) => {
      // Continue Execution of consensus
      // Update Error (Keep same format as before to not be a breaking change)
      this.nodeResponse.error = "Vote Failure - " + JSON.stringify(error);
      ActiveLogger.debug(
        this.nodeResponse.error,
        `Handle Vote Error ${payload.umid}`
      );

      // With broadcast mode this isn't picked up on the vote failure round
      // Not an issue to keep recalling this as it only extract from the same place within the VM
      ActiveLogger.debug(`Calling Contract Return Data - ${payload.umid}`);
      this.nodeResponse.return = virtualMachine.getReturnContractData(
        this.entry.$umid
      );

      // Continue to next nodes vote
      this.postVote(virtualMachine, this.nodeResponse.error);
    };

    // If there is an error processing should stop
    let continueProcessing = true;

    // Initialise the contract in the VM
    try {
      await virtualMachine.initialise(payload, contractName);
    } catch (error) {
      // Contract not found / failed to start
      ActiveLogger.debug(error, "VM initialisation failed");
      this.shared.raiseLedgerError(
        1401,
        new Error("VM Init Failure - " + JSON.stringify(error.message || error))
      );

      // Stop processing
      continueProcessing = false;
    }

    // Run the verification round
    try {
      if (continueProcessing)
        ActiveLogger.debug(`Calling Contract Verify - ${payload.umid}`);
      await virtualMachine.verify(this.entry.$selfsign, payload.umid);
    } catch (error) {
      ActiveLogger.debug(error, "Verify Failure");
      // Verification Failure
      this.shared.raiseLedgerError(1310, error);

      // Stop processing
      continueProcessing = false;
    }

    // If no $i or $sigs (only need to check on 1 as they're required)
    if (this.entry.$tx.$i) {
      // Run the vote round
      try {
        if (continueProcessing)
          ActiveLogger.debug(`Calling Contract Vote - ${payload.umid}`);
        const vote = await virtualMachine.vote(this.entry.$nodes, payload.umid);

        if (typeof vote !== "boolean" && vote.leader) {
          this.nodeResponse.vote = this.nodeResponse.leader = true;
          // If leader we can run straight to the commit
          // The data still gets sent on as part of a broadcast commit
          this.commit(virtualMachine);
          return;
        }
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
        ActiveLogger.debug(`Calling Contract INC - ${payload.umid}`);
        this.nodeResponse.incomms = virtualMachine.getInternodeCommsFromVM(
          payload.umid
        );

        // Return Data for this nodes contract run (Useful for $instant request expected id's)
        ActiveLogger.debug(`Calling Contract Return Data - ${payload.umid}`);
        this.nodeResponse.return = virtualMachine.getReturnContractData(
          payload.umid
        );

        // Clearing All node comms?
        this.entry = this.shared.clearAllComms(
          virtualMachine,
          this.nodeResponse.incomms
        );

        // Continue to next nodes vote
        this.postVote(virtualMachine);
      }
    } else {
      try {
        // Read only so lets call the $entry (or default which is read())
        ActiveLogger.debug(`Calling Contract Read - ${payload.umid}`);
        this.nodeResponse.return = await virtualMachine.read(
          payload.umid,
          this.entry.$tx.$entry || "read"
        );
      } catch (error) {
        // Do something with the error
        this.nodeResponse.error = "Read Error - " + JSON.stringify(error);
      }

      // Prevents false positive error log "failed to commit before timeout"
      this.nodeResponse.commit = true;

      // Not really commited but does what we need
      this.emit("commited");
    }
  }

  /**
   * Processes the transaction through the contract phases
   * Verify, Vote, Commit.
   * Vote phase is in memory blocked during conensus unless instant transaction
   *
   * @private
   * @param {LedgerStream[]} inputs
   */
  private async process(
    inputs: ActiveDefinitions.LedgerStream[]
  ): Promise<void>;
  private async process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[]
  ): //contractData: ActiveDefinitions.IContractData | undefined
  Promise<void>;
  private async process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[] = []
    // contractData: ActiveDefinitions.IContractData | undefined = undefined
  ): Promise<void> {
    try {
      // Transaction should be fully described now (revs etc)
      // we can now broadcast it before voting that way voting rounds will not lock up
      // if calling a 3rd party and awaiting multiple calls.
      if (this.entry.$broadcast && !(this.entry as any).$wait) {
        this.emit("broadcast", true);
      }

      // Get readonly data
      const readonly = await this.getReadOnlyStreams();

      const contractName = this.contractLocation.substring(
        this.contractLocation.lastIndexOf("/") + 1
      );

      // Need to filter the signature key name
      const $sigs: ActiveDefinitions.LedgerSignatures = {
        $sig: "",
      };

      if (this.entry.$sigs) {
        const sigKeys = Object.keys(this.entry.$sigs);
        for (let i = sigKeys.length; i--; ) {
          $sigs[this.shared.filterPrefix(sigKeys[i])] =
            this.entry.$sigs[sigKeys[i]];
          // Not going to add unfiltered (even though it would ovewrite)
          // As from this point we shouldn't need any prefixes.
        }
      }

      // Build the contract payload
      const payload: IVMDataPayload = {
        contractLocation: this.contractLocation,
        umid: this.entry.$umid,
        date: this.entry.$datetime,
        remoteAddress: this.entry.$remoteAddr,
        transaction: this.entry.$tx,
        signatures: $sigs,
        inputs,
        outputs,
        readonly,
        key: 0,
        //contractData,
      };

      // Which VM to run transaction in
      this.handleVM(Process.generalContractVM, payload, contractName);
    } catch (error) {
      // error fetch read only streams
      this.shared.raiseLedgerError(1210, new Error("Read Only Stream Error"));
      throw error;
    }
  }

  /**
   * Manages the protocol process after this node has voted
   *
   * @private
   */
  private postVote(virtualMachine: IVirtualMachine, error: any = false): void {
    // Set voting completed state
    this.voting = false;

    if (!this.entry) {
      // Unhandled contract error issues
      ActiveLogger.debug(`postVote entry is missing?`);
      return;
    }

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
        this.entry.$nodes[this.reference].error = error.reason
          ? error.reason
          : error; //global ruined this?
      }
      // Let all other nodes know about this transaction and our opinion
      if (!this.nodeResponse.leader) {
        this.emit("broadcast");
      }
      // Check we will be commiting (So we don't process as failed tx)
      //if (this.canCommit()) {
      // Try run commit! (May have reach consensus here)
      // TODO Remopving can commit it is checked inside anyway
      this.commit(virtualMachine);
      //}
    } else {
      // Knock our right neighbour with this trasnaction if they are not the origin
      if (this.right.reference != this.entry.$origin) {
        // Send back early if consensus has been reached and not the end of the network
        // (Early commit, Then Forward to network)
        ActiveLogger.debug(
          "Attempting commit with too early commit callback (to send right)"
        );
        this.commit(virtualMachine, async () => {
          try {
            // catch wait retry x 3? (broadcast not really affected other nodes will send it)
            const response = await this.initRightKnock();

            // Check we didn't commit early
            if (!this.nodeResponse.commit) {
              // Territoriality set?
              this.entry.$territoriality = (
                response.data as ActiveDefinitions.LedgerEntry
              ).$territoriality;

              // Append new $nodes
              this.entry.$nodes = (
                response.data as ActiveDefinitions.LedgerEntry
              ).$nodes;

              // Reset Reference node response
              this.nodeResponse = this.entry.$nodes[this.reference];

              // Normal, Or getting other node opinions?
              if (error) {
                this.shared.raiseLedgerError(
                  error.code || 1000,
                  error.reason || error,
                  true,
                  10
                );
              }

              // Run the Commit Phase
              ActiveLogger.debug("Sending Commit without callback");
              this.commit(virtualMachine);
            }
          } catch (error) {
            // Need to manage errors this would mean the node is unreachable
            ActiveLogger.debug(error, "Knock Failure");

            // if debug mode forward
            // IF error has status and error this came from another node which has erroed (not unreachable)
            ActiveOptions.get<boolean>("debug", false)
              ? this.shared.raiseLedgerError(
                  error.status || 1502,
                  new Error(error.error || error)
                ) // rethrow same error
              : this.shared.raiseLedgerError(
                  1501,
                  new Error("Bad Knock Transaction")
                ); // Generic error 404/ 500
          }
        });
      } else {
        ActiveLogger.debug("Origin is next (Sending Back)");

        error
          ? this.shared.raiseLedgerError(error.code || 1000, error.reason || error) // Of course if next is origin we need to send back for the promises!
          : this.commit(virtualMachine); // Run the Commit Phase
      }
    }
  }

  /**
   * Delayed "failed" response from this node to calling client
   * This will allow other nodes to confirm if they have committed or not
   * and provide their $stream / $returns
   *
   * The delay here will only ever happen if the transaction doesn't reach consensus
   * but may require tweaking
   *
   * @param {*} [data]
   */
  public emitFailed(
    data?: { status: number; error: string | Error },
    noWait?: boolean
  ) {
    this.commiting = false;
    if (this.willEmit || noWait) {
      clearTimeout(this.willEmit);
      this.emit("failed", this.willEmitData || data);
    } else {
      // Only delay for broadcast method and if it has outstanding votes to count
      // or waiting for streams if can commit
      // Still check for entry as it maybe cleared from memory ($broadcast false will clear early)
      if (
        this.entry &&
        this.entry.$broadcast &&
        (this.hasOutstandingVotes() || this.canCommit())
      ) {
        this.willEmitData = data;
        this.willEmit = setTimeout(() => {
          this.emit("failed", this.willEmitData);
        }, 10000);
      } else {
        this.emit("failed", data);
      }
    }
  }

  /**
   * Return if missing votes (Doesn't account for enough votes)
   *
   * @private
   * @param {number} [nodes]
   * @returns {boolean}
   */
  private hasOutstandingVotes(nodes?: number): boolean {
    const neighbours = ActiveOptions.get<Array<any>>(
      "neighbourhood",
      []
    ).length;
    return !!(neighbours - (nodes || Object.keys(this.entry.$nodes).length));
  }

  /**
   * Retries the right knock init
   * During this time "right" may change, Right may have errors so retries
   * skips this problem. Another problem could be the process managing the request
   * may get shutdown early so resending will try again.
   * (TODO: PRocess shutdown slower try and let all pendings finish)
   *
   * @private
   * @param {number} [retries=0]
   * @returns {Promise<any>}
   */
  private async initRightKnock(retries = 0): Promise<any> {
    try {
      ActiveLogger.debug(
        `Sending -> ${this.right.reference} - ${this.entry.$umid}`
      );
      return await this.right.knock("init", this.entry);
    } catch (e) {
      // Manage E? (Should partly self manage if node goes down)
      if (retries <= 2) {
        await this.sleep(1000);
        ActiveLogger.debug(
          `Sending -> ${this.right.reference} - ${this.entry.$umid} attempt ${retries}`
        );
        return await this.initRightKnock(++retries);
      } else {
        throw new Error("3x Right Knock Error");
      }
    }
  }

  /**
   * Basic awaitable sleep
   *
   * @private
   * @param {number} time
   * @returns
   */
  private sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  /**
   * Decides if consensus has been reached for commit phase to start
   *
   * @private
   * @param {boolean} [skipBoost=false]
   * @returns {boolean}
   */
  private canCommit(): boolean {
    // Time to count the votes (Need to recache keys)
    let networkNodes: string[] = Object.keys(this.entry.$nodes);
    this.currentVotes = 0;
    if (networkNodes) {
      // Small performance boost if we voted no
      //if (skipBoost /*|| this.nodeResponse.vote*/) {
      for (let i = networkNodes.length; i--; ) {
        if (this.entry.$nodes[networkNodes[i]].vote) this.currentVotes++;
      }
      //}

      // Allow for full network consensus
      const percent = this.entry.$unanimous
        ? 100
        : ActiveOptions.get<any>("consensus", {}).reached;

      // Return if consensus has been reached
      return (
        (this.currentVotes / Process.networkNodeLength) * 100 >= percent ||
        false
      );
    } else {
      return false;
    }
  }

  /**
   * Checks voting round and runs the commit phase of the contract
   * The use of callback is because it fits better than a promise in the flow and the performance is a bonus
   *
   * @private
   * @param {Function} [earlyCommit]
   * @returns {void}
   */
  private async commit(
    virtualMachine: IVirtualMachine,
    earlyCommit?: Function
  ): Promise<void> {
    // If we haven't commited process as normal
    if (!this.nodeResponse.commit && !this.isCommiting()) {
      // check we can commit still

      if (
        this.nodeResponse.vote &&
        (this.nodeResponse.leader || this.canCommit())
      ) {
        // Consensus reached commit phase
        this.commiting = true;

        // Make sure broadcast timeout is cleared
        clearTimeout(this.broadcastTimeout);

        // Pass Nodes for possible INC injection
        try {
          ActiveLogger.debug(`Calling Contract Commit - ${this.entry.$umid}`);
          await virtualMachine.commit(
            this.entry.$nodes,
            this.entry.$territoriality === this.reference,
            this.entry.$umid
          );

          // Update Commit Entry
          this.nodeResponse.commit = true;

          // Wait to get $streams?
          //this.emit("broadcast");

          // Update in communication (Recommended pre commit only but can be edge use cases)
          ActiveLogger.debug(`Calling Contract INC X2 - ${this.entry.$umid}`);
          this.nodeResponse.incomms = virtualMachine.getInternodeCommsFromVM(
            this.entry.$umid
          );

          // Return Data for this nodes contract run
          ActiveLogger.debug(
            `Calling Contract Return Data X2 - ${this.entry.$umid}`
          );
          this.nodeResponse.return = virtualMachine.getReturnContractData(
            this.entry.$umid
          );

          // Update Streams
          const streamUpdater = new StreamUpdater(
            this.entry,
            virtualMachine,
            this.reference,
            this.nodeResponse,
            this.db,
            this.dbev,
            this,
            this.shared,
            this.contractId
          );

          // TODO - manage async if it is really needed
          await streamUpdater.updateStreams(earlyCommit);
        } catch (error) {
          // Don't let local error stop other nodes
          if (earlyCommit) earlyCommit();
          ActiveLogger.debug(error, "VM Commit Failure");

          // If debug mode forward full error
          ActiveOptions.get<boolean>("debug", false)
            ? this.shared.raiseLedgerError(
                1302,
                new Error(
                  "Commit Failure - " + JSON.stringify(error.message || error)
                )
              )
            : this.shared.raiseLedgerError(
                1301,
                new Error("Failed Commit Transaction")
              );
        }
      } else {
        // If Early commit we don't need to manage these errors
        if (earlyCommit) return earlyCommit();

        // Consensus not reached
        if (!this.nodeResponse.vote && !this.entry.$broadcast) {
          // We didn't vote right
          ActiveLogger.debug(
            this.nodeResponse,
            "VM Commit Failure, We voted NO (100)"
          );

          // We voted false, Need to process
          this.shared.raiseLedgerError(
            1505,
            new Error(this.nodeResponse.error),
            false
          );

          //TODO: Consensus Vote Reconciling not available on broadcast p2p method
          //if (!this.entry.$broadcast) {
          //? Reminder : Contract Voted False to be here not pre-flights
          // How can we tell the network commited? I guess we should count the votes?
          if (this.canCommit()) {
            ActiveLogger.debug(
              "Network Consensus reached without me (Reconciling)"
            );

            try {
              ActiveLogger.debug(
                `Calling Contract Reconcile - ${this.entry.$umid}`
              );
              const reconciled: boolean = await virtualMachine.reconcile(
                this.entry.$nodes,
                this.entry.$umid
              );
              // Contract ran its own reconcile procedure
              if (reconciled) {
                ActiveLogger.info("Self Reconcile Successful");
                // tx is for hybrid, Do we want to broadcast a reconciled one? if so we can do this within the function
                const streamUpdater = new StreamUpdater(
                  this.entry,
                  virtualMachine,
                  this.reference,
                  this.nodeResponse,
                  this.db,
                  this.dbev,
                  this,
                  this.shared,
                  this.contractId
                );
                await streamUpdater.updateStreams();
              } else {
                // No move onto internal attempts
                // Upgrade error code so restore will process it
                if (this.errorOut.code === 1505) {
                  ActiveLogger.info(
                    "Self Reconcile Failed & Upgrading Error Code for Auto Restore"
                  );
                  // reset single error as 1505 is skipped anyway
                  this.shared.storeSingleError = false;
                  // try/catch to finish execution
                  this.shared
                    .storeError(1001, new Error(this.errorOut.reason), 11)
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
          if (!this.entry.$broadcast) {
            // Network didn't reach consensus
            ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
            this.shared.raiseLedgerError(
              1510,
              new Error("Failed Network Voting Round - Non Broadcast")
            );
          } else {
            // Are there any outstanding node responses which could mean consensus can still be reached
            const neighbours = ActiveOptions.get<Array<any>>(
              "neighbourhood",
              []
            ).length;
            const consensusNeeded = ActiveOptions.get<any>(
              "consensus",
              {}
            ).reached;
            const outstandingVoters =
              neighbours - Object.keys(this.entry.$nodes).length;
            // Basic check, If no nodes to respond and we failed to reach consensus we will fail
            if (!outstandingVoters) {
              // Clear current timeout to prevent it from running
              clearTimeout(this.broadcastTimeout);

              // Did we vote no and raise our error?
              if (this.nodeResponse.error) {
                if (!this.storeSingleError) {
                  ActiveLogger.debug(
                    this.nodeResponse,
                    "VM Commit Failure, We voted NO (200)"
                  );
                  this.storeSingleError = true;
                  // We voted false, Need to process
                  return this.shared.raiseLedgerError(
                    1505,
                    new Error(this.nodeResponse.error)
                  );
                }
              } else {
                // Entire Network didn't reach consensus
                ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
                return this.shared.raiseLedgerError(
                  1510,
                  new Error("Failed Network Voting Round - No More Voters")
                );
              }
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
                this.broadcastTimeout = setTimeout(
                  () => {
                    if (!this.isCommiting()) {
                      // Entire Network didn't reach consensus in time
                      ActiveLogger.debug("VM Commit Failure, NETWORK Timeout");
                      return this.shared.raiseLedgerError(
                        1510,
                        new Error(
                          "Failed Network Voting Timeout - Voters Timed Out"
                        )
                      );
                    }
                  },
                  this.isCommiting()
                    ? BROADCAST_TIMEOUT_COMMIT
                    : BROADCAST_TIMEOUT_VOTE
                );
              } else {
                // Did we vote no and raise our error?
                if (this.nodeResponse.error) {
                  if (!this.storeSingleError) {
                    ActiveLogger.debug(
                      this.nodeResponse,
                      "VM Commit Failure, We voted NO (300)"
                    );
                    this.storeSingleError = true;
                    // We voted false, Need to process
                    return this.shared.raiseLedgerError(
                      1505,
                      new Error(this.nodeResponse.error)
                    );
                  }
                } else {
                  // Even if the other nodes voted yes we will still not reach conesnsus
                  ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
                  return this.shared.raiseLedgerError(
                    1510,
                    new Error("Failed Network Voting Round - No Quorum")
                  );
                }
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

  /**
   * Fetches streams for read only consumption
   *
   * @private
   * @returns {Promise<boolean>}
   */
  private getReadOnlyStreams(): Promise<ActiveDefinitions.LedgerIORputs> {
    return new Promise(async (resolve, reject) => {
      // Promise builder
      const manageRevisions = (
        readOnly: ActiveDefinitions.LedgerIORputs,
        reference: string
      ) => {
        return new Promise(async (resolve, reject) => {
          // Get Meta data
          try {
            const read: any = await this.db.get(readOnly[reference]);
            // Remove _id and _rev
            delete read._id;
            delete read._rev;

            // Overwrite reference with state
            readonlyStreams[reference] = read;
            resolve(read);
          } catch (error) {
            // Rethrow
            reject(error);
          }
        });
      };

      // Holds the read only stream data
      let readonlyStreams: ActiveDefinitions.LedgerIORputs = {};

      if (this.entry.$tx.$r) {
        // Reference for solving linter errors
        let readOnly = this.entry.$tx.$r;
        // Get Index
        let keyRefs = Object.keys(readOnly);

        // Map all the objects to get their promises
        // Create promise to manage all revisions at once
        const promiseCache = keyRefs.map((reference) =>
          manageRevisions(readOnly, reference)
        );

        try {
          await Promise.all(promiseCache);
          // Shoudln't need to do anything as reference object has been updated
          resolve(readonlyStreams);
        } catch (error) {
          // Rethrow
          reject(error);
        }
      } else {
        resolve(readonlyStreams);
      }
    });
  }

  /**
   * Transaction $i/o type for stream names
   * Which $i/o lookup are we using. Are they labelled or stream names
   *
   * @private
   * @param {boolean} [outputs=false]
   */
  private labelOrKey(outputs: boolean = false): void {
    // Get reference for input or output
    const streams = outputs ? this.outputs : this.inputs;
    const txIO = outputs ? this.entry.$tx.$o : this.entry.$tx.$i;
    const map = outputs ? this.shared.ioLabelMap.o : this.shared.ioLabelMap.i;

    // Check the first one, If labelled then loop all.
    // Means first has to be labelled but we don't want to loop when not needed
    if (txIO[streams[0]].$stream) {
      for (let i = streams.length; i--; ) {
        // Stream label or self
        let streamId = txIO[streams[i]].$stream || streams[i];
        map[streamId] = streams[i];
        streams[i] = streamId;
      }
    }
  }
}
