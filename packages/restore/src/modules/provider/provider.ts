import { Helper } from "../helper/helper";
import {
  ActiveOptions,
  ActiveDSConnect,
  ActiveChanges
} from "@activeledger/activeoptions";
import * as fs from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveNetwork } from "@activeledger/activenetwork";

export class Provider {
  private static readonly configName = "config.json";

  public static isSelfhost: boolean;

  public static errorDatabase: ActiveDSConnect;

  public static errorFeed: ActiveChanges;

  public static network: ActiveNetwork.Home;

  public static isQuickFullRestore = false;

  public static neighbourCount: number;

  public static consensusReachedAmount: number;

  public static database: ActiveDSConnect;

  public static initialise(): Promise<void> {
    return new Promise((resolve, reject) => {
      ActiveOptions.init();

      this.getIdentity()
        .then(() => {
          return this.getConfig();
        })
        .then(() => {
          return this.setupDatabase();
        })
        .then(() => {
          return this.getConsensusData();
        })
        .then(() => {
          resolve();
        })
        .catch((error: Error) => {
          ActiveLogger.error(error);
        });
    });
  }

  private static setConfigData(key: string, data: string) {
    Helper.output("Setting " + key);
    ActiveOptions.set(key, data);
  }

  private static getConfig(): Promise<void> {
    return new Promise((resolve, reject) => {
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
      ActiveOptions.extendConfig()
        .then(() => {
          Helper.output("Config Extended");
          resolve();
        })
        .catch((err: unknown) => {
          reject(err);
        });
    });
  }

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

  private static setupSelfHostDB(dbConfig: any) {
    Helper.output("Setting up self hosted database");
    this.isSelfhost = true;
    dbConfig.url = "http://127.0.0.1:" + dbConfig.selfhost.port;

    // Update path to override the default CoudhDB
    dbConfig.path = dbConfig.selfhost.dir || "./.ds";

    // Set the modified data
    ActiveOptions.set("db", dbConfig);
  }

  private static setupErrorDB(dbConfig: any) {
    // Get error database connection
    this.errorDatabase = new ActiveDSConnect(
      `${dbConfig.url}/${dbConfig.error}`
    );

    // Initialise Error feed
    this.errorFeed = new ActiveChanges("Restore", this.errorDatabase, 1);
  }

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
        ? this.setupErrorDB(dbConfig)
        : (this.isQuickFullRestore = true);

      resolve();
    });
  }

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
