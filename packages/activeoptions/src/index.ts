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
import * as minimist from "minimist";
// @ts-ignore
import * as PouchDB from "pouchdb";

export class ActiveOptions {
  /**
   * Holds CLI Options
   *
   * @private
   * @static
   * @type {minimist.ParsedArgs}
   * @memberof ActiveOptions
   */
  private static argv: minimist.ParsedArgs;

  /**
   * Holds Configuration
   *
   * @private
   * @static
   * @type {*}
   * @memberof ActiveOptions
   */
  private static config: any = {};

  /**
   * Static Constructor, Reads CLI Arguements
   *
   * @static
   * @memberof ActiveOptions
   */
  public static init() {
    // Process Passed Arguments
    ActiveOptions.argv = minimist(process.argv.slice(2));
  }

  /**
   * Parse Configuration into Options
   *
   * @static
   * @memberof ActiveOptions
   */
  public static parseConfig() {
    // Parse Configuration
    ActiveOptions.config = JSON.parse(
      fs.readFileSync(
        ActiveOptions.get<string>("config", "./config.json"),
        "utf8"
      )
    );

    // Add filename to configuration
    ActiveOptions.config.__filename = ActiveOptions.get<string>(
      "config",
      "./config.json"
    );

    // Expose to global for now (Transaition Period)
    (global as any).argv = ActiveOptions.argv;
    (global as any).config = ActiveOptions.config;
  }

  /**
   * Extend Configuration from ledger
   *
   * @static
   * @param {boolean} [automerge=true]
   * @returns {Promise<any>}
   * @memberof ActiveOptions
   */
  public static extendConfig(automerge: boolean = true): Promise<any> {
    return new Promise((resolve, reject) => {
      let tmpDb = new PouchDB(
        ActiveOptions.get<any>("db", {}).url +
          "/" +
          ActiveOptions.get<any>("db", {}).database
      );

      // Get Stream id from revision
      let network = ActiveOptions.get<string>("network", "");
      network = network.substr(0, network.indexOf("@"));

      tmpDb
        .get(network)
        .then((config: any) => {
          if (automerge) {
            // Update network config network from ledger
            // Add Revision (For Firewall based Consensus)
            if (config._rev)
              ActiveOptions.set("network", config._id + "@" + config._rev);
            // Manual Configuration Merge
            if (config.security) ActiveOptions.set("security", config.security);
            if (config.consensus)
              ActiveOptions.set("consensus", config.consensus);
            if (config.neighbourhood)
              ActiveOptions.set("neighbourhood", config.neighbourhood);
            resolve(config);
          } else {
            resolve(config);
          }
        })
        .catch(() => {
          resolve(false);
        });
    });
  }

  /**
   * Get CLI option or Config Option
   *
   * @static
   * @template T
   * @param {string} name
   * @param {*} [defValue=null]
   * @returns {T}
   * @memberof ActiveOptions
   */
  public static get<T>(name: string, defValue: any = null): T {
    // Return Config, CLI, Default
    return ActiveOptions.config[name] || ActiveOptions.argv[name] || defValue;
  }

  /**
   * Set Configuration Option
   *
   * @static
   * @param {string} name
   * @param {*} value
   * @param {boolean} [reload=false]
   * @memberof ActiveOptions
   */
  public static set(name: string, value: any, reload: boolean = false): void {
    // Set Configuration
    ActiveOptions.config[name] = value;

    // Update All Process
    if (reload) {
    }
  }

  /**
   * Fetches the entire object
   *
   * @static
   * @param {boolean} argv
   * @returns
   * @memberof ActiveOptions
   */
  public static fetch(argv: boolean) {
    if (argv) {
      return ActiveOptions.argv;
    } else {
      return ActiveOptions.config;
    }
  }
}
