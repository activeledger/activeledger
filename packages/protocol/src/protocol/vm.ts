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
import { Activity, PostProcessQueryEvent } from "@activeledger/activecontracts";
import { QueryEngine, EventEngine } from "@activeledger/activequery";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
//import { NodeVM, VMScript } from "@activeledger/vm2";
import { setTimeout } from "timers";
import * as fs from "fs";
import { EventEmitter } from "events";
import {
  IVMDataPayload,
  IVMContractReferences,
  IVirtualMachine,
} from "./interfaces/vm.interface";
import { createInterface } from "readline";
//import { ContractControl } from "./vmscript";

/**
 * Contract Virtual Machine Controller
 *
 * @export
 * @class VirtualMachine
 */
export class VirtualMachine
  extends events.EventEmitter
  implements IVirtualMachine {
  /**
   * Cache of initialised smart contracts
   *
   * @private
   * @type {IVMInternalCache}
   */
  private smartContracts: { [umid: string]: any } = {};

  /**
   * Caches the constructable contract
   *
   * @private
   */
  private contracts: { [location: string]: any } = {};

  /**
   * Virtual Machine Object
   *
   * @private
   * @type {VM}
   */
  //private virtual: NodeVM;

  /**
   * Holds the VM instance
   *
   * @private
   * @type {*}
   */
  private virtualInstance: any; // IVMObject;

  /**
   * References to the contracts
   *
   * @private
   * @type {IVMContractReferences}
   */
  private contractReferences: IVMContractReferences;

  /**
   * Holds the event engine
   *
   * @private
   * @type {{ [umid: string]: EventEngine }}
   */
  private events: { [umid: string]: EventEngine } = {};

  /**
   * Holds the event emitter
   *
   * @private
   * @type {EventEmitter}
   */
  private emitter: EventEmitter;

  /**
   * When this VM timeout can not be extended past.
   *
   * @private
   * @type {Date}
   */
  private maxTimeout: Date;

  /**
   * Script execution status
   *
   * @private
   * @type {boolean}
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
   */
  constructor(
    private selfHost: string,
    private secured: ActiveCrypto.Secured,
    private db: ActiveDSConnect,
    private dbev: ActiveDSConnect
  ) {
    super();
    // Initialise the emitter for listening and pass through to the contract
    this.emitter = new EventEmitter();
    // Start volatile event listener
    this.listenForVolatile();
    // start all stream fetching
    this.listenForFetch();
    // Directly assign the script controller instance
  }

  /**
   * Initialise the Virtual machine instance
   *
   * @private
   */
  public initialiseVirtualMachine(): void {
    // This method is now a stub since vm2 is removed.
    // The virtualInstance is assigned in the constructor.
    // This can be removed in a future refactor.
  }

  /**
   * Extract All changed streams
   *
   * @returns {{ [reference: string]: Activity }}
   */
  public getActivityStreamsFromVM(
    umid: string
  ): ActiveDefinitions.LedgerStream[] {
    // Fetch Activities and prepare to check
    let activities: {
      [reference: string]: Activity;
    } = this.smartContracts[umid].getActivityStreams();
    let streams: string[] = Object.keys(activities);
    let i = streams.length;

    let contractData: ActiveDefinitions.IContractData | undefined;
    if (this.smartContracts[umid].updatedContractData) {
      contractData = this.smartContracts[umid].exportContractData();
    }

    // The exported streams with changes
    let exported: ActiveDefinitions.LedgerStream[] = [];

    if (contractData) {
      exported.push(contractData as unknown as ActiveDefinitions.LedgerStream);
    }

    // Loop each stream and find the marked ones
    while (i--) {
      if (activities[streams[i]].updated) {
        // Activities have it referenced now
        const stream: any = {
          //@ts-ignore
          state: activities[streams[i]].state
        }
        
        if (activities[streams[i]].updatedMeta) {
          //@ts-ignore
          stream.meta = activities[streams[i]].meta;
        }

        if (activities[streams[i]].volatileUpdated) {
          //@ts-ignore
          stream.volatile = activities[streams[i]].volatile;
        }

        exported.push(stream)
      }
    }

    return exported;
  }

  /**
   * Fetch if contract data got updated
   *
   * @param {string} umid
   * @return {*}  {boolean}
   */
  public getNewContractData(
    umid: string
  ): boolean {
    if (this.smartContracts[umid].updatedContractData) {
      return this.smartContracts[umid].exportContractData();
    }
    return false;
  }

  /**
   * Clear transaction from memory by umid
   *
   * @param {string} umid
   */
  public destroy(umid: string): void {
    try {
      if (this.smartContracts[umid] && "shutdown" in this.smartContracts[umid]) {
        ActiveLogger.info(`[AC] - Calling Shutdown - ${umid}`);
        this.smartContracts[umid].shutdown!();
      }
      setTimeout(() => {
        delete this.smartContracts[umid];
        delete this.events[umid];
      }, 5000);
    } catch {
      // Already deleted?
    }
    
    // Clear references here
    if (this.contractReferences && this.contractReferences[umid]) {
      delete this.contractReferences[umid];
    }
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   */
  public getInternodeCommsFromVM(umid: string): any {
    return this.smartContracts[umid].getThisInterNodeComms();
  }

  /**
   * Are we suppose to clear the node comms
   *
   * @returns {boolean}
   */
  public clearingInternodeCommsFromVM(umid: string): boolean {
    return this.smartContracts[umid].getClearInterNodeComms();
  }

  /**
   * Data to send back to the requesting http client
   *
   * @returns {boolean}
   */
  public getReturnContractData(umid: string): unknown {
    return this.smartContracts[umid].getReturnToRemote();
  }

  /**
   * Gets any internode communication to pass to other nodes.
   *
   * @returns {any}
   */
  public getThrowsFromVM(umid: string): string[] {
    return this.smartContracts[umid].throwTo;
  }

  /**
   * Get current working inputs of the contract (External to VM)
   *
   * @returns {ActiveDefinitions.LedgerStream[]}
   */
  public getInputs(umid: string): ActiveDefinitions.LedgerStream[] {
    return this.contractReferences[umid].inputs;
  }

  /**
   * Dynamically import the contract.
   *
   * @returns {Promise<void>}
   */
  public initialise(
    payload: IVMDataPayload,
    contractName: string
  ): Promise<void> {
    if (!this.contractReferences) {
      this.contractReferences = {};
    }

    this.contractReferences[payload.umid] = {
      contractName,
      contractLocation: payload.contractLocation,
      inputs: payload.inputs,
      tx: payload.transaction,
      key: payload.key,
    };

    // Setup Event Engine
    this.events[payload.umid] = new EventEngine(this.dbev, payload.transaction.$contract, payload.umid);

    return Promise.resolve()
      .then(() => {
        // Initialise Contract into VM
        const contractData = payload.contractData?.data ? payload.contractData : {};

        // Fetch Contract Constructable 
        if (!this.contracts[payload.contractLocation]) {
          this.contracts[payload.contractLocation] = require(payload.contractLocation).default;
        }

        this.smartContracts[payload.umid] =
          new this.contracts[payload.contractLocation](
            payload.date,
            payload.remoteAddress,
            payload.umid,
            payload.transaction,
            payload.inputs,
            payload.outputs,
            payload.readonly,
            contractData,
            payload.signatures,
            payload.key,
            this.emitter,
            this.selfHost
          );

        if ("setEvent" in this.smartContracts[payload.umid]) {
          (this.smartContracts[payload.umid] as PostProcessQueryEvent).setEvent(
            this.events[payload.umid]
          );
        }

        if ("setQuery" in this.smartContracts[payload.umid]) {
          (this.smartContracts[payload.umid] as PostProcessQueryEvent).setQuery(
            new QueryEngine(this.db, true)
          );
        }

        // Set Sys Config for default namespace contracts
        if (payload.transaction.$namespace === "default") {
          if ("sysConfig" in this.smartContracts[payload.umid]) {
            (this.smartContracts[payload.umid] as unknown as any).sysConfig(
              JSON.parse(JSON.stringify(ActiveOptions.fetch(false)))
            );
          }
        }

        // Set the maximum timeout for this contract execution
        this.maxTimeout = new Date();
        this.maxTimeout.setMilliseconds(
          ActiveOptions.get<number>("contractMaxTimeout", 20) * 60 * 1000
        );
      })
      .catch(async (e) => {
        // Rethrow a formatted exception
        throw await this.catchException(e, payload.umid);
      });
  }

  /**
   * Set phase in event engine
   *
   * Checks to make sure event object exists due to an occurance
   * where it can be undefined. Source of the problem to be found only happens
   * with the spam tool, This is allows for spam to continue.
   *
   * @private
   * @param {string} phase
   */
  private setPhase(phase: string, umid: string) {
    if (this.events[umid]) {
      this.events[umid].setPhase(phase);
    }
  }

  /**
   * Run an unknown contract read function
   *
   * @returns {Promise<boolean>}
   */
  public async read(umid: string, readMethod: string): Promise<unknown> {
    return new Promise(async (resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.setPhase("read", umid);

      // Manage Timeout
      this.checkTimeout(
        readMethod,
        () => {
          reject("VM Error : Read phase timeout");
        },
        umid
      );

      try {
        // Get Commit
        const read = (this.smartContracts[umid] as any)[readMethod]?.();
        resolve(read ? read : false);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Read - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec = true;
      }
    });
  }

  /**
   * Run verify part of the smart contract
   *
   * @returns {boolean}
   */
  public verify(sigless: boolean, umid: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.setPhase("verify", umid);

      // Manage Timeout
      this.checkTimeout(
        "verify",
        () => {
          reject("VM Error : Verify phase timeout");
        },
        umid
      );

      try {
        // Run Verify Phase
        const verify = this.smartContracts[umid].verify?.(sigless);
        resolve(verify ? verify : true);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Verify - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec = true;
      }
    });
  }

  /**
   * Run vote part of the smart contract
   *
   * @returns {boolean}
   */
  public vote(nodes: ActiveDefinitions.INodes, umid: string): Promise<boolean | { leader: boolean }> {
    return new Promise<boolean | { leader: boolean }>(async (resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes, umid);

      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.setPhase("vote", umid);

      // Manage Timeout
      this.checkTimeout(
        "vote",
        () => {
          reject("VM Error : Vote phase timeout");
        },
        umid
      );

      try {
        // Run Vote Phase
        resolve(await this.smartContracts[umid].vote());
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Vote - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec = true;
      }
    });
  }

  /**
   * Run commit part of the smart contract
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @param {boolean} possibleTerritoriality
   * @returns {Promise<boolean>}
   */
  public commit(
    nodes: ActiveDefinitions.INodes,
    possibleTerritoriality: boolean = false,
    umid: string
  ): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      // Manage INC
      this.incMarshel(nodes, umid);

      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.setPhase("commit", umid);

      // Manage Timeout
      this.checkTimeout(
        "commit",
        () => {
          reject("VM Error : Commit phase timeout");
        },
        umid
      );

      try {
        // Get Commit
        await this.smartContracts[umid].commit(possibleTerritoriality);
        // Here we may update the database from the objects (commit should return)
        // Or just manipulate / check the outputs
        resolve(true);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Commit - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec = true;
      }
    });
  }

  /**
   * Contract given the opportunity to reconcile itself when node voted no but network confimed
   *
   * @param {ActiveDefinitions.INodes} nodes
   * @returns {Promise<any>}
   */
  public reconcile(
    nodes: ActiveDefinitions.INodes,
    umid: string
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      try {
        // Manage INC
        this.incMarshel(nodes, umid);

        // Script running flag
        this.scriptFinishedExec = false;

        // Upgrade Phase
        this.setPhase("reconcile", umid);
        // Manage Timeout
        this.checkTimeout(
          "reconcile",
          () => {
            reject("VM Error : Reconcile phase timeout");
          },
          umid
        );

        // Get Commit
        let result: any = Promise.resolve();
        if (this.smartContracts[umid].reconcile) {
          result = this.smartContracts[umid].reconcile!();
        }
        
        // Here we may update the database from the objects (commit should return)
        // Or just manipulate / check the outputs
        resolve(await result);
      } catch (error) {
        ActiveLogger.debug(error, `VM Contract Reconcile - Error`);
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec = true;
      }
    });
  }

  /**
   * Do something after the commit phase, Territoriality is if this is the first post commit
   * running in the entire network
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   */
  public postProcess(
    territoriality: boolean,
    who: string,
    umid: string
  ): Promise<any> {
    return new Promise(async (resolve, reject) => {
      // Script running flag
      this.scriptFinishedExec = false;

      // Upgrade Phase
      this.setPhase("post", umid);

      // Manage Timeout
      this.checkTimeout(
        "post",
        () => {
          reject("VM Error : Post phase timeout");
        },
        umid
      );

      try {
        // Run Post Process
        let result: any = Promise.resolve();
        if ("postProcess" in this.smartContracts[umid]) {
          result = (this.smartContracts[umid] as PostProcessQueryEvent).postProcess(
            territoriality,
            who
          );
        }
        
        // Reload Configuration Required?
        if (this.contractReferences[umid].tx.$namespace == "default") {
          if ("sysConfig" in this.smartContracts[umid]) {
            if ((this.smartContracts[umid] as any).configReload()) {
              ActiveLogger.info("Reloading Configuration Request");
              this.emit("reload");
            }
          }
        }
        resolve(await result);
      } catch (error) {
        if (error instanceof Error) {
          // Exception
          reject(await this.catchException(error, umid));
        } else {
          // Rejected by contract
          reject(error);
        }
      } finally {
        this.scriptFinishedExec = true;
      }
    });
  }

  /**
   * Marshel the INcomms into the contract
   *
   * @private
   * @param {ActiveDefinitions.INodes} nodes
   */
  private incMarshel(nodes: ActiveDefinitions.INodes, umid: string): void {
    // Get Node Keys (Or get from Neighbourhood?)
    let keys = Object.keys(nodes);

    if (keys) {
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
          return this.smartContracts[umid].setInterNodeComms(
            this.contractReferences[umid].key,
            comms
          );
        }
      }
    }
  }

  // ? Not sure if this is needed??
  // public getVolatile() {}

  private listenForVolatile(): void {
    this.emitter.on("getVolatile", async (umid: string, streamId: string) => {
      try {
        const volatile: ActiveDefinitions.IVolatile = await this.db.get(
          `${streamId}:volatile`
        );
        this.emitter.emit(`volatileFetched-${umid}${streamId}`, null, volatile);
      } catch (error) {
        this.emitter.emit(`volatileFetched-${umid}${streamId}`, error);
      }
    });
  }

  /**
   * Allow for any stream data to be fetched during contract execution
   *
   * @private
   */
  private listenForFetch(): void {
    this.emitter.on("getStreamData", async (umid: string, streamId: string) => {
      try {
        const data: ActiveDefinitions.IStream = await this.db.get(streamId);
        this.emitter.emit(
          `getStreamDataFetched-${umid}${streamId}`,
          null,
          data
        );
      } catch (error) {
        this.emitter.emit(`getStreamDataFetched-${umid}${streamId}`, error);
      }
    });
  }

  /**
   * Check the VM has or hasn't timedout
   *
   * @private
   * @param {string} type
   * @param {Function} timedout
   */
  private checkTimeout(type: string, timedout: Function, umid: string): void {
    // This function recursively checks if a contract phase has timed out.
    setTimeout(() => {
      // If the script is still running...
      if (!this.scriptFinishedExec) {
        // ...check if the contract has requested a timeout extension.
        if (this.hasBeenExtended(umid)) {
          // If extended, check again later.
          this.checkTimeout(type, timedout, umid);
        } else {
          // If not extended, trigger the timeout function.
          timedout();
        }
      }
    }, ActiveOptions.get<number>("contractCheckTimeout", 10000));
  }

  /**
   * Detect if the script is within timeout limits
   *
   * @private
   * @returns {boolean}
   */
  private hasBeenExtended(umid: string): boolean {
    // Fetch new time out request from the contract
    let timeoutRequestTime = this.smartContracts[umid].getTimeout();

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
   */
  private async catchException(e: Error, umid: string): Promise<any> {
    // Exception
    if (
      e.stack &&
      umid &&
      this.contractReferences &&
      this.contractReferences[umid]?.contractName
    ) {
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
        const lastIndexFolder = contractLastCallLine.indexOf(contract);

        // Extract Contract + Line Numbers
        let contractErrorInfo = contractLastCallLine.substring(
          lastIndexFolder,
          contractLastCallLine.length
        );

        // This should already be filtered at the output but double check as it
        // will also prevent reading files
        let line;
        if (ActiveOptions.get<boolean>("debug", false)) {
          line = (
            await this.readNthLine(
              this.contractReferences[umid].contractLocation,
              parseInt(
                contractErrorInfo.substring(
                  contractErrorInfo.indexOf(":") + 1,
                  contractErrorInfo.lastIndexOf(":")
                )
              )
            )
          ).trim();
        }

        return {
          error: e.message,
          at: contractErrorInfo,
          line,
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
          at: msg,
        };
      }
    } else {
      return e.message;
    }
  }

  /**
   * Stream reads specific line from file (Debugging only)
   *
   * @private
   * @param {string} file
   * @param {number} nthLine
   * @returns {Promise<string>}
   */
  private async readNthLine(file: string, nthLine: number): Promise<string> {
    const rl = createInterface({
      input: fs.createReadStream(file),
    });

    // Loop lines searching for nth
    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      if (lineNumber === nthLine) {
        // Found close and return
        rl.close();
        return line;
      }
    }
    // Didn't find still close and return empty
    rl.close();
    return "";
  }
}
