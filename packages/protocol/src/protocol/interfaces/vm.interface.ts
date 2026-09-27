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
  Activity,
  PostProcessEvent,
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
  contractData?: ActiveDefinitions.IContractData | undefined | null;
}

export interface IVMInternalCache {
  [umid: string]: PostProcessEvent | Standard;
}

export interface IContractKeyHolder {
  [umid: string]: number;
}

interface IVMContractReferenceData {
  contractName: string;
  contractLocation: string;
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
    extraExternals?: string[],
    extraMocks?: string[]
  ): void;

  getActivityStreamsFromVM(umid: string): ActiveDefinitions.LedgerStream[];

  getNewContractData(umid: string): boolean;

  getInternodeCommsFromVM(umid: string): any;

  clearingInternodeCommsFromVM(umid: string): boolean;

  getReturnContractData(umid: string): unknown;

  getThrowsFromVM(umid: string): string[];

  getEvents(umid: string): any[];

  destroy(umid: string): void;

  getInputs(umid: string): ActiveDefinitions.LedgerStream[];

  initialise(payload: IVMDataPayload, contractName: string): Promise<void>;

  read(umid: string, readMethod: string): Promise<unknown>;

  verify(sigless: boolean, umid: string): Promise<boolean>;

  vote(nodes: ActiveDefinitions.INodes, umid: string): Promise<boolean | { leader: boolean }>;

  commit(
    nodes: ActiveDefinitions.INodes,
    possibleTerritoriality: boolean,
    umid: string
  ): Promise<boolean>;

  postProcess(territoriality: boolean, who: string, umid: string): Promise<any>;

  reconcile(nodes: ActiveDefinitions.INodes, umid: string): Promise<any>;
}

/**
 * A contract-isolation backend. Registered on the VirtualMachine to run
 * untrusted contracts outside the node's own process when the node is
 * configured for public deployment (security.contractIsolation === "isolate").
 *
 * The default node ships no backend: contract source is admitted by the
 * static securityScan() denylist and then run in-process. That boundary is
 * appropriate for permissioned/trusted deployment, where only known
 * identities may deploy into a namespace. A node that accepts contracts from
 * arbitrary deployers should not rely on a source scanner alone - it should
 * run each contract behind a structural isolate (e.g. isolated-vm) and demote
 * the scanner to defence-in-depth. This is that seam.
 *
 * A backend's load() returns a factory whose instantiate() yields an object
 * that is API-compatible with an in-process contract instance (the Standard /
 * PostProcessEvent surface the VirtualMachine drives), so the rest of the VM
 * is unchanged whether a contract runs in-process or isolated.
 */
export interface IContractIsolateBackend {
  /** Identifier used in logs and errors, e.g. "isolated-vm". */
  readonly name: string;
  /** Load a contract's constructable from disk into the isolate. */
  load(
    contractLocation: string
  ): Promise<IIsolatedContractFactory> | IIsolatedContractFactory;
}

/** Factory for a loaded, isolated contract - constructs an instance per umid. */
export interface IIsolatedContractFactory {
  instantiate(constructorArgs: unknown[]): Promise<unknown> | unknown;
}
