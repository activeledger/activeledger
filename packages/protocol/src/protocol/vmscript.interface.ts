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
  setContractPath: Function;
  setUMID: Function;
  setDate: Function;
  setRemoteAddress: Function;
  setTransaction: Function;
  setSignatures: Function;
  setInputs: Function;
  setOutputs: Function;
  setReads: Function;
  setKey: Function;
}
