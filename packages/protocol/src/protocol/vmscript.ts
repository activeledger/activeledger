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

import { Activity, PostProcessQueryEvent } from "@activeledger/activecontracts";
import { EventEngine } from "@activeledger/activequery";
import {
  IVMDataPayload,
  IVMObject,
  IVMInternalCache,
} from "./interfaces/vm.interface";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { EventEmitter } from "events";

/**
 * Controls execution of contracts within the running VM
 *
 * @class ContractControl
 * @implements {IVMObject}
 */
class ContractControl implements IVMObject {
  /**
   * Cache of initialised smart contracts
   *
   * @private
   * @type {IVMInternalCache}
   * @memberof ContractControl
   */
  private smartContracts: IVMInternalCache;

  constructor() {
    this.smartContracts = {};
  }

  // #region Contract controls

  /**
   * Initialise the contract using the data provided via the dataPass function
   *
   * @param {*} query
   * @param {EventEngine} event
   * @memberof ContractControl
   */
  public initialiseContract(
    payload: IVMDataPayload,
    // query: any,
    event: EventEngine,
    emitter: EventEmitter
  ): void {

    // If no contract data set then provide an empty object so the contract 
    // doesn't just get null
    const contractData = payload.contractData?.data
      ? payload.contractData
      : {};

    // We don't need to verify the code unless we suspect server has been
    // comprimised. We will verify with the "install" routine
    this.smartContracts[payload.umid] =
      new (require(payload.contractLocation).default)(
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
        emitter,
        (global as any).self
      );

    // if ("setQuery" in this.smartContracts[payload.umid]) {
    //   (this.smartContracts[payload.umid] as PostProcessQueryEvent).setQuery(
    //     query
    //   );
    // }

    if ("setEvent" in this.smartContracts[payload.umid]) {
      (this.smartContracts[payload.umid] as PostProcessQueryEvent).setEvent(
        event
      );
    }
  }

  /**
   * Get the activity stream data
   *
   * @returns {{ [reference: string]: Activity }}
   * @memberof ContractControl
   */
  public getActivityStreams(umid: string): { [reference: string]: Activity } {
    return this.smartContracts[umid].getActivityStreams();
  }

  /**
   * Get data to be stored linked to this contract
   *
   * @returns {*}
   * @memberof ContractControl
   */
  public getContractData(umid: string): ActiveDefinitions.IContractData | undefined {
    if (this.smartContracts[umid].updatedContractData) {
      return this.smartContracts[umid].exportContractData();
    }
  }
  /**
   * Set the internode communications
   *
   * @param {string} umid
   * @param {ActiveDefinitions.ICommunications} comms
   * @param {number} key
   * @memberof ContractControl
   */
  public setInternodeComms(
    umid: string,
    comms: ActiveDefinitions.ICommunications,
    key: number
  ): void {
    this.smartContracts[umid].setInterNodeComms(key, comms);
  }

  /**
   * Get the inter-node communication
   *
   * @returns {*}
   * @memberof ContractControl
   */
  public getInternodeComms(umid: string): any {
    return this.smartContracts[umid].getThisInterNodeComms();
  }

  /**
   * Clear the inter-node communication
   *
   * @returns {boolean}
   * @memberof ContractControl
   */
  public clearInternodeComms(umid: string): boolean {
    return this.smartContracts[umid].getClearInterNodeComms();
  }

  /**
   * Get the contract data
   *
   * @returns {unknown}
   * @memberof ContractControl
   */
  public returnContractData(umid: string): unknown {
    return this.smartContracts[umid].getReturnToRemote();
  }

  /**
   * Throw to the caller
   *
   * @returns {string[]}
   * @memberof ContractControl
   */
  public throwFrom(umid: string): string[] {
    return this.smartContracts[umid].throwTo;
  }

  /**
   * Run the voting round of the contract
   *
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public runRead(umid: string, readMethod: string): Promise<unknown> {
    const read = (this.smartContracts[umid] as any)[readMethod]?.();
    return read ? read : false;
  }

  /**
   * Run the verification round of the contract
   *
   * @param {boolean} sigless
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public async runVerify(umid: string, sigless: boolean): Promise<boolean> {
    // Skip verify if doesn't exist
    const verify = this.smartContracts[umid].verify?.(sigless);
    return verify ? verify : true;
  }

  /**
   * Run the voting round of the contract
   *
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public runVote(umid: string): Promise<boolean> {
    return this.smartContracts[umid].vote();
  }

  /**
   * Run the commit round of the contract
   *
   * @param {boolean} possibleTerritoriality
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public runCommit(
    umid: string,
    possibleTerritoriality: boolean
  ): Promise<boolean> {
    return this.smartContracts[umid].commit(possibleTerritoriality);
  }

  /**
   * Run the post processing of the contract
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   * @memberof ContractControl
   */
  public postProcess(
    umid: string,
    territoriality: boolean,
    who: string
  ): Promise<any> {
    if ("postProcess" in this.smartContracts[umid]) {
      // Run post process
      return (this.smartContracts[umid] as PostProcessQueryEvent).postProcess(
        territoriality,
        who
      );
    } else {
      // Auto resolve if no post process
      return Promise.resolve();
    }
  }

  /**
   * Run the reconcile process of the contract
   *
   * @param {string} umid
   * @returns {Promise<any>}
   * @memberof ContractControl
   */
  public reconcile(umid: string): Promise<any> {
    if ("reconcile" in this.smartContracts[umid]) {
      // Run reconcile process
      return this.smartContracts[umid].reconcile!();
    } else {
      // Auto resolve if no reconcile process
      return Promise.resolve();
    }
  }

  /**
   * Clear smart contract transaction from memory
   *
   * @param {string} umid
   * @memberof ContractControl
   */
  public destroy(umid: string): void {
    delete this.smartContracts[umid];
  }

  /**
   * Get the current timeout of the contract
   *
   * @returns {Date}
   * @memberof ContractControl
   */
  public getTimeout(umid: string): Date | null {
    return this.smartContracts[umid]
      ? this.smartContracts[umid].getTimeout()
      : null;
  }

  // #endregion

  // #region Contract setup

  /**
   * Set the system configuration data
   *
   * @param {*} sysConfig
   * @memberof ContractControl
   */
  public setSysConfig(umid: string, sysConfig: any): void {
    if ("sysConfig" in this.smartContracts[umid]) {
      (this.smartContracts[umid] as unknown as any).sysConfig(sysConfig);
    }
  }

  /**
   * Reload the sys config
   *
   * @returns {boolean}
   * @memberof ContractControl
   */
  public reloadSysConfig(umid: string): boolean {
    if ("sysConfig" in this.smartContracts[umid]) {
      return (this.smartContracts[umid] as unknown as any).configReload();
    } else {
      return false;
    }
  }

  // #endregion
}

module.exports = (function() {
  return new ContractControl();
})();
