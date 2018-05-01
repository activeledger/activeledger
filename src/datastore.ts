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
import * as child from "child_process";
import { ActiveLogger } from "@activeledger/activelogger";

/**
 * Manage the self hosted data storage engine
 *
 * @export
 * @class DataStore
 */
export class DataStore {
  /**
   * Folder location
   *
   * @private
   * @type {string}
   * @memberof DataStore
   */
  private dsLocation: string;

  /**
   * Running process
   *
   * @private
   * @type {child.ChildProcess}
   * @memberof DataStore
   */
  private process: child.ChildProcess;

  /**
   * Creates an instance of DataStore.
   * @memberof DataStore
   */
  constructor() {
    // Set Folder Location
    this.dsLocation = (global as any).config.db.selfhost.dir || "./.ds";

    // Check folder exists
    if (!fs.existsSync(this.dsLocation)) {
      fs.mkdirSync(this.dsLocation);
    }

    // Start Server, Can't block as server wont return
    ActiveLogger.info(
      "Self-hosted data engine @ http://127.0.0.1:" +
        (global as any).config.db.selfhost.port
    );
  }

  /**
   * Launch data store process
   *
   * @private
   * @returns {string}
   * @memberof DataStore
   */
  public launch(): string {    
    // Launch Background Database Process
    this.process = child.spawn(
      "node",
      [
        "./lib/selfhost.js",
        this.dsLocation,
        `${(global as any).config.db.selfhost.port}`
      ],
      {
        cwd: "./"
      }
    );

    ActiveLogger.info(`Self-hosted data engine : Starting Up (${this.process.pid})`);

    // Write process id for restore engine to manage
    fs.writeFileSync(this.dsLocation + "/.pid", this.process.pid);

    // Listen for exit to kill (restore may shutdown)
    this.process.on("exit", () => {
      ActiveLogger.info("Self-host data engine shutting down...");
      this.process.kill("SIGINT");

      // Wait 10 seconds and bring back up
      setTimeout(() => {
        this.launch();
      }, 10000);
    });

    // Return running location
    return "http://127.0.0.1:" + (global as any).config.db.selfhost.port;
  }
}
