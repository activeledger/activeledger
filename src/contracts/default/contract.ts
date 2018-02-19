import * as fs from "fs";
import * as ts from "typescript";
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
  private identity: Activity;

  /**
   * The Root for contract files
   *
   * @type {string}
   * @memberof Contract
   */
  readonly rootDir: string = "./contracts/";

  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Get Stream id
      let stream = Object.keys(this.transactions.$i)[0];

      // Get Stream Activity
      this.identity = this.getActivityStreams(stream);
      if (!signatureless) {
        // Need Version
        if (
          typeof this.transactions.$i[this.identity.getName()].version ==
          "string"
        ) {
          resolve(true);
        } else {
          reject("No Version Found");
        }
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
      switch (this.transactions.$entry) {
        case "update":
          this.voteUpdate(resolve, reject);
          break;
        default:
          this.voteAdd(resolve, reject);
          break;
      }
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
      switch (this.transactions.$entry) {
        case "update":
          this.commitUpdate(resolve, reject);
          break;
        default:
          this.commitAdd(resolve, reject);
          break;
      }
    });
  }

  /**
   * Transpile Typescript to Javascript
   *
   * @private
   * @returns {string}
   * @memberof Contract
   */
  private transpile(): string {
    // Base64 Decode & Transpile to javascript
    return ts.transpileModule(
      Buffer.from(
        this.transactions.$i[this.identity.getName()].contract as string,
        "base64"
      ).toString(),
      {
        compilerOptions: {
          alwaysStrict: true,
          strictNullChecks: true,
          noImplicitAny: true,
          removeComments: true,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.Classic,
          target: ts.ScriptTarget.ES2017
        }
      }
    ).outputText;
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public voteAdd(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // TODO : Verify Contract Doesn't Exist

    // Get namespace and set to lowercase
    this.namespace = (this.transactions.$i[stream]
      .namespace as string).toLowerCase();

    // Get name as lowercase
    this.name = (this.transactions.$i[stream].name as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      resolve(true);
    }
    return reject("Invalid Namespace");
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commitAdd(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Check Namespace folder exists, Make if it doesn't
    if (!fs.existsSync(this.rootDir + this.namespace))
      fs.mkdirSync(this.rootDir + this.namespace);

    // Transaction Inputs
    let txi = this.transactions.$i[this.identity.getName()];

    // Get Executable contract code
    let code = this.transpile();

    // Get new stream to hold this contract
    let stream = this.newActivityStream(
      `contract.${this.namespace}.${this.name}@${txi.version}`
    );

    // Get Stream state to manipulate
    let state = stream.getState();

    // Set Signing Authority
    stream.setAuthority(this.identity.getName());

    // Add Contract details
    state.name = this.name;
    state.namespace = this.namespace;

    // Version Management
    state.contract = {};
    state.contract[txi.version] = txi.contract;

    // Compiled Management
    state.compiled = {};
    state.compiled[txi.version] = stream.getName();

    // Write the contract to its location as latest (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}.js`,
      code
    );

    // Write the contract to its location as a version (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}@${txi.version}.js`,
      code
    );

    // Save State
    stream.setState(state);

    resolve(true);
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public voteUpdate(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // TODO : Verify Version doesn't exist

    // Get namespace and set to lowercase
    this.namespace = (this.transactions.$i[stream]
      .namespace as string).toLowerCase();

    // Get name as lowercase
    this.name = (this.transactions.$i[stream].name as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      resolve(true);
    }
    return reject("Invalid Namespace");
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commitUpdate(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Transaction Inputs
    let txi = this.transactions.$i[this.identity.getName()];

    // Get Output id

    let output = Object.keys(this.transactions.$o)[0];

    // Get Stream Activity
    let stream = this.getActivityStreams(output);

    // Get Executable contract code
    let code = this.transpile();

    // Get Stream state to manipulate
    let state = stream.getState();

    // Version Management
    state.contract[txi.version] = txi.contract;

    // Compiled Management
    state.compiled[txi.version] = stream.getName();

    // Write the contract to its location as latest (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}.js`,
      code
    );

    // Write the contract to its location (Using its stream name)
    fs.writeFileSync(
      `${this.rootDir}${this.namespace}/${stream.getName()}@${txi.version}.js`,
      code
    );

    // Save State
    stream.setState(state);

    resolve(true);
  }
}
