import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Activity } from "@activeledger/activecontracts";

module.exports = (function() {
  let contractPath: string;
  let umid: string;
  let cdate: Date;
  let remoteAddr: string;
  let tx: ActiveDefinitions.LedgerTransaction;
  let sigs: ActiveDefinitions.LedgerSignatures;
  let inputs: ActiveDefinitions.LedgerStream[];
  let outputs: ActiveDefinitions.LedgerStream[];
  let reads: ActiveDefinitions.LedgerIORputs;
  let key: number;

  return {
    // Control functions
    initialiseContract: (): void => {},
    getActivityStreams: (): Activity[] => {
      return [];
    },
    getInternodeComms: (): any => {},
    clearInternodeComms: (): boolean => {
      return false;
    },
    returnContractData: (): boolean => {
      return false;
    },
    throwTo: (): string[] => {
      return [];
    },
    setQuery: (): void => {}, // TODO: IS this needed here? Can put in init
    setEvent: (): void => {}, // TODO: IS this needed here? Can put in init
    setSysConfig: (): void => {},
    runVerify: (): Promise<boolean> => {
      return new Promise((resolve, reject) => {});
    },
    runVote: (): Promise<boolean> => {
      return new Promise((resolve, reject) => {});
    },
    runCommit: (): Promise<boolean> => {
      return new Promise((resolve, reject) => {});
    },
    setPostProcess: (): Promise<any> => {
      return new Promise((resolve, reject) => {});
    },
    getTimeout: (): number => {
      return 0;
    },
    // Setup functions
    setContractPath: (path: string) => {
      contractPath = path;
    },
    setUMID: (_umid: string) => {
      umid = _umid;
    },
    setDate: (_cDate: Date) => {
      cdate = _cDate;
    },
    setRemoteAddress: (address: string) => {
      remoteAddr = address;
    },
    setTransaction: (transaction: ActiveDefinitions.LedgerTransaction) => {
      tx = transaction;
    },
    setSignatures: (signatures: ActiveDefinitions.LedgerSignatures) => {
      sigs = signatures;
    },
    setInputs: (_inputs: ActiveDefinitions.LedgerStream[]) => {
      inputs = _inputs;
    },
    setOutputs: (_outputs: ActiveDefinitions.LedgerStream[]) => {
      outputs = _outputs;
    },
    setReads: (_reads: ActiveDefinitions.LedgerIORputs) => {
      reads = _reads;
    },
    setKey: (_key: number) => {
      key = _key;
    }
  };
})();
