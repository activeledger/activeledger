/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fs from "fs";
import * as ts from "typescript";
import { Standard, Activity } from "@activeledger/activecontracts";

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
   * Requested Contract File
   *
   * @private
   * @type string
   * @memberof Fund
   */
  private contract: string;

  /**
   * Requested Link File
   *
   * @private
   * @type string
   * @memberof Fund
   */
  private link: string;

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
            "string" ||
          (this.transactions.$entry &&
            this.transactions.$entry.indexOf("link") !== -1)
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
        case "link":
          this.voteLink(resolve, reject);
          break;
        case "unlink":
          this.voteUnlink(resolve, reject);
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
        case "link":
          this.commitLink(resolve, reject);
          break;
        case "unlink":
          this.commitUnlink(resolve, reject);
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
   * Are we allowed to create a link?
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public voteLink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // Get namespace and set to lowercase
    this.namespace = (this.transactions.$i[stream]
      .namespace as string).toLowerCase();

    // Get Contract
    this.contract = (this.transactions.$i[stream]
      .contract as string).toLowerCase();

    // Get Link Name
    this.link = (this.transactions.$i[stream].link as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      // Does the Contract File exist?
      if (
        fs.existsSync(
          this.rootDir + this.namespace + "/" + this.contract + ".js"
        )
      ) {
        // Does the Link file not exist!
        if (
          !fs.existsSync(
            this.rootDir + this.namespace + "/" + this.link + ".js"
          )
        ) {
          return resolve(true);
        } else {
          return reject("Link already exists");
        }
      } else {
        return reject("Contract not found in namespace");
      }
    }
    return reject("Invalid Namespace");
  }

  /**
   * Are we allowed to remove a link?
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public voteUnlink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get Stream id
    let stream = Object.keys(this.transactions.$i)[0];

    // Get namespace and set to lowercase
    this.namespace = (this.transactions.$i[stream]
      .namespace as string).toLowerCase();

    // Get Contract
    this.contract = (this.transactions.$i[stream]
      .contract as string).toLowerCase();

    // Get Link Name
    this.link = (this.transactions.$i[stream].link as string).toLowerCase();

    // Does this identity have access to namespace (Maybe use ACL?)
    if (this.identity.getState().namespace == this.namespace) {
      // Does the Link file exist!
      if (
        fs.existsSync(this.rootDir + this.namespace + "/" + this.link + ".js")
      ) {
        return resolve(true);
      } else {
        return reject("Link doesn't exists");
      }
    }
    return reject("Invalid Namespace");
  }

  /**
   * Create the symlink to the contract
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commitLink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Create Symlink
    fs.symlinkSync(
      `${this.contract}.js`,
      `${this.rootDir}${this.namespace}/${this.link}.js`,
      "file"
    );

    resolve(true);
  }

  /**
   * Removes the symlink to the contract
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commitUnlink(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Create Symlink
    fs.unlinkSync(`${this.rootDir}${this.namespace}/${this.link}.js`);

    resolve(true);
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
