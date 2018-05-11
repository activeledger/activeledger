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
import { PostProcess, Activity } from "@activeledger/activecontracts";

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Network extends PostProcess {
  /**
   * Store System Configuration
   *
   * @private
   * @type {*}
   * @memberof Network
   */
  private config: any;

  /**
   * Get System Configuration
   *
   * @param {any} config
   * @memberof Network
   */
  public sysConfig(config: any) {
    this.config = config;
  }

  /**
   * Quick Check, Allow all data but make sure it is selfsigned
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (selfsigned) {
        resolve(true);
      } else {
        // Will use the node configuration id's to verify
        reject("Must be self signed");
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
        case "propose":
          this.proposeVote(resolve, reject);
          break;
        default:
          reject("unknown entry");
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
        case "propose":
          this.proposeCommit(resolve, reject);
          break;
        default:
          reject("unknown entry");
          break;
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public proposeVote(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Need to verify this exists
    let txNeighbourhood = this.transactions.$i.network.neighbourhood;

    // Get Config neighbourhood
    let cngNeighbourhood = this.config.neighbourhood;

    // Check objects match
    if (this.deepArrayEq(txNeighbourhood, cngNeighbourhood)) {
      // Do we have a signature from one of these nodes

      // Breakout of typescript to access signature object
      // In a propose, Only 1 node needs to be signatory, However network object must match.
      let signatures = (this as any).sigs;
      let keys = Object.keys(cngNeighbourhood);
      let i = keys.length;

      // Loop to find matching key (use host:port)
      while (i--) {
        let network = cngNeighbourhood[i];

        // Matching Signature?
        if (signatures[`${network.host}:${network.port}`]) {
          // Get Keypair via proxy (TODO: Fix definitions)
          let kp: any = new (this.ActiveCrypto.KeyPair as any)(
            network.identity.type,
            network.identity.public
          ) as any;

          // Check Signature
          if (
            kp.verify(
              this.transactions,
              signatures[`${network.host}:${network.port}`]
            )
          ) {
            // Found matching
            return resolve(true);
          } else {
            return reject("Found invalid node signature");
          }
        }
      }
    } else {
      reject("Network Neighborhood not matching");
    }
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public proposeCommit(
    resolve: (value?: boolean | PromiseLike<boolean> | undefined) => void,
    reject: (reason?: any) => void
  ): void {
    // Get new stream to hold this contract
    let network = this.newActivityStream("contract.default.network");

    // Get Stream state to manipulate
    let state = network.getState();

    // Add Network Neighbourhood details
    state.neighbourhood = this.transactions.$i.network.neighbourhood;

    // Add to Config
    this.config.network = network.getName();

    // Save State
    network.setState(state);

    resolve(true);
  }

  /**
   * Process configuration file updates
   *
   * @param {boolean} territoriality
   * @param {string} who
   * @returns {Promise<any>}
   * @memberof Network
   */
  public postProcess(territoriality: boolean, who: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // Backup config (TODO What if this isn't the config file?)
      fs.copyFileSync(this.config.__filename, this.config.__filename + ".bak");
      // Remove neighbourhood
      delete this.config.neighbourhood;
      // Cache then Remove Filename
      let config = this.config.__filename;
      delete this.config.__filename;
      // Write new config
      fs.writeFileSync(config, JSON.stringify(this.config));
      resolve(true);
    });
  }

  /**
   * Navigate 2 arrays of objects and compare
   *
   * @private
   * @param {Array<any>} a
   * @param {Array<any>} b
   * @returns {boolean}
   * @memberof Network
   */
  private deepArrayEq(a: Array<any>, b: Array<any>): boolean {
    // First check the lengths match
    if (a.length == b.length) {
      // Loop a and verify in b, Order check not important
      let i = a.length;
      // prepare the return
      let results: boolean = true;
      while (i--) {
        if (!this.arrayEq(a[i], b)) {
          return false;
        }
      }
      // Got here it must match!
      return true;
    } else {
      return false;
    }
  }

  /**
   * Check specific object exists inside an array
   *
   * @private
   * @param {*} a
   * @param {Array<any>} b
   * @returns {boolean}
   * @memberof Network
   */
  private arrayEq(a: any, b: Array<any>): boolean {
    // String comparrsion check cache
    let compare = JSON.stringify(a);
    // Loop b to see if a exists
    let i = b.length;
    while (i--) {
      if (JSON.stringify(b[i]) == compare) {
        return true;
      }
    }
    // Got here not matching
    return false;
  }

  /**
   * Compares two objects to see if they match
   *
   * @private
   * @param {*} a
   * @param {*} b
   * @returns {boolean}
   * @memberof Network
   * @author atmin {stackoveflow}
   */
  private deepEq(a: any, b: any): boolean {
    const ok = Object.keys,
      ta = typeof a,
      tb = typeof b;
    return a && b && ta === "object" && ta === tb
      ? ok(a).length === ok(a).length &&
          ok(b).every(key => this.deepEq(a[key], b[key]))
      : a === b;
  }
}
