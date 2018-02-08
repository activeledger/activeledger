import { Standard } from "activecontracts";

/**
 * Contract for managing contracts on the ledger
 *
 * @export
 * @class Contract
 * @extends {Standard}
 */
export default class Contract extends Standard {
  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Contract
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!signatureless) {
        resolve(true);
      } else {
        reject("Empty Signature");
      }
    });
  }

  /**
   * Will verify if the contract is being updated by the correct signing authority
   *
   * @returns {Promise<boolean>}
   * @memberof Contract
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      resolve(true);
    });
  }

  /**
   * Prepares the new streams & Updates current stream of the contract code
   *
   * @returns {Promise<any>}
   * @memberof Contract
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      resolve({ object: "hello world" });
    });
  }
}
