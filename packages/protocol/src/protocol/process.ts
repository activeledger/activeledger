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
  private static singleContractVMHolder: IVMContractHolder = {};

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
   * The ID of the contract being called
   * Used for contract:data hanlding
   *
   * @private
   * @type {string}
   * @memberof Process
   */
  private contractId: string;

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
    priority: 0,
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

  /**
   * Initialised shared class
   *
   * @private
   * @type {Shared}
   * @memberof Process
   */
  private shared: Shared;

  /**
   * Permission checking class
   *
   * @private
   * @type {PermissionsChecker}
   * @memberof Process
   */
  private permissionChecker: PermissionsChecker;

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

    this.shared = new Shared(this.storeSingleError, this.entry, this.dbe, this);

    // Reference node response
    this.nodeResponse = entry.$nodes[reference];

    try {
      // Initialise the general contract VM
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

    // Check if the security data has been cached
    if (!this.securityCache) {
      this.securityCache = ActiveOptions.get<any>("security", null);
    }

    // Initialise the permission checker
    this.permissionChecker = new PermissionsChecker(
      this.entry,
      this.db,
      this.checkRevs,
      this.securityCache as ISecurityCache,
      this.shared
    );
  }

  /**
   * Destroy the process object from memory
   *
   * @memberof Process
   */
  public destroy(umid: string): void {
    // Record un commited transactions as an error
    if (!this.nodeResponse.commit) {
      this.shared.raiseLedgerError(
        1600,
        new Error("Failed to commit before timeout"),
        true
      );
    }

    // Make sure broadcast timeout is cleared
    clearTimeout(this.broadcastTimeout);

    // Close VM and entry (cirular reference)
    if (this.isDefault) {
      // DefaultVM created?
      if (Process.defaultContractsVM) Process.defaultContractsVM.destroy(umid);
    } else {
      this.contractRef
        ? Process.singleContractVMHolder[this.contractRef].destroy(umid)
        : Process.generalContractVM.destroy(umid);
    }

    // Quick solution to delete rules
    delete (this as any).entry;
  }

  /**
   * Semver sorting for latest file detection
   *
   * @private
   * @param {string} a
   * @param {string} b
   * @returns
   * @memberof Process
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

  /**
   * Starts the consensus and commit phase processing
   *
   * @memberof Process
   */
  public async start(contractVersion?: string) {
    ActiveLogger.debug("New TX : " + this.entry.$umid);
    ActiveLogger.debug(this.entry, "Starting TX");

    // Compiled Contracts sit in another location
    const setupDefaultLocation = () => {
      // Set isDefault flag to true
      this.isDefault = true;

      // Default Contract Location
      // Wrapped in realpathSync to resolve symbolic links
      // This prevents issues with cached contracts
      this.contractLocation = fs.realpathSync(`${process.cwd()}/default_contracts/${this.entry.$tx.$contract}.js`);
    };

    // Ledger Transpiled Contract Location
    const setupLocation = () => {
      let contract = this.entry.$tx.$contract;

      let namespacePath = fs.realpathSync(`${process.cwd()}/contracts/${this.entry.$tx.$namespace}/`);

      // Make sure the path is not a symlink
      const trueContractPath = fs.realpathSync(`${namespacePath}/${contract}.js`);

      let contractId = path.basename(trueContractPath, path.extname(trueContractPath));

      // We don't want the version number if the contract has one
      if (contractId.indexOf("@") > -1) {
        contractId = contractId.split("@")[0];
      }

      this.contractId = contractId;

      // Does the string contain @ then we leave it alone
      if (this.entry.$tx.$contract.indexOf("@") === -1) {
        if (contractVersion) {
          contract = contractVersion;
        } else {
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
        }
      }

      // Wrapped in realpathSync to avoid issues with cached contracts
      // And to allow us to get the ID of the contract if a label (symlink) was
      // used in the transaction
      // This needs to be here rather than where trueConrtractPath is as
      // we need the contract ID at that point to look up the latest version
      this.contractLocation = fs.realpathSync(`${namespacePath}/${contract}.js`);
    };

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

      // Now allowing for read only transactions inputs can be empty
      if (this.inputs.length) {
        //this.shared.raiseLedgerError(1101, new Error("Inputs cannot be null"));

        // Which $i lookup are we using. Are they labelled or stream names
        this.labelOrKey();
      }

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

          const contractDataStreams =
            await this.permissionChecker.process([`${this.contractId}:data`], false);


          let contractData: ActiveDefinitions.IContractData | undefined = undefined;
          if (contractDataStreams.length > 0) {
            contractData = contractDataStreams[0].state as unknown as ActiveDefinitions.IContractData;

          }

          this.process(inputStreams, outputStreams, contractData);
        } catch (error) {
          // Forward Error On
          // We may not have the output stream, So we need to pass over the knocks
          this.postVote(virtualMachine, {
            code: error.code,
            reason: error.reason || error.message,
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
          const outputStreams: ActiveDefinitions.LedgerStream[] =
            await this.permissionChecker.process(this.outputs, false);

          this.process([], outputStreams, undefined);
        } catch (error) {
          // Forward Error On
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
      try {
        Process.defaultContractsVM = new VirtualMachine(
          this.selfHost,
          this.secured,
          this.db,
          this.dbev
        );
        // Create VM with all access it needs
        Process.defaultContractsVM.initialiseVirtualMachine(
          ["fs", "path", "os", "crypto"],
          ["typescript"]
        );
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
    extraBuiltins: string[],
    extraExternals: string[],
    extraMocks: string[]
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
        ].initialiseVirtualMachine(extraBuiltins, extraExternals, extraMocks);
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
      // Continue Execution of consensus
      // Update Error (Keep same format as before to not be a breaking change)
      this.nodeResponse.error = "Vote Failure - " + JSON.stringify(error);

      // Continue to next nodes vote
      this.postVote(virtualMachine);
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
        await virtualMachine.verify(this.entry.$selfsign, this.entry.$umid);
    } catch (error) {
      ActiveLogger.debug(error, "Verify Failure");
      // Verification Failure
      this.shared.raiseLedgerError(1310, new Error(error));

      // Stop processing
      continueProcessing = false;
    }

    // If no $i or $sigs (only need to check on 1 as they're required)
    if (this.entry.$tx.$i) {
      // Run the vote round
      try {
        if (continueProcessing)
          await virtualMachine.vote(this.entry.$nodes, this.entry.$umid);
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
        this.entry = this.shared.clearAllComms(
          virtualMachine,
          this.nodeResponse.incomms
        );

        // Continue to next nodes vote
        this.postVote(virtualMachine);
      }
    } else {
      // Read only so lets call the $entry (or default which is read())
      this.nodeResponse.return = await virtualMachine.read(
        this.entry.$umid,
        this.entry.$tx.$entry || "read"
      );

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
   * @memberof Process
   */
  private async process(
    inputs: ActiveDefinitions.LedgerStream[]
  ): Promise<void>;
  private async process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[],
    contractData: ActiveDefinitions.IContractData | undefined,
  ): Promise<void>;
  private async process(
    inputs: ActiveDefinitions.LedgerStream[],
    outputs: ActiveDefinitions.LedgerStream[] = [],
    contractData: ActiveDefinitions.IContractData | undefined = undefined,
  ): Promise<void> {
    try {
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
        for (let i = sigKeys.length; i--;) {
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
        key: Math.floor(Math.random() * 100),
        contractData,
      };

      // Check if the security data has been cached
      if (!this.securityCache) {
        this.securityCache = ActiveOptions.get<any>("security", null);
      }

      // Which VM to run transaction in
      if (payload.transaction.$namespace === "default") {
        // Use the Default contract VM (for contracts that are built into Activeledger)
        this.processDefaultContracts(payload, contractName);
      } else {
        // Check Namespace
        if (
          this.securityCache &&
          this.securityCache.namespace &&
          this.securityCache.namespace[payload.transaction.$namespace]
        ) {
          const builtin: string[] = [];
          const external: string[] = [];
          const mocks: string[] = [];
          // Use the Unsafe contract VM, first we need to build a custom builtin array to use to initialise the VM
          const namespaceExtras =
            this.securityCache.namespace[payload.transaction.$namespace];

          if (namespaceExtras) {
            // Built in
            if (namespaceExtras.std) {
              namespaceExtras.std.forEach((item: string) => {
                builtin.push(item);
              });
            }

            // Now for any approved external
            if (namespaceExtras.external) {
              namespaceExtras.external.forEach((item: string) => {
                external.push(item);
              });
            }

            // Now for any pakcages needing mocking
            if (namespaceExtras.mock) {
              namespaceExtras.mock.forEach((item: string) => {
                mocks.push(item);
              });
            }
          }

          // Initialise the unsafe contract VM
          this.processUnsafeContracts(
            payload,
            payload.transaction.$namespace,
            contractName,
            builtin,
            external,
            mocks
          );
        } else {
          // Use the General contract VM
          this.handleVM(Process.generalContractVM, payload, contractName);
        }
      }
    } catch (error) {
      // error fetch read only streams
      this.shared.raiseLedgerError(1210, new Error("Read Only Stream Error"));
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
                new Error(error.error)
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

    // Allow for full network consensus
    const percent = this.entry.$unanimous
      ? 100
      : ActiveOptions.get<any>("consensus", {}).reached;

    // Return if consensus has been reached
    return (
      ((skipBoost || this.nodeResponse.vote) &&
        (this.currentVotes /
          ActiveOptions.get<Array<any>>("neighbourhood", []).length) *
        100 >=
        percent) ||
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
    earlyCommit?: Function
  ): Promise<void> {
    // If we haven't commited process as normal
    if (!this.nodeResponse.commit) {
      // check we can commit still
      if (this.canCommit()) {
        // Consensus reached commit phase
        this.commiting = true;

        // Make sure broadcast timeout is cleared
        clearTimeout(this.broadcastTimeout);

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
          this.entry = this.shared.clearAllComms(
            virtualMachine,
            this.nodeResponse.incomms
          );

          // Are we throwing to another ledger(s)?
          let throws = virtualMachine.getThrowsFromVM(this.entry.$umid);

          // Emit to network handler
          if (throws && throws.length) {
            this.emit("throw", { locations: throws });
          }

          // Update Streams
          const streamUpdater = new StreamUpdater(
            this.entry,
            virtualMachine,
            this.reference,
            this.nodeResponse,
            this.db,
            this,
            this.shared,
            this.contractId
          );

          earlyCommit
            ? streamUpdater.updateStreams(earlyCommit)
            : streamUpdater.updateStreams();
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
        if (!this.nodeResponse.vote) {
          // We didn't vote right
          ActiveLogger.debug(
            this.nodeResponse,
            "VM Commit Failure, We voted NO"
          );

          // We voted false, Need to process
          this.shared.raiseLedgerError(
            1505,
            new Error(this.nodeResponse.error),
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
                  ActiveLogger.info("Self Reconcile Successful");
                  // tx is for hybrid, Do we want to broadcast a reconciled one? if so we can do this within the function
                  const streamUpdater = new StreamUpdater(
                    this.entry,
                    virtualMachine,
                    this.reference,
                    this.nodeResponse,
                    this.db,
                    this,
                    this.shared,
                    this.contractId
                  );
                  streamUpdater.updateStreams();
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
            // Because we voted no doesn't mean the network should error
            this.emit("commited");
          }
        } else {
          if (!this.entry.$broadcast) {
            // Network didn't reach consensus
            ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
            this.shared.raiseLedgerError(
              1510,
              new Error("Failed Network Voting Round")
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
              // Entire Network didn't reach consensus
              ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
              return this.shared.raiseLedgerError(
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
                  return this.shared.raiseLedgerError(
                    1510,
                    new Error("Failed Network Voting Timeout")
                  );
                }, 20000);
              } else {
                // Even if the other nodes voted yes we will still not reach conesnsus
                ActiveLogger.debug("VM Commit Failure, NETWORK voted NO");
                return this.shared.raiseLedgerError(
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

  /**
   * Fetches streams for read only consumption
   *
   * @private
   * @returns {Promise<boolean>}
   * @memberof Process
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
      for (let i = streams.length; i--;) {
        // Stream label or self
        let streamId = txIO[streams[i]].$stream || streams[i];
        map[streamId] = streams[i];
        streams[i] = streamId;
      }
    }
  }
}
