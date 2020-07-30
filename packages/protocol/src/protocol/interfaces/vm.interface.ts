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
import {
  Standard,
  PostProcessQueryEvent,
  Activity
} from "@activeledger/activecontracts";
import { EventEngine } from "@activeledger/activequery";
import { EventEmitter } from "events";

export interface IVMObject {
  initialiseContract(
    payload: IVMDataPayload,
    //query: any,
    event: EventEngine,
    emitter: EventEmitter
  ): void;
  getActivityStreams(umid: string): { [reference: string]: Activity };
  getInternodeComms(umid: string): any;
  clearInternodeComms(umid: string): boolean;
  returnContractData(umid: string): unknown;
  throwFrom(umid: string): string[];
  runVerify(umid: string, sigless: boolean): Promise<boolean>;
  runVote(umid: string): Promise<boolean>;
  runCommit(umid: string, possibleTerritoriality: boolean): Promise<boolean>;
  postProcess(umid: string, territoriality: boolean, who: string): Promise<any>;
  destroy(umid: string): void;
  getTimeout(umid: string): Date | null;
  setSysConfig(umid: string, sysConfig: any): void;
  reloadSysConfig(umid: string): boolean;
}

export interface IVMDataPayload {
  contractLocation: string;
  umid: string;
  date: Date;
  remoteAddress: string;
  transaction: ActiveDefinitions.LedgerTransaction;
  signatures: ActiveDefinitions.LedgerSignatures;
  inputs: ActiveDefinitions.LedgerStream[];
  outputs: ActiveDefinitions.LedgerStream[];
  readonly: ActiveDefinitions.LedgerIORputs;
  key: number;
}

export interface IVMInternalCache {
  [umid: string]: PostProcessQueryEvent | Standard;
}

export interface IContractKeyHolder {
  [umid: string]: number;
}

interface IVMContractReferenceData {
  contractName: string;
  inputs: ActiveDefinitions.LedgerStream[];
  tx: ActiveDefinitions.LedgerTransaction;
  key: number;
}

export interface IVMContractReferences {
  [umid: string]: IVMContractReferenceData;
}

export interface IVMContractHolder {
  [namespace: string]: IVirtualMachine;
}

export interface IVirtualMachine {
  initialiseVirtualMachine(
    extraBuiltins?: string[],
    extraExternals?: string[]
  ): void;

  getActivityStreamsFromVM(umid: string): ActiveDefinitions.LedgerStream[];

  getInternodeCommsFromVM(umid: string): any;

  clearingInternodeCommsFromVM(umid: string): boolean;

  getReturnContractData(umid: string): unknown;

  getThrowsFromVM(umid: string): string[];

  destroy(umid: string): void;

  getInputs(umid: string): ActiveDefinitions.LedgerStream[];

  initialise(payload: IVMDataPayload, contractName: string): Promise<void>;

  verify(sigless: boolean, umid: string): Promise<boolean>;

  vote(umid: string): Promise<boolean>;

  commit(
    nodes: ActiveDefinitions.INodes,
    possibleTerritoriality: boolean,
    umid: string
  ): Promise<boolean>;

  postProcess(territoriality: boolean, who: string, umid: string): Promise<any>;

  reconcile(nodes: ActiveDefinitions.INodes, umid: string): Promise<boolean>;
}
