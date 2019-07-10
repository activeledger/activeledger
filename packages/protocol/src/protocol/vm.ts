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

import * as events from "events";
import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Activity } from "@activeledger/activecontracts";
import { QueryEngine, EventEngine } from "@activeledger/activequery";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { setTimeout } from "timers";
import { NodeVM, VMScript } from "vm2";
import * as fs from "fs";
import {
  IVMDataPayload,
  IVMContractReferences,
  IVirtualMachine
} from "./interfaces/vm.interface";

/**
 * Contract Virtual Machine Controller
 *
 * @export
 * @class VirtualMachine
 */
export class VirtualMachine extends events.EventEmitter
  implements IVirtualMachine {
  /**
   * Virtual Machine Object
   *
   * @private
   * @type {VM}
   * @memberof VirtualMachine
   */
  private virtual: NodeVM;

  private virtualInstance: any; // IVMObject;

  private contractReferences: IVMContractReferences;

  /**
   * Holds the event engine
   *
   * @private
   * @type {EventEngine}
   * @memberof VirtualMachine
   */
  private event: EventEngine;

  /**
   * When this VM timeout can not be extended past.
   *
   * @private
   * @type {Date}
   * @memberof VirtualMachine
   */
  private maxTimeout: Date;

  /**
   * Script execution status
   *
   * @private
   * @type {boolean}
   * @memberof VirtualMachine
   */
  private scriptFinishedExec: boolean = false;

  /**
   * Creates an instance of VirtualMachine.
   * @param {string} contractPath
   * @param {string} selfHost
   * @param {string} umid
   * @param {Date} cdate
   * @param {ActiveDefinitions.LedgerTransaction} tx
   * @param {ActiveDefinitions.LedgerSignatures} sigs
   * @param {ActiveDefinitions.LedgerStream[]} inputs
   * @param {ActiveDefinitions.LedgerStream[]} outputs
   * @param {ActiveDefinitions.LedgerIORputs} reads
   * @param {ActiveDSConnect} db
   * @param {ActiveDSConnect} dbev
   * @param {ActiveCrypto.Secured} secured
   * @memberof VirtualMachine
   */
  constructor(
    private selfHost: string,
    private secured: ActiveCrypto.Secured,
    private db: ActiveDSConnect,
    private dbev: ActiveDSConnect
  ) {
    super();
  }

  /**
   * Initialise the Virtual machine instance
   *
   * @private
   * @memberof VirtualMachine
   */
  public initialiseVirtualMachine(
    extraBuiltins?: string[],
    extraExternals?: string[]
  ): void {
    // Toolkit Availability Check
    let toolkitAvailable = true;
    try {
      require.resolve("@_activeledger/activetoolkits");
    } catch (error) {
      // Toolkits not installed
      toolkitAvailable = false;
    }

    // Manage Externals & buildit
    let external: string[] = [
      // this.contractPath,
      "@activeledger/activecontracts"
    ];
    let builtin: string[] = ["buffer"];

    // With toolkit allow additional externals & builtin
    if (toolkitAvailable) {
      external.push(
        "@activeledger/activeutilities",
        "@_activeledger/activetoolkits"
      );
      builtin.push("events", "http", "https", "url", "zlib");
    }

    // Add additional External & builtin by namespace if provided
    if (extraExternals) {
      external = [...external, ...extraExternals];
    }

    if (extraBuiltins) {
      builtin = [...builtin, ...extraBuiltins];
    }

    // Create limited VM
    this.virtual = new NodeVM({
      // This prevents data return using the new code, but might turn out to be needed after some testing
      // wrapper: "none",
      sandbox: {
        logger: ActiveLogger,
        crypto: ActiveCrypto,
        secured: this.secured,
        self: this.selfHost
      },
      require: {
        context: "sandbox",
        builtin,
        external
      }
    });

    // Pull in the code to use for the VMScript
    const script = new VMScript(
      fs.readFileSync(__dirname + "/vmscript.js", "utf-8")
    );

    // Initialise the virtual object using the VMScript
    this.virtualInstance = this.virtual.run(script, "avm.js");
  }

  /**
   * Extract All changed streams
   *
   * @returns {{ [reference: string]: Activity }}
   * @memberof VirtualMachine
   */
  public getActivityStreamsFromVM(
    umid: string
  ): ActiveDefinitions.LedgerStream[] {
    // Fetch Activities and prepare to check
    let activities: {
      [reference: string]: Activity;
    } = this.virtualInstance.getActivityStreams(umid);
    let streams: string[] = Object.keys(activities);
    let i = streams.length;

    // The exported streams with changes
    let exported: ActiveDefinitions.LedgerStream[] = [];

    // Loop each stream and find the marked ones
    while (i--) {
      if (activities[streams[i]].updated) {
        exported.push(
          activities[streams[i]].export2Ledger(
            this.contractReferences[umid].key
          )
        );
      }
    }
    return exported;
  }

  /**
   * Clear transaction from memory by umid
   *
   * @param {string} umid
   * @memberof VirtualMachine
   */
  public destroy(umid: string): void {
    // Clear inside VM
    this.virtualInstance.destroy(umid);
    // Clear references here
    if (this.contractReferences && this.contractReferences[umid]) {
      delete this.contractReferences[umid];
    }
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   * @memberof VirtualMachine
   */
  public getInternodeCommsFromVM(umid: string): any {
    return this.virtualInstance.getInternodeComms(umid);
  }

  /**
   * Are we suppose to clear the node comms
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public clearingInternodeCommsFromVM(umid: string): boolean {
    return this.virtualInstance.clearInternodeComms(umid);
  }

  /**
   * Data to send back to the requesting http client
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public getReturnContractData(umid: string): unknown {
    return this.virtualInstance.returnContractData(umid);
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   * @memberof VirtualMachine
   */
  public getThrowsFromVM(umid: string): string[] {
    return this.virtualInstance.throwFrom(umid);
  }

  /**
   * Get current working inputs of the contract (External to VM)
   *
   * @returns {ActiveDefinitions.LedgerStream[]}
   * @memberof VirtualMachine
   */
  public getInputs(umid: string): ActiveDefinitions.LedgerStream[] {
    return this.contractReferences[umid].inputs;
  }

  /**
   * Dynamically import the contract. Currently object is created outside VM and set as a global
   *
   * @returns {Promise<boolean>}
   * @memberof VirtualMachine
   */
  public initialise(
    payload: IVMDataPayload,
    contractName: string
  ): Promise<boolean> {
    // Return as promise for initalise
    return new Promise((resolve, reject) => {
      if (!this.contractReferences) {
        this.contractReferences = {};
      }

      this.contractReferences[payload.umid] = {
        contractName,
        inputs: payload.inputs,
        tx: payload.transaction,
        key: payload.key
      };

      // Setup Event Engine
      this.event = new EventEngine(this.dbev, payload.transaction.$contract);

      try {
        // Initialise Contract into VM (Will need to make sure require is not used and has been fully locked down)
        this.virtualInstance.initialiseContract(
          payload,
          new QueryEngine(this.db, true),
          this.event
        );

        // TODO: Finish implementing references

        // Set Sys Config
        if (payload.transaction.$namespace === "default") {
          this.virtualInstance.setSysConfig(
            payload.umid,
            JSON.stringify(ActiveOptions.fetch(false))
          );
        }

        // Start time initialise the date object
        this.maxTimeout = new Date();

        // Convert to max timeout date (Minutes converted to milliseconds)
        this.maxTimeout.setMilliseconds(
          ActiveOptions.get<number>("contractMaxTimeout", 20) * 60 * 1000
        );

        // Continue
        resolve(true);
      } catch (e) {
        if (e instanceof Error) {
          // Exception
          reject(this.catchException(e, payload.umid));
        }
      }
    });
  }

  /**
   * Run verify part of the smart contract
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public verify(sigless: boolean, umid: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("verify");

      // Manage Timeout
      this.checkTimeout(
        "verify",
        () => {
          reject("VM Error : Verify phase timeout");
        },
        umid
      );

      // Run Verify Phase
      this.virtualInstance
        .runVerify(umid, sigless)
        .then(() => {
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch((e: Error) => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e, umid));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Run vote part of the smart contract
   *
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  public vote(umid: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("vote");

      // Manage Timeout
      this.checkTimeout(
        "vote",
        () => {
          reject("VM Error : Vote phase timeout");
        },
        umid
      );

      // Run Vote Phase
      this.virtualInstance
        .runVote(umid)
        .then(() => {
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch((e: Error) => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e, umid));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Run commit part of the smart contract
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @param {boolean} possibleTerritoriality
   * @returns {Promise<boolean>}
   * @memberof VirtualMachine
   */
  public commit(
    nodes: ActiveDefinitions.INodes,
    possibleTerritoriality: boolean = false,
    umid: string
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes, umid);

      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("commit");

      // Manage Timeout
      this.checkTimeout(
        "commit",
        () => {
          reject("VM Error : Commit phase timeout");
        },
        umid
      );

      // Get Commit
      this.virtualInstance
        .runCommit(umid, possibleTerritoriality)
        .then(() => {
          // Here we may update the database from the objects (commit should return)
          // Or just manipulate / check the outputs
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch((e: any) => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e, umid));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Contract given the opportunity to reconcile itself when node voted no but network confimed
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @returns {Promise<boolean>}
   * @memberof VirtualMachine
   */
  public reconcile(
    nodes: ActiveDefinitions.INodes,
    umid: string
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes, umid);

      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("reconcile");

      // Manage Timeout
      this.checkTimeout(
        "reconcile",
        () => {
          reject("VM Error : Reconcile phase timeout");
        },
        umid
      );

      // Get Commit
      this.virtualInstance
        .reconcile(umid)
        .then(() => {
          // Here we may update the database from the objects (commit should return)
          // Or just manipulate / check the outputs
          this.scriptFinishedExec = true;
          resolve(true);
        })
        .catch((e: any) => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e, umid));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Do something after the commit phase, Territoriality is if this is the first post commit
   * running in the entire network
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   * @memberof VirtualMachine
   */
  public postProcess(
    territoriality: boolean,
    who: string,
    umid: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.event.setPhase("post");

      // Manage Timeout
      this.checkTimeout(
        "post",
        () => {
          reject("VM Error : Post phase timeout");
        },
        umid
      );

      // Run Post Process
      this.virtualInstance
        .postProcess(umid, territoriality, who)
        .then((postProcess: any) => {
          // Do something with the returned value
          // Maybe resolve with the data
          this.scriptFinishedExec = true;

          // Reload Configuration Required?
          if (this.contractReferences[umid].tx.$namespace == "default") {
            if (this.virtualInstance.reloadSysConfig(umid)) {
              ActiveLogger.info("Reloading Configuration Request");
              this.emit("reload");
            }
          }
          resolve(postProcess);
        })
        .catch((e: Error) => {
          if (e instanceof Error) {
            // Exception
            reject(this.catchException(e, umid));
          } else {
            // Rejected by contract
            reject(e);
          }
        });
    });
  }

  /**
   * Marshel the INcomms into the contract
   *
   * @private
   * @param {ActiveDefinitions.INodes} nodes
   * @memberof VirtualMachine
   */
  private incMarshel(nodes: ActiveDefinitions.INodes, umid: string): void {
    // Get Node Keys (Or get from Neighbourhood?)
    let keys = Object.keys(nodes);
    let i = keys.length;
    if (i) {
      let comms: ActiveDefinitions.ICommunications = {};
      // Quick Flag to check if its worth sending large into VM
      let sendComms = false;

      // Find any comms
      while (i--) {
        if (nodes[keys[i]].incomms) {
          comms[keys[i]] = nodes[keys[i]].incomms;
          if (!sendComms) sendComms = true;
        }
      }

      // Any Comms to send into VM (Alternative parse directly as JSON)
      if (sendComms) {
        return this.virtualInstance.setINC(
          umid,
          comms,
          this.contractReferences[umid].key
        );
      }
    }
  }

  /**
   * Check the VM has or hasn't timedout
   *
   * @private
   * @param {string} type
   * @param {Function} timedout
   * @memberof VirtualMachine
   */
  private checkTimeout(type: string, timedout: Function, umid: string): void {
    // Setup Timeout Ticket
    setTimeout(() => {
      // Has the script not finished
      if (!this.scriptFinishedExec) {
        // Has it extended its timeout
        if (!this.hasBeenExtended(umid)) {
          // Hasn't been extended so call function
          timedout();
        } else {
          // Check again later
          this.checkTimeout(type, timedout, umid);
        }
      }
    }, ActiveOptions.get<number>("contractCheckTimeout", 10000));
  }

  /**
   * Detect if the script is within timeout limits
   *
   * @private
   * @returns {boolean}
   * @memberof VirtualMachine
   */
  private hasBeenExtended(umid: string): boolean {
    // Fetch new time out request from the contract
    let timeoutRequestTime = this.virtualInstance.getTimeout(umid);

    // Did we get a return value to work on?
    if (timeoutRequestTime) {
      // if request time larger than current time extention has been requested
      // also check the request timeout is not larger than the maximum allowed
      if (
        this.maxTimeout > timeoutRequestTime &&
        timeoutRequestTime > new Date()
      ) {
        // Timeout has been extended correctly.
        return true;
      }
    }

    // Script has timed out
    return false;
  }

  /**
   * Manages Exceptions / Throws from a VM call
   *
   * @private
   * @param {Error} e
   * @returns {*}
   * @memberof VirtualMachine
   */
  private catchException(e: Error, umid: string): any {
    // Exception
    if (e.stack) {
      // Get Current Contract Filename only
      const contract = this.contractReferences[umid].contractName;

      // Find Contract Code in Stacktrace
      const contractErrorLine = e.stack.match(
        new RegExp(`^.*${contract}.*$`, "m")
      );

      // Was our contract in the stack trace
      if (contractErrorLine && contractErrorLine.length) {
        // Get First Match
        const contractLastCallLine = contractErrorLine[0].trim();

        // Find Contract Start
        const lastIndexFolder = contractLastCallLine.indexOf(contract) + 1;

        // Extract Contract + Line Numbers
        let contractErrorInfo = contractLastCallLine.substring(
          lastIndexFolder,
          contractLastCallLine.length
        );

        return {
          error: e.message,
          at: contractErrorInfo
        };
      } else {
        // Degrade to first line from the trace
        // Get file with line numbers
        let msg = e.stack
          .split("\n", 2)[1]
          .trim()
          .replace(/.*\(|\)/gi, "");

        // Extract Line numbers
        // Add Contract Name
        msg = contract + ":" + msg.substr(msg.indexOf(".js") + 4);

        //return reject(e.message + "@" + msg);
        return {
          error: e.message,
          at: msg
        };
      }
    } else {
      return e.message;
    }
  }
}
