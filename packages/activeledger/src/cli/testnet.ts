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
import { ActiveOptions } from "@activeledger/activeoptions";

export class TestnetHandler {
  public static setup(): void {
    //#region Localtestnet
    ActiveLogger.info("Creating Local Testnet");

    // Hold arguments for merge
    let merge: Array<string> = [];

    // How many in the testnet
    let instances = parseInt(ActiveOptions.get<string>("testnet")) || 3;

    // Create Local Nodes
    let processPromises: Array<Promise<any>> = [];
    for (let i = 0; i < instances; i++) {
      processPromises.push(
        new Promise((resolve, reject) => {
          ActiveLogger.info("Creating Node Instance " + i);

          // Need specific folder for each instance
          fs.mkdirSync(`instance-${i}`);

          // Copy shared identity
          fs.copyFileSync("./.identity", `instance-${i}/.identity`);

          // Instance Arguments (Start @ 5260)
          let args = [
            `--port ${5250 + (i + 1) * 10}`,
            `--data-dir .ds`,
            `--setup-only`,
          ];

          // Push to Merge
          merge.push(`--merge "./instance-${i}/config.json"`);

          // Excecute
          let cprocess = child.exec(`activeledger ${args.join(" ")}`, {
            cwd: `instance-${i}`,
          });

          // Wait to shutdown
          setTimeout(() => {
            ActiveLogger.info("Stopping Node Instance " + i);
            // Terminate (So we can merge)
            cprocess.kill("SIGINT");
            resolve(true);
          }, 2000);
        })
      );
    }

    // Wait on Promises
    Promise.all(processPromises)
      .then(() => {
        ActiveLogger.info("Setting up instances networking");

        // Now run merge
        let cprocess = child.exec(`activeledger ${merge.join(" ")}`);

        // Wait for exit
        cprocess.on("exit", () => {
          ActiveLogger.info("----------");
          ActiveLogger.info("Run Instances Individually");
          ActiveLogger.info("----------");

          // testnet launcher
          let testnet: string = 'let child = require("child_process");\r\n';

          // Let them know how to manually run.
          for (let i = 0; i < instances; i++) {
            let launch = `cd instance-${i} && activeledger`;

            // Print Launch Command
            ActiveLogger.info(launch);

            // Save to file
            if (i === 0) {
              // Forward output of first instance
              testnet += `child.spawn(
              /^win/.test(process.platform) ? "activeledger.cmd" : "activeledger",
              [],
              {
                cwd: "instance-${i}",
                stdio: "inherit"
              }
            );\r\n`;
            } else {
              // Standard Execution
              testnet += `child.exec("${launch}");\r\n`;
            }
          }

          // Write Testnet file
          fs.writeFileSync("testnet", testnet);

          ActiveLogger.info("----------");
          ActiveLogger.info("Run All Instances");
          ActiveLogger.info("----------");
          ActiveLogger.info("node testnet");
          process.exit();
        });
      })
      .catch((e) => {
        ActiveLogger.fatal(e, "Testnet Build Failure");
        process.exit();
      });
    //#endregion
  }
}
