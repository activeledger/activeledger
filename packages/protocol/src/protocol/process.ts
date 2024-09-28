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

const BROADCAST_TIMEOUT = 20 * 1000;

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
      this.entry.$nodes[
        this.reference
      ].error = `Init Contract Error - ${error.message}`;
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
          console.log("Post OVte #1");
          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message,
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
          console.log("Post OVte #12");

          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message,
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
    console.log("upadting from node");
    console.log(node);
    if (this.isCommiting()) {
      console.log("not here please");
      return;
    }

    // TODO could probably work out this here instead of will emit
    console.log("Ok lets go");
    // Update networks response into local object
    this.entry.$nodes = Object.assign(this.entry.$nodes, node);
    console.log(this.entry.$nodes);
    if (this.willEmit) {
      console.log("will emit");
      // need to make sure streams exists
      const nodes = Object.keys(this.entry.$nodes);
      // Do we have any votes left if not can fast forward
      if (!this.hasOutstandingVotes(nodes.length) && !this.canCommit()) {
        console.log("no outstanding");
        this.emitFailed(this.willEmitData);
      } else {
        console.log("chekcing");
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
      console.log("no idea");
      console.log(this.willEmitData);
      console.log("REALLY NO IDEA");
      // Make sure we haven't already reached consensus
      if (!this.isCommiting() && !this.voting) {
        console.log("doubt it");
        // Reset Reference node response
        this.nodeResponse = this.entry.$nodes[this.reference];
        // Try run commit!

        this.commit(Process.generalContractVM);

        // Get the correct VM instance reference
        // this.isDefault
        //   ? this.commit(Process.defaultContractsVM)
        //   : this.contractRef
        //     ? this.commit(Process.singleContractVMHolder[this.contractRef])
        //     : this.commit(Process.generalContractVM);
      } else {
        // no more nodes, if we haven't commited most likely failure
        //         const nodes = Object.keys(this.entry.$nodes);
        //         if (!this.hasOutstandingVotes(nodes.length) && !this.canCommit()) {
        //           console.log("no outstanding");
        //           console.log(this.nodeResponse);
        //           /*
        // {
        //               status: code,
        //               error: this.getGlobalReason(reason) as string,
        //             } no wait
        //               */
        //           //this.emitFailed(this.willEmitData);
        //         }
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
   * Initialise the default contracts VM instance if needed and/or pass through the data
   *
   * @private
   * @param {IVMDataPayload} payload
   * @param {string} contractName
   */
  // private processDefaultContracts(
  //   payload: IVMDataPayload,
  //   contractName: string
  // ) {
  //   // Check if the holder needs to be initialised
  //   if (!Process.defaultContractsVM) {
  //     // Setup for default contracts
  //     try {
  //       Process.defaultContractsVM = new VirtualMachine(
  //         this.selfHost,
  //         this.secured,
  //         this.db,
  //         this.dbev
  //       );
  //       // Create VM with all access it needs
  //       Process.defaultContractsVM.initialiseVirtualMachine(
  //         ["fs", "path", "os", "crypto"],
  //         ["typescript"]
  //       );
  //     } catch (error) {
  //       throw new Error(error);
  //     }
  //   }

  //   // Pass through the VM holder and data to the VM Handler
  //   this.handleVM(Process.defaultContractsVM, payload, contractName);
  // }

  /**
   * Handle the initialisation and pass through of data for unsafe contracts
   *
   * TODO we only need oone VM now. First attempt was broken with get inputs
   *
   * @private
   * @param {IVMDataPayload} payload
   * @param {string} namespace
   * @param {string} contractName
   * @param {string[]} extraBuiltins
   */
  // private processUnsafeContracts(
  //   payload: IVMDataPayload,
  //   namespace: string,
  //   contractName: string,
  //   extraBuiltins: string[],
  //   extraExternals: string[],
  //   extraMocks: string[]
  // ) {
  //   this.contractRef = namespace;

  //   // If we have initialised an instance for this namespace reuse it
  //   // Otherwise we should create an instance for it
  //   if (!Process.singleContractVMHolder[this.contractRef]) {
  //     try {
  //       Process.singleContractVMHolder[this.contractRef] = new VirtualMachine(
  //         this.selfHost,
  //         this.secured,
  //         this.db,
  //         this.dbev
  //       );

  //       Process.singleContractVMHolder[
  //         this.contractRef
  //       ].initialiseVirtualMachine(extraBuiltins, extraExternals, extraMocks);
  //     } catch (error) {
  //       throw new Error(error);
  //     }
  //   }

  //   // Pass VM instance and data to the VM Handler
  //   this.handleVM(
  //     Process.singleContractVMHolder[this.contractRef],
  //     payload,
  //     contractName
  //   );
  // }

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
      console.log("Post OVte #5 - 100% hwre");
      console.log(error);
      console.log(this.nodeResponse.error);

      // really bug always been here?
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
        console.log("Post OVte #6");

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

      // Continue to next nodes vote, We may just want to return
      // however using $instant allows this and we could also have multiple node
      // returned data for reliability and in the future use it to data check for the restore engine
      // for postVote to work we need to skip a lot of checks as it assume the v/v/c routine
      //this.postVote(virtualMachine);

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

      // Check if the security data has been cached
      // if (!this.securityCache) {
      //   this.securityCache = ActiveOptions.get<any>("security", null);
      // }

      // Which VM to run transaction in
      this.handleVM(Process.generalContractVM, payload, contractName);

      // if (payload.transaction.$namespace === "default") {
      //   // Use the Default contract VM (for contracts that are built into Activeledger)
      //   this.processDefaultContracts(payload, contractName);
      // } else {
      //   //this.handleVM(Process.generalContractVM, payload, contractName);
      //   //Check Namespace
      //   if (
      //     this.securityCache &&
      //     this.securityCache.namespace &&
      //     this.securityCache.namespace[payload.transaction.$namespace]
      //   ) {
      //     const builtin: string[] = [];
      //     const external: string[] = [];
      //     const mocks: string[] = [];
      //     // Use the Unsafe contract VM, first we need to build a custom builtin array to use to initialise the VM
      //     // const namespaceExtras =
      //     //   this.securityCache.namespace[payload.transaction.$namespace];

      //     // if (namespaceExtras) {
      //     //   // Built in
      //     //   if (namespaceExtras.std) {
      //     //     namespaceExtras.std.forEach((item: string) => {
      //     //       builtin.push(item);
      //     //     });
      //     //   }

      //     //   // Now for any approved external
      //     //   if (namespaceExtras.external) {
      //     //     namespaceExtras.external.forEach((item: string) => {
      //     //       external.push(item);
      //     //     });
      //     //   }

      //     //   // Now for any pakcages needing mocking
      //     //   if (namespaceExtras.mock) {
      //     //     namespaceExtras.mock.forEach((item: string) => {
      //     //       mocks.push(item);
      //     //     });
      //     //   }
      //     // }

      //     // Initialise the unsafe contract VM
      //     this.processUnsafeContracts(
      //       payload,
      //       payload.transaction.$namespace,
      //       contractName,
      //       builtin,
      //       external,
      //       mocks
      //     );
      //   } else {
      //     // Use the General contract VM
      //     this.handleVM(Process.generalContractVM, payload, contractName);
      //   }
      // }
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
    console.log("post vote makes sense");
    console.log(this.entry);

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
    console.log(
      `I AM looking for this.entry.$broadcast which is - ${this.entry.$broadcast}`
    );
    if (this.entry.$broadcast) {
      console.log("broadcast  VOTE");
      console.log(error);
      if (error) {
        console.log("of course here");
        // Add error to the broadcast for passing back to the client
        this.entry.$nodes[this.reference].error = error.reason;
      }
      // Let all other nodes know about this transaction and our opinion
      if (!this.nodeResponse.leader) {
        this.emit("broadcast");
      }
      // Check we will be commiting (So we don't process as failed tx)
      if (this.canCommit()) {
        console.log("POST VOTE CANCOIMMIT");
        // Try run commit! (May have reach consensus here)
        this.commit(virtualMachine);
      } else {
        // Uncomment below we only find out about this node not network if they committed
        // if (error) {
        //   console.log("WHAT IS THE ERROR PICK IT UP")
        //   console.log(error);
        //   this.emitFailed(
        //     {
        //       status: 200,
        //       error: error.reason || error,
        //     },
        //     true
        //   );
        // }
      }
    } else {
      console.log("But I drop into here?>!");
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
                  error.code,
                  error.reason,
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
          ? this.shared.raiseLedgerError(error.code, error.reason) // Of course if next is origin we need to send back for the promises!
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
    console.log("EMIT FAILED #4");

    this.commiting = false;
    if (this.willEmit || noWait) {
      clearTimeout(this.willEmit);
      console.log("EMIT FAILED #5");

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
          console.log("EMIT FAILED #6");

          this.emit("failed", this.willEmitData);
        }, 10000);
      } else {
        console.log("EMIT FAILED #7");

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
    console.log("tta 1");
    if (!this.nodeResponse.commit && !this.isCommiting()) {
      // check we can commit still
      console.log("tta 2");

      if (
        this.nodeResponse.vote &&
        (this.nodeResponse.leader || this.canCommit())
      ) {
        console.log("tta 3");

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

          // Clearing All node comms?#
          // this.entry = this.shared.clearAllComms(
          //   virtualMachine,
          //   this.nodeResponse.incomms
          // );

          // // Are we throwing to another ledger(s)?
          // let throws = virtualMachine.getThrowsFromVM(this.entry.$umid);

          // // Emit to network handler
          // if (throws && throws.length) {
          //   this.emit("throw", { locations: throws });
          // }

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
        console.log("tta 4");

        // If Early commit we don't need to manage these errors
        if (earlyCommit) return earlyCommit();

        // Consensus not reached
        console.log("voted");
        console.log(this.nodeResponse.vote);
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
              console.log("tta 6");

              // Timed out
              ActiveLogger.debug(error);
              this.emit("commited");
            }
          }
          //} else {
          // Because we voted no doesn't mean the network should error
          //  this.emit("commited");
          //}
        } else {
          console.log("tta 7");

          if (!this.entry.$broadcast) {
            // Network didn't reach consensus
            ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
            this.shared.raiseLedgerError(
              1510,
              new Error("Failed Network Voting Round - Non Broadcast")
            );
          } else {
            console.log("tta 9");

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
            console.log(outstandingVoters);
            console.log("outstanidng too");
            // Basic check, If no nodes to respond and we failed to reach consensus we will fail
            if (!outstandingVoters) {
              console.log("No more outstanidng");
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
              console.log("tta 10");

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
                console.log("not sure");
                this.broadcastTimeout = setTimeout(() => {
                  // Entire Network didn't reach consensus in time
                  ActiveLogger.debug("VM Commit Failure, NETWORK Timeout");
                  return this.shared.raiseLedgerError(
                    1510,
                    new Error(
                      "Failed Network Voting Timeout - Voters Timed Out"
                    )
                  );
                }, BROADCAST_TIMEOUT);
              } else {
                console.log("loooking good");
                // Did we vote no and raise our error?
                if (this.nodeResponse.error) {
                  console.log("yes");
                  if (!this.storeSingleError) {
                    console.log("yes yess");
                    ActiveLogger.debug(
                      this.nodeResponse,
                      "VM Commit Failure, We voted NO (300)"
                    );
                    this.storeSingleError = true;
                    console.log("maybe?!)");
                    // We voted false, Need to process
                    return this.shared.raiseLedgerError(
                      1505,
                      new Error(this.nodeResponse.error)
                    );
                  }
                } else {
                  console.log("O here");
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
      console.log("tta 1111");

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
