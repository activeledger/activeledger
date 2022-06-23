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

import { Helper } from "../helper/helper";
import {
  ActiveOptions,
  ActiveDSConnect,
  ActiveChanges,
} from "@activeledger/activeoptions";
import * as fs from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork } from "@activeledger/activenetwork";

/**
 * Provides initialision functions for Restore
 *
 * @export
 * @class Provider
 */
export class Provider {
  private static readonly configName = "config.json";

  public static isSelfhost: boolean;

  public static errorDatabase: ActiveDSConnect;

  public static errorFeed: ActiveChanges;

  public static archiveFeed: ActiveChanges;

  public static network: ActiveNetwork.Home;

  public static isQuickFullRestore = false;

  public static neighbourCount: number;

  public static consensusReachedAmount: number;

  public static database: ActiveDSConnect;

  public static archiveDatabase: ActiveDSConnect;

  public static errorArchive: ActiveDSConnect;

  public static archiveArchive: ActiveDSConnect;

  /**
   * Begin initialisation process
   *
   * @static
   * @returns {Promise<void>}
   * @memberof Provider
   */
  public static initialise(): Promise<void> {
    return new Promise(async (resolve) => {
      ActiveOptions.init();

      try {
        await this.getIdentity();
        await this.getConfig();
        await this.setupDatabase();
        await this.getConsensusData();
        resolve();
      } catch (error) {
        ActiveLogger.error(error);
      }
    });
  }

  /**
   * Set the config data
   *
   * @private
   * @static
   * @param {string} key
   * @param {string} data
   * @memberof Provider
   */
  private static setConfigData(key: string, data: string) {
    Helper.output("Setting " + key);
    ActiveOptions.set(key, data);
  }

  /**
   * Get the config data
   *
   * @private
   * @static
   * @returns {Promise<void>}
   * @memberof Provider
   */
  private static getConfig(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      Helper.output("Getting Config");

      let path = ActiveOptions.get<string>("path", "");
      let config = ActiveOptions.get<string>("config", this.configName);

      config === this.configName
        ? Helper.output("Using default config")
        : Helper.output("Config provided");

      path
        ? this.setConfigData("config", path + config)
        : Helper.output("No path provided");

      !fs.existsSync(config)
        ? () => {
            throw ActiveLogger.fatal(`No config file found (${config})`);
          }
        : Helper.output("Config file found");

      Helper.output("Parsing Config");
      ActiveOptions.parseConfig();

      Helper.output("Extending Config");

      try {
        await ActiveOptions.extendConfig();
        Helper.output("Config Extended");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Get the local node identity
   *
   * @private
   * @static
   * @returns {Promise<void>}
   * @memberof Provider
   */
  private static getIdentity(): Promise<void> {
    return new Promise((resolve) => {
      Helper.output("Getting Identity");

      const identity = ActiveOptions.get<string | boolean>("identity", false);
      const path = ActiveOptions.get<string>("path", ".") + "/.identity";

      identity
        ? this.setConfigData("identity", path)
        : Helper.output("No identity found");

      !fs.existsSync(path)
        ? () => {
            throw ActiveLogger.fatal(`No Identity file found (${path})`);
          }
        : Helper.output("Identity path found");

      resolve();
    });
  }

  /**
   * Setup a connection to a local self hosted database
   *
   * @private
   * @static
   * @param {*} dbConfig
   * @memberof Provider
   */
  private static setupSelfHostDB(dbConfig: any) {
    Helper.output("Setting up self hosted database");
    this.isSelfhost = true;
    dbConfig.url = "http://127.0.0.1:" + dbConfig.selfhost.port;

    // Update path to override the default CoudhDB
    dbConfig.path = dbConfig.selfhost.dir || "./.ds";

    // Set the modified data
    ActiveOptions.set("db", dbConfig);
  }

  /**
   *  Setup database connections
   *
   * @private
   * @static
   * @param {*} dbConfig
   * @memberof Provider
   */
  private static setupDB(dbConfig: any) {
    this.setupErrorDB(dbConfig);
    this.setupArchiveDB(dbConfig);
  }

  /**
   * Setup a connection to the error database
   *
   * @private
   * @static
   * @param {*} dbConfig
   * @memberof Provider
   */
  private static setupErrorDB(dbConfig: any) {
    // Get error database connection
    this.errorDatabase = new ActiveDSConnect(
      `${dbConfig.url}/${dbConfig.error}`
    );

    // Get error archive connection
    this.errorArchive = new ActiveDSConnect(
      `${dbConfig.url}/${dbConfig.error}_archive`
    );

    // Initialise Error feed
    this.errorFeed = new ActiveChanges("Restore", this.errorDatabase, 1);
  }

  /**
   * Setup a connection to the archive database
   *
   * @private
   * @static
   * @param {*} dbConfig
   * @memberof Provider
   */
  private static setupArchiveDB(dbConfig: any) {
    // Get error database connection
    this.archiveDatabase = new ActiveDSConnect(
      `${dbConfig.url}/${dbConfig.database}_archive`
    );
    this.archiveDatabase.info();

    // Get error archive connection
    this.archiveArchive = new ActiveDSConnect(
      `${dbConfig.url}/${dbConfig.database}_archived`
    );
    this.archiveArchive.info();

    // Initialise Error feed
    this.archiveFeed = new ActiveChanges("Archive", this.archiveDatabase, 1);
  }

  /**
   * Setup a database connection
   *
   * @private
   * @static
   * @returns {Promise<void>}
   * @memberof Provider
   */
  private static setupDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dbConfig = ActiveOptions.get<any>("db", {});

      // Check if selfhosted
      dbConfig.selfhost
        ? this.setupSelfHostDB(dbConfig)
        : Helper.output("Not using self hosted database");

      // Initialise ActiveNetwork for communications management (knock all)
      Helper.output("Initialising ActiveNetwork");
      this.network = new ActiveNetwork.Home();

      // Initialise live database connection
      Helper.output("Initialising ActiveDSConnect");
      this.database = new ActiveDSConnect(
        `${dbConfig.url}/${dbConfig.database}`
      );

      !ActiveOptions.get<boolean>("full", false)
        ? this.setupDB(dbConfig)
        : (this.isQuickFullRestore = true);

      resolve();
    });
  }

  /**
   * Get Consensus information
   *
   * @private
   * @static
   * @returns {Promise<void>}
   * @memberof Provider
   */
  private static getConsensusData(): Promise<void> {
    return new Promise((resolve) => {
      // Get the amount of neighbours in the network
      this.neighbourCount = ActiveOptions.get<Array<any>>(
        "neighbourhood",
        []
      ).length;

      // Get the minimum amount to reach consensus
      this.consensusReachedAmount = ActiveOptions.get<any>(
        "consensus",
        {}
      ).reached;

      resolve();
    });
  }
}
