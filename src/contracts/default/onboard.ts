import { Standard } from "activecontracts";

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Onboard extends Standard {
  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (signatureless) {
        resolve(true);
      } else {
        reject("Has Signature");
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to checl
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      resolve(true);
    });
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      
      let x = this.newActivityStream("umid-1");
      let y = x.getState();
      y.hello = "world";
      x.setState(y);

      resolve(true);


    });
  }
}
