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
}

export interface IVMDataPayload {
  contractPath: string;
  umid: string;
  date: string;
  remoteAddress: string;
  transaction: string;
  signatures: string;
  inputs: string;
  outputs: string;
  reads: string;
  key: string;
}
