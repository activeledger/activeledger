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
import { Standard, Activity } from "@activeledger/activecontracts";

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Namespace extends Standard {
  /**
   * Requested Namespace
   *
   * @private
   * @type string
   */
  private namespace: string;

  /**
   * Reference input stream name
   *
   * @private
   * @type {string}
   */
  private identity: Activity;

  /**
   * The Root for contract files
   *
   * @type {string}
   */
  readonly rootDir: string = "./contracts/";

  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
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

      // Default already protected
      if (this.namespace == "default") return reject("Namespace Reserved");

      // Does the namespace exist type 2
      if (fs.existsSync(this.rootDir + this.namespace)) {
        return reject("Namespace Reserved");
      }
      resolve(true);
    });
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      // Lets assign to this identity
      // Note: Old method didn't create folders so migration tool needed or can use first come
      fs.mkdirSync(this.rootDir + this.namespace);
      fs.writeFileSync(
        `${this.rootDir}${this.namespace}/.identity`,
        this.identity.getId()
      );

      // Update Identity to own namespace
      this.identity.setState({ namespace: this.namespace });

      resolve(true);
    });
  }
}
