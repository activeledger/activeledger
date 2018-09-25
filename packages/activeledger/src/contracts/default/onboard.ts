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

import { Standard } from '@activeledger/activecontracts';

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
        reject("Should be a sigsless flagged transaction");
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
      // Auto Approve (Demo Onboarding Contract)
      this.ActiveLogger.debug("Always Exposed Logging");
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
      // Get Inputs
      let inputs = Object.keys(this.transactions.$i);
      if (inputs.length) {
        let i = inputs.length;
        while (i--) {
          // Create New Activity
          let activity = this.newActivityStream(
            "activeledger.default.identity." + inputs[i]
          );
          activity.setAuthority(this.transactions.$i[inputs[i]].publicKey, this.transactions.$i[inputs[i]].type);

          let state = activity.getState();
          state.name = activity.getName();

          // Better solution than trying to catch nulls for namespace owners.          
          state.type = `${this.transactions.$namespace}.activeledger.identity`;
          activity.setState(state);

          // Volatile Fun
          let volatile = activity.getVolatile();
          volatile.now = new Date();
          activity.setVolatile(volatile);
        }
      }

      resolve(true);
    });
  }
}
