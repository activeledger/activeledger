import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { VirtualMachine } from "./vm";

export interface IVMObject {
  initialiseContract: Function;
  getActivityStreams: Function;
  getInternodeComms: Function;
  clearInternodeComms: Function;
  returnContractData: Function;
  throwFrom: Function;
  runVerify: Function;
  runVote: Function;
  runCommit: Function;
  postProcess: Function;
  getTimeout: Function;
  dataPass: Function;
  setSysConfig: Function;
  reloadSysConfig: Function;
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

interface IVMContractReferenceData {
  contractName: string;
  inputs: ActiveDefinitions.LedgerStream[];
  tx: ActiveDefinitions.LedgerTransaction;
}

export interface IVMContractReferences {
  [umid: string]: IVMContractReferenceData;
}

export interface IVMContractHolder {
  [name: string]: VirtualMachine;
}
