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

import * as child from "child_process";
import * as fs from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDataStore } from "@activeledger/activestorage";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { ActiveOptions, ActiveRequest } from "@activeledger/activeoptions";
import { TestnetHandler } from "./testnet";

export class CLIHandler {
  /**
   * Start the local node
   *
   * @static
   * @memberof CLIHandler
   */
  public static start(): void {
    this.normalStart();
  }

  /**
   * Stop the local node
   *
   * @static
   * @memberof CLIHandler
   */
  public static stop(): void {}

  /**
   * Restart the local node
   *
   * @static
   * @memberof CLIHandler
   */
  public static restart(): void {}

  /**
   * Initialise the creation of a testnet
   *
   * @static
   * @memberof CLIHandler
   */
  public static setupTestnet(): void {
    TestnetHandler.setup();
  }

  /**
   * Merge configuration
   *
   * @static
   * @memberof CLIHandler
   */
  public static merge(): void {
    //#region Merge Configs
    if (ActiveOptions.get<Array<string>>("merge", []).length) {
      // Cache merge
      let merge = ActiveOptions.get<Array<string>>("merge", []);
      // Holds the object to write back
      let neighbourhood: Array<any> = [];
      // Loop array build network object up and loop again (Speed not important)
      for (let index = 0; index < merge.length; index++) {
        const configFile = merge[index];

        // Check file exists
        if (fs.existsSync(configFile)) {
          // Read File
          const config: any = JSON.parse(fs.readFileSync(configFile, "utf8"));

          // Check only 1 entry to merge
          if (config.neighbourhood.length == 1) {
            // Add to array
            neighbourhood.push(config.neighbourhood[0]);
          } else {
            ActiveLogger.fatal(
              `${configFile} has multiple entries in neighbourhood`
            );
            process.exit();
          }
        } else {
          ActiveLogger.fatal(`Configuration file "${configFile}" not found`);
          process.exit();
        }
      }

      // Loop again and write config
      for (let index = 0; index < merge.length; index++) {
        const configFile = merge[index];

        // Check file still exists
        if (fs.existsSync(configFile)) {
          // Read File
          const config: any = JSON.parse(fs.readFileSync(configFile, "utf8"));
          // Update Neighbourhood
          config.neighbourhood = neighbourhood;
          // Write File
          fs.writeFileSync(configFile, JSON.stringify(config));
        }
      }
      ActiveLogger.info("Local neighbourhood configuration has been merged");
    } else {
      ActiveLogger.fatal("Mutiple merge arguments needed to continue.");
    }
    //#endregion
  }

  // #region Startup handling
  /**
   * Run startup code
   *
   * @private
   * @static
   * @memberof CLIHandler
   */
  private static normalStart(): void {
    // Continue Normal Boot

    //#region Check & Manage Configuration File
    this.checkConfig();
    //#endregion

    // Now we can parse configuration
    ActiveOptions.parseConfig();

    // Check for local contracts folder
    if (!fs.existsSync("../contracts")) fs.mkdirSync("../contracts");

    ActiveLogger.warn(fs.realpathSync("../contracts") + "/node_modules");

    // Check for modules link for running contracts
    if (!fs.existsSync("../contracts/node_modules"))
      fs.symlinkSync(
        fs.realpathSync(`${__dirname}/../../node_modules`),
        fs.realpathSync("../contracts") + "/node_modules",
        "dir"
      );

    // Move config based to merged ledger configuration
    if (
      ActiveOptions.get<boolean>("assert", false) ||
      ActiveOptions.get<boolean>("assert-network", false)
    ) {
      this.assertNetwork();
    } else {
      //#region Do we have a transaction file to sign?
      if (ActiveOptions.get<boolean>("sign", false)) {
        // Does file exist
        if (fs.existsSync(ActiveOptions.get<string>("sign"))) {
          // Get File
          let file = fs
            .readFileSync(ActiveOptions.get<string>("sign"))
            .toString() as any;

          // Does file contain $tx (So we can JSON parse and sign just the transaction)
          if (file.indexOf(`"$tx"`) !== 0) {
            // Parse File
            file = JSON.parse(file);
            if (file.$tx) {
              ActiveLogger.warn("Signing $tx content only");
              file = file.$tx;
            } else {
              ActiveLogger.warn("Signing Entire File");
            }
          } else {
            ActiveLogger.warn("Signing Entire File");
          }

          // Get Identity
          let identity: ActiveCrypto.KeyHandler = JSON.parse(
            fs.readFileSync(
              ActiveOptions.get<string>("identity", "./.identity"),
              "utf8"
            )
          );

          // Get Signing Object
          let signatory: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair(
            "rsa",
            identity.prv.pkcs8pem
          );

          // Sign
          let signature = signatory.sign(file);

          ActiveLogger.info("-----BEGIN SIGNATURE-----");
          ActiveLogger.info(signature);
          ActiveLogger.info("-----END SIGNATURE-----");
        } else {
          ActiveLogger.fatal("File not found");
        }
        process.exit();
      }
      //#endregion

      //#region Get Public Key
      if (ActiveOptions.get<boolean>("public", false)) {
        // Get Identity
        let identity: ActiveCrypto.KeyHandler = JSON.parse(
          fs.readFileSync(
            ActiveOptions.get<string>("identity", "./.identity"),
            "utf8"
          )
        );

        // Output Public Key
        ActiveLogger.info("\n" + identity.pub.pkcs8pem);
        process.exit();
      }
      //#endregion

      // Are we only doing setups if so stopped
      if (ActiveOptions.get<boolean>("setup-only", false)) {
        process.exit(0);
      }

      // Extend configuration proxy founction
      let extendConfig: Function = (boot: Function) => {
        ActiveOptions.extendConfig()
          .then(() => boot())
          .catch((e) => {
            ActiveLogger.fatal(e, "Config Extension Issues");
          });
      };

      // Lets now startup Activeledger
      // Let them know!
      ActiveLogger.info("Activeledger Boot Process Started");

      // Self hosted data storage engine
      if (ActiveOptions.get<any>("db", {}).selfhost) {
        // Create Datastore instance
        let datastore: ActiveDataStore = new ActiveDataStore();

        // Rewrite config for this process
        ActiveOptions.get<any>("db", {}).url = datastore.launch();

        // Enable Extended Debugging
        ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

        if (!ActiveOptions.get<any>("db-only", false)) {
          // Wait a bit for process to fully start
          setTimeout(() => {
            extendConfig(this.boot);
          }, 2000);
        }
      } else {
        // Check if they wanbt db-only
        if (ActiveOptions.get<any>("db-only", false)) {
          ActiveLogger.fatal(
            "Cannot start embedded database. Self hosted is not configured"
          );
        } else {
          // Continue
          this.boot();
        }
      }
    }
  }

  /**
   * Used to wait on self host
   *
   * @private
   * @static
   * @memberof CLIHandler
   */
  private static boot(): void {
    try {
      // Set Base Path
      ActiveOptions.set("__base", __dirname);
      // Maintain Network Neighbourhood & Let Workers know
      ActiveNetwork.Maintain.init(new ActiveNetwork.Host());

      //#region Auto starting Activeledger Services
      if (ActiveOptions.get<any>("autostart", {})) {
        // Auto starting Core API?
        if (ActiveOptions.get<any>("autostart", {}).core) {
          ActiveLogger.info("Auto starting - Core API");
          // Launch & Listen for launch error
          child
            .spawn(
              /^win/.test(process.platform) ? "activecore.cmd" : "activecore",
              [],
              {
                cwd: "./",
                stdio: "inherit",
              }
            )
            .on("error", (error) => {
              ActiveLogger.error(error, "Core API Failed to start");
            });
        }

        // Auto Starting Restore Engine?
        if (ActiveOptions.get<any>("autostart", {}).restore) {
          ActiveLogger.info("Auto starting - Restore Engine");
          // Launch & Listen for launch error
          child
            .spawn(
              /^win/.test(process.platform)
                ? "activerestore.cmd"
                : "activerestore",
              [],
              {
                cwd: "./",
                stdio: "inherit",
              }
            )
            .on("error", (error) => {
              ActiveLogger.error(error, "Restore Engine Failed to start");
            });
        }
      }
      //#endregion
    } catch (error) {
      // Server may be down on index check
      process.exit(1);
    }
  }

  /**
   * Check and manage configuration
   *
   * @private
   * @static
   * @memberof CLIHandler
   */
  private static checkConfig() {
    if (
      !fs.existsSync(ActiveOptions.get<string>("config", "/../config.json"))
    ) {
      // Read default config so we can add our identity to the neighbourhood
      let defConfig: any = JSON.parse(
        fs.readFileSync(
          fs.realpathSync(__dirname + "/../default.config.json"),
          "utf8"
        )
      );

      // Adjusting Ports (Check for default port)
      if (
        ActiveOptions.get<boolean>("port", false) &&
        ActiveOptions.get<number>("port", 5260) !== 5260
      ) {
        // Update Node Host
        defConfig.host =
          ActiveOptions.get<string>("host", "127.0.0.1") +
          ":" +
          ActiveOptions.get<string>("port", 5260);

        // Update Self host
        defConfig.db.selfhost.port = (
          parseInt(ActiveOptions.get<string>("port", 5260)) - 1
        ).toString();

        // Disable auto starts as they have their own port settings
        defConfig.autostart.core = false;
        defConfig.autostart.restore = false;
      }

      // Data directory passed?
      if (ActiveOptions.get<boolean>("data-dir", false)) {
        defConfig.db.selfhost.dir = ActiveOptions.get<string>("data-dir", "");
      }

      // Read identity (can't assume it was always created)
      let identity: any = JSON.parse(fs.readFileSync("./.identity", "utf8"));

      // Add this identity
      defConfig.neighbourhood.push({
        identity: {
          type: "rsa",
          public: identity.pub.pkcs8pem,
        },
        host: ActiveOptions.get<string>("host", "127.0.0.1"),
        port: ActiveOptions.get<string>("port", "5260"),
      });

      // lets write the default one in this location
      fs.writeFileSync(
        ActiveOptions.get<string>("config", "./config.json"),
        JSON.stringify(defConfig)
      );
      ActiveLogger.info(
        "Created Config File - Please see documentation about network setup"
      );
    }
  }

  /**
   * Assert the network configuration into the ledger
   *
   * @private
   * @static
   * @memberof CLIHandler
   */
  private static assertNetwork(): void {
    //#region Configuration To Ledger
    // Check we are still file based
    if (ActiveOptions.get<string>("network", "")) {
      ActiveLogger.error("Network has already been asserted");
      process.exit();
    }

    // Make sure this node belives everyone is online
    ActiveRequest.send(
      `http://${ActiveOptions.get<boolean>("host")}/a/status`,
      "GET"
    )
      .then((status: any) => {
        // Verify the status are all home
        let neighbours = Object.keys(status.data.neighbourhood.neighbours);
        let i = neighbours.length;

        // Loop and check
        while (i--) {
          if (!status.data.neighbourhood.neighbours[neighbours[i]].isHome) {
            ActiveLogger.fatal(
              "All known nodes must been online for assertion"
            );
            process.exit();
          }
        }

        // Get Identity
        let identity: ActiveCrypto.KeyHandler = JSON.parse(
          fs.readFileSync(
            ActiveOptions.get<string>("identity", "./.identity"),
            "utf8"
          )
        );

        // Get Signing Object
        let signatory: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair(
          "rsa",
          identity.prv.pkcs8pem
        );

        // Are we adding a lock?
        let lock: string =
          ActiveOptions.get<string>("assert", false) ||
          ActiveOptions.get<string>("assert-network", false);
        if (typeof lock !== "string") lock = "";

        // Build Transaction
        let assert = {
          $tx: {
            $namespace: "default",
            $contract: "setup",
            $entry: "assert",
            $i: {
              [ActiveOptions.get<string>("host")]: {
                type: "rsa",
                publicKey: identity.pub.pkcs8pem,
              },
              setup: {
                type: "rsa",
                publicKey: identity.pub.pkcs8pem,
                lock: lock,
                security: ActiveOptions.get<any>("security"),
                consensus: ActiveOptions.get<any>("consensus"),
                neighbourhood: ActiveOptions.get<any>("neighbourhood"),
              },
            },
          },
          $selfsign: true,
          $sigs: {
            [ActiveOptions.get<string>("host")]: "",
          },
        };

        // Sign Transaction
        let signed = signatory.sign(assert.$tx);

        // Add twice to transaction
        assert.$sigs[ActiveOptions.get<string>("host")] = signed;

        // Submit Transaction to self
        ActiveRequest.send(
          `http://${ActiveOptions.get<boolean>("host")}`,
          "POST",
          [],
          assert
        )
          .then((response: any) => {
            if (response.data.$summary.errors) {
              ActiveLogger.fatal(
                response.data.$summary,
                "Networking Assertion Failed"
              );
            } else {
              ActiveLogger.info(
                response.data.$streams,
                "Network Asserted to the ledger"
              );
            }
          })
          .catch(() => {
            ActiveLogger.fatal("Networking Assertion Failed");
          });
      })
      .catch((e) => {
        ActiveLogger.fatal(
          e.response ? e.response.data : e,
          "Unable to assess network for assertion"
        );
      });
    //#endregion
  }
  // #endregion
}
