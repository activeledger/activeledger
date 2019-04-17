/*
 * MIT License (MIT)
 * Copyright (c) 2019 Activeledger
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

import { ActiveOptions, ActiveDSConnect } from "@activeledger/activeoptions";
import { Provider } from "../provider/provider";
import { IHostData } from "../../interfaces/sledgehammer.interface";

/**
 * Smash the correct data back to the ledger
 *
 * @export
 * @class Sledgehammer
 */
export class Sledgehammer {
  /**
   * Temporary holding name
   *
   * @private
   * @static
   * @memberof Sledgehammer
   */
  private static holdingDatabase = "activeledgerholdings";

  /**
   * Generate and return data for self host
   *
   * @private
   * @static
   * @returns {IHostData}
   * @memberof Sledgehammer
   */
  private static setupSelfHost(): IHostData {
    const source = ActiveOptions.get<any>("db", {}).database,
      target = this.holdingDatabase;

    return { source, target };
  }

  /**
   * Setup and return data for remote host
   *
   * @private
   * @static
   * @returns {IHostData}
   * @memberof Sledgehammer
   */
  private static setupRemoteHost(): IHostData {
    const databaseURL = ActiveOptions.get<any>("db", {}).url + "/",
      source = databaseURL + ActiveOptions.get<any>("db", {}).database,
      target = databaseURL + this.holdingDatabase;

    return { source, target };
  }

  /**
   * Smash the document into submission
   *
   * @static
   * @returns {Promise<bool>}
   * @memberof Sledgehammer
   */
  public static smash(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // What type of smash needs to happen and returned host intformation
      // Self hosted just needs database name
      const hostData = Provider.isSelfhost
        ? this.setupSelfHost()
        : this.setupRemoteHost();

      // Data connector can manage the data fixing
      ActiveDSConnect.smash(hostData.source, hostData.target)
        .then(() => {
          resolve(true);
        })
        .catch((e: Error) => {
          return reject(e);
        });
    });
  }
}