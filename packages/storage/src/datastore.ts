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
import { promises as fsPromises } from "fs";
import * as child from "child_process";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";

// Maximum restarts allowed
const MAX_RESTARTS = 5;

// How long until the restart counter is allowed to be reset.
const MAX_RESTART_RESET_HOURS = 24;

/**
 * Manage the self hosted data storage engine
 *
 * @export
 * @class DataStore
 */
export class ActiveDataStore {
  /**
   * Folder location
   *
   * @private
   * @type {string}
   */
  private dsLocation: string;

  /**
   * Running process
   *
   * @private
   * @type {child.ChildProcess}
   */
  private process: child.ChildProcess;

  /**
   * Keeps track how many time database restart has occured
   * This wont solve the restart problem just reduce the logs
   *
   * @private
   */
  private restartCounter = 0;

  /**
   * Keeps track the last time it has restarted. This is used
   * as part of the counter and max retries so long running instances are not
   * effected by this new restriction
   *
   * @private
   * @type {Date}
   */
  private lastRestart: number = Date.now();

  /**
   * Creates an instance of DataStore.
   */
  constructor() {
    // Set Folder Location
    this.dsLocation = ActiveOptions.get<any>("db", {}).selfhost.dir || "./.ds";

    // Check folder exists
    if (!fs.existsSync(this.dsLocation)) {
      fs.mkdirSync(this.dsLocation);
    }

    // Start Server, Can't block as server wont return
    ActiveLogger.info(
      "Self-hosted data engine @ http://127.0.0.1:" +
        ActiveOptions.get<any>("db", {}).selfhost.port
    );
  }

  /**
   * Launch data store process
   *
   * @private
   * @returns {string}
   */
  public launch(): string {
    const dbInfo = ActiveOptions.get<any>("db", {});
    // Launch Background Database Process
    this.process = child.spawn(
      "node",
      [
        __dirname + "/selfhost.js",
        this.dsLocation,
        `${dbInfo.selfhost.port}`,
        `${dbInfo.selfhost.engine || "level"}`,
      ],
      {
        stdio: "inherit",
      }
    );

    ActiveLogger.info(
      `Self-hosted data engine (${
        dbInfo.selfhost.engine || "level"
      })  : Starting Up (${this.process.pid})`
    );

    // Store the PID for stop command
    this.storePid(this.process.pid || 0);

    // Listen for possible exits
    this.process.on("exit", (code: number, signal: string) => {
      // Just restart as we need the database up
      ActiveLogger.error(
        `Self-hosted data engine has shutdown (${code} : ${
          signal || "No Signal"
        })`
      );
      // As its an attached process killing activeledger will prevent this restart
      // If killed via activeledger --stop check for SIGTERM signal and don't restart if it is
      if (signal !== "SIGTERM" && MAX_RESTARTS >= this.restartCounter) {
        this.restartCounter++;
        this.launch();

        // Can we reset the counter?
        if (
          Date.now() >
          this.lastRestart + MAX_RESTART_RESET_HOURS * 60 * 60 * 1000
        ) {
          this.restartCounter = 0;
        }
      }else{
        ActiveLogger.error("Not attempting to restart either due to signal or counters reached");
      }
    });

    // Return running location
    return "http://127.0.0.1:" + ActiveOptions.get<any>("db", {}).selfhost.port;
  }

  private async storePid(pid: number): Promise<void> {
    const pidPath = ".PID";
    let pidData: {
      activeledger: number;
      activestorage: number;
      activecore: number;
      activerestore: number;
    };

    try {
      pidData = JSON.parse((await fsPromises.readFile(pidPath)).toString());
      pidData.activestorage = pid;

      await fsPromises.writeFile(pidPath, JSON.stringify(pidData));
    } catch (error) {
      ActiveLogger.warn(
        "Error storing PID, activeledger --stop may not work correctly"
      );
      ActiveLogger.warn(error.message);
    }
  }
}
