import { ActiveDefinitions } from "@activeledger/activedefinitions";
import {
  Activity,
  Standard,
  PostProcessQueryEvent
} from "@activeledger/activecontracts";
import { EventEngine } from "@activeledger/activequery";
import { ActiveOptions } from "@activeledger/activeoptions";

module.exports = (function() {
  // Smart Contract holder
  let smartContract: Standard | PostProcessQueryEvent;

  // Path to the contract
  let contractPath: string;

  // UMID - Unique Message Identification
  let umid: string;

  // Time of execution syncronised between Activeledger nodes - Used to replace using Date inside a contract
  let cdate: Date;

  // The inbound address of the transaction
  let remoteAddr: string;

  // The transaction being run
  let tx: ActiveDefinitions.LedgerTransaction;

  // Transaction signatures
  let sigs: ActiveDefinitions.LedgerSignatures;

  // Transaction inputs
  let inputs: ActiveDefinitions.LedgerStream[];

  // Transaction outputs
  let outputs: ActiveDefinitions.LedgerStream[];

  // Transaction read only
  let reads: ActiveDefinitions.LedgerIORputs;

  // Randomly generated for accessing private data
  let key: number;

  return {
    // Control functions

    // Initialise the smart contract
    initialiseContract: (query: any, event: EventEngine): void => {
      smartContract = new (require(contractPath)).default(
        cdate,
        remoteAddr,
        umid,
        tx,
        inputs,
        outputs,
        reads,
        sigs,
        key
      );

      if ("setQuery" in smartContract) {
        smartContract.setQuery(query);
      }

      if ("setEvent" in smartContract) {
        smartContract.setEvent(event);
      }

      if (tx.$namespace === "default" && "sysConfig" in smartContract) {
        ((smartContract as unknown) as any).sysConfig(
          JSON.stringify(ActiveOptions.fetch(false))
        );
      }
    },

    // Get the activity streams from the smart contract
    getActivityStreams: (): { [reference: string]: Activity } => {
      return smartContract.getActivityStreams();
    },

    // Get the internode communications
    getInternodeComms: (): any => {
      return smartContract.getThisInterNodeComms();
    },

    // Clear the internode communications
    clearInternodeComms: (): boolean => {
      return smartContract.getClearInterNodeComms();
    },

    // Return the contract data
    returnContractData: (): unknown => {
      return smartContract.getReturnToRemote();
    },

    // Throw errors from the smart contract
    throwFrom: (): string[] => {
      return smartContract.throwTo;
    },

    // Run the verification round function
    runVerify: (sigless: boolean): Promise<boolean> => {
      return smartContract.verify(sigless);
    },

    // Run the voting round function
    runVote: (): Promise<boolean> => {
      return smartContract.vote();
    },

    // Run the commit round function
    runCommit: (possibleTerritoriality: boolean): Promise<boolean> => {
      return smartContract.commit(possibleTerritoriality);
    },

    // Run postprocessing if available
    postProcess: (territoriality: boolean, who: string): Promise<any> => {
      if ("postProcess" in smartContract) {
        // Run post process
        return smartContract.postProcess(territoriality, who);
      } else {
        // Auto resolve if no post process
        return Promise.resolve();
      }
    },

    // Get the current set timeout
    getTimeout: (): Date => {
      return smartContract.getTimeout();
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
      console.log("tx");
      console.log(tx);
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
