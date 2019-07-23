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
    query: any,
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
  contractString: string;
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

  initialise(payload: IVMDataPayload, contractName: string): Promise<boolean>;

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
