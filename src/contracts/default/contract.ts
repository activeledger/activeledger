import * as fs from "fs";
import * as ts from "typescript"
import { Standard, Activity } from "activecontracts";
import { ActiveLogger } from "activelogger";


/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Contract extends Standard {
  /**
   * Requested Contract Name
   *
   * @private
   * @type string
   * @memberof Fund
   */
  private name: string;

  /**
   * Requested Namespace
   *
   * @private
   * @type string
   * @memberof Fund
   */
  private namespace: string;


  /**
   * Reference input stream name
   * 
   * @private
   * @type {string}
   * @memberof Namespace
   */
  private identity: Activity


  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!signatureless) {
        resolve(true);
      } else {
        reject("Signatures Needed");
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {

      // Get Stream id
      let stream = Object.keys(this.transactions.$i)[0];

      // Get Stream Activity
      this.identity = this.getActivityStreams(stream);

      // Get namespace and set to lowercase
      this.namespace = (this.transactions.$i[stream]
        .namespace as string).toLowerCase();

        // Get name as lowercase
        this.name = (this.transactions.$i[stream]
          .name as string).toLowerCase();

      // Does this identity have access to namespace (Maybe use ACL?)
      if(this.identity.getState().namespace == this.namespace) {
        resolve(true);
      }
      return reject("Invalid Namespace")

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

      // Check Namespace folder exists, Make if it doesn't
      if(!fs.existsSync(this.namespace)) fs.mkdirSync(this.namespace);

      // Compile Code
      let code = ts.transpileModule("let x:string = 'string'", {
        compilerOptions: {
          alwaysStrict: true,
          strictNullChecks: true,
          noImplicitAny: true,
          removeComments: true,
          lib: ["es2017"]
        }
      });

      fs.writeFileSync(`${this.namespace}/${this.name}.js`,code.outputText);

      // Get New Stream

      // Set Owner

      // Set Code

      resolve(true);
    });
  }
}
