import { ActiveDefinitions } from "@activeledger/activedefinitions";
import {
  Activity,
  Standard,
  PostProcessQueryEvent
} from "@activeledger/activecontracts";
import { EventEngine } from "@activeledger/activequery";
import { IVMDataPayload, IVMObject } from "./vm.interface";

export default class ContractControl implements IVMObject {
  /**
   * Holds the initilaised smart contract
   *
   * @private
   * @type {(Standard | PostProcessQueryEvent)}
   * @memberof ContractControl
   */
  private smartContract: Standard | PostProcessQueryEvent;

  /**
   * The path to the smart contract
   *
   * @private
   * @type {string}
   * @memberof ContractControl
   */
  private contractString: string;

  /**
   * Unique message Identifier
   *
   * @private
   * @type {string}
   * @memberof ContractControl
   */
  private umid: string;

  /**
   * Date syncronised between nodes to prevent nodes commiting different dates
   *
   * @private
   * @type {Date}
   * @memberof ContractControl
   */
  private cdate: Date;

  /**
   * The remote address from which the transaction was sent
   *
   * @private
   * @type {string}
   * @memberof ContractControl
   */
  private remoteAddr: string;

  /**
   * The transaction to be executed
   *
   * @private
   * @type {ActiveDefinitions.LedgerTransaction}
   * @memberof ContractControl
   */
  private tx: ActiveDefinitions.LedgerTransaction;

  /**
   * The transaction signatures
   *
   * @private
   * @type {ActiveDefinitions.LedgerSignatures}
   * @memberof ContractControl
   */
  private sigs: ActiveDefinitions.LedgerSignatures;

  /**
   * The transaction inputs
   *
   * @private
   * @type {ActiveDefinitions.LedgerStream[]}
   * @memberof ContractControl
   */
  private inputs: ActiveDefinitions.LedgerStream[];

  /**
   * The transaction outputs
   *
   * @private
   * @type {ActiveDefinitions.LedgerStream[]}
   * @memberof ContractControl
   */
  private outputs: ActiveDefinitions.LedgerStream[];

  /**
   * Transaction read only data
   *
   * @private
   * @type {ActiveDefinitions.LedgerIORputs}
   * @memberof ContractControl
   */
  private reads: ActiveDefinitions.LedgerIORputs;

  /**
   * Unique key to prevent unauthorised access
   *
   * @private
   * @type {number}
   * @memberof ContractControl
   */
  private key: number;

  // #region Contract controls

  /**
   * Initialise the contract using the data provided via the dataPass function
   *
   * @param {*} query
   * @param {EventEngine} event
   * @memberof ContractControl
   */
  public initialiseContract(query: any, event: EventEngine): void {
    this.smartContract = new (eval(this.contractString)).default(
      this.cdate,
      this.remoteAddr,
      this.umid,
      this.tx,
      this.inputs,
      this.outputs,
      this.reads,
      this.sigs,
      this.key
    );

    if ("setQuery" in this.smartContract) {
      this.smartContract.setQuery(query);
    }

    if ("setEvent" in this.smartContract) {
      this.smartContract.setEvent(event);
    }
  }

  /**
   * Get the activity stream data
   *
   * @returns {{ [reference: string]: Activity }}
   * @memberof ContractControl
   */
  public getActivityStreams(): { [reference: string]: Activity } {
    return this.smartContract.getActivityStreams();
  }

  /**
   * Get the inter-node communication
   *
   * @returns {*}
   * @memberof ContractControl
   */
  public getInternodeComms(): any {
    return this.smartContract.getThisInterNodeComms();
  }

  /**
   * Clear the inter-node communication
   *
   * @returns {boolean}
   * @memberof ContractControl
   */
  public clearInternodeComms(): boolean {
    return this.smartContract.getClearInterNodeComms();
  }

  /**
   * Get the contract data
   *
   * @returns {unknown}
   * @memberof ContractControl
   */
  public returnContractData(): unknown {
    return this.smartContract.getReturnToRemote();
  }

  /**
   * Throw to the caller
   *
   * @returns {string[]}
   * @memberof ContractControl
   */
  public throwFrom(): string[] {
    return this.smartContract.throwTo;
  }

  /**
   * Run the verification round of the contract
   *
   * @param {boolean} sigless
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public runVerify(sigless: boolean): Promise<boolean> {
    return this.smartContract.verify(sigless);
  }

  /**
   * Run the voting round of the contract
   *
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public runVote(): Promise<boolean> {
    return this.smartContract.vote();
  }

  /**
   * Run the commit round of the contract
   *
   * @param {boolean} possibleTerritoriality
   * @returns {Promise<boolean>}
   * @memberof ContractControl
   */
  public runCommit(possibleTerritoriality: boolean): Promise<boolean> {
    return this.smartContract.commit(possibleTerritoriality);
  }

  /**
   * Run the post processing of the contract
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   * @memberof ContractControl
   */
  public postProcess(territoriality: boolean, who: string): Promise<any> {
    if ("postProcess" in this.smartContract) {
      // Run post process
      return this.smartContract.postProcess(territoriality, who);
    } else {
      // Auto resolve if no post process
      return Promise.resolve();
    }
  }

  /**
   * Get the current timeout of the contract
   *
   * @returns {Date}
   * @memberof ContractControl
   */
  public getTimeout(): Date {
    return this.smartContract.getTimeout();
  }

  // #endregion

  // #region Contract setup

  /**
   * Pass the required data to the instnace as a payload
   *
   * @param {IVMDataPayload} payload
   * @memberof ContractControl
   */
  public dataPass(payload: IVMDataPayload): void {
    this.contractString = payload.contractString;
    this.umid = payload.contractString;
    this.cdate = payload.date;
    this.remoteAddr = payload.contractString;
    this.tx = payload.transaction;
    this.sigs = payload.signatures;
    this.inputs = payload.inputs;
    this.outputs = payload.outputs;
    this.reads = payload.readonly;
    this.key = payload.key;
  }

  /**
   * Set the system configuration data
   *
   * @param {*} sysConfig
   * @memberof ContractControl
   */
  public setSysConfig(sysConfig: any): void {
    if ("sysConfig" in this.smartContract) {
      ((this.smartContract as unknown) as any).sysConfig(sysConfig);
    }
  }

  /**
   * Reload the sys config
   *
   * @returns {boolean}
   * @memberof ContractControl
   */
  public reloadSysConfig(): boolean {
    if ("sysConfig" in this.smartContract) {
      return ((this.smartContract as unknown) as any).configReload();
    } else {
      return false;
    }
  }

  // #endregion
}
