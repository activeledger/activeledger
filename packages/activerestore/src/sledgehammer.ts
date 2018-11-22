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
import * as ChildP from "child_process";
// @ts-ignore
import * as FileHound from "filehound";
import { ActiveOptions, PouchDB } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import * as rimraf from "rimraf";

/**
 *
 *
 * @export
 * @class Sledgehammer
 */
export class Sledgehammer {
  /**
   *
   *
   * @private
   * @static
   * @memberof Sledgehammer
   */
  private static pathDb = "/opt/couchdb/data/shards/00000000-ffffffff/";

  /**
   *
   *
   * @private
   * @static
   * @memberof Sledgehammer
   */
  private static tempDb = "activeledgerholdings";

  /**
   *
   *
   * @static
   * @returns {Promise<bool>}
   * @memberof Sledgehammer
   */
  public static smash(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // Array of rewrite updates
      let bulkdocs: any = [];

      // Origin Database
      let origin = new PouchDB(
        ActiveOptions.get<any>("db", {}).url + "/" + ActiveOptions.get<any>("db", {}).database
      );

      // Temporary Holding Database
      let tmpHoldings = new PouchDB(
        ActiveOptions.get<any>("db", {}).url + "/" + this.tempDb
      );

      // Make sure the database doesn't exist
      tmpHoldings
        .destroy()
        .then(() => {
          // Update Connection
          let tmpHoldings = new PouchDB(
            ActiveOptions.get<any>("db", {}).url + "/" + this.tempDb
          );

          origin.replicate
            .to(tmpHoldings, {
              filter: (doc: any, req: any) => {
                if (
                  doc.$activeledger &&
                  doc.$activeledger.delete &&
                  doc.$activeledger.rewrite
                ) {
                  // Get Rewrite for later
                  origin
                    .get(doc._id)
                    .then((doc: any) => {
                      bulkdocs.push(doc.$activeledger.rewrite);
                    })
                    .catch((e: Error) => ActiveLogger.info(e));
                  return false;
                } else {
                  return true;
                }
              }
            })
            .then(() => {
              // Any Bulk docs to update
              if (bulkdocs.length) {
                tmpHoldings
                  .bulkDocs(bulkdocs, { new_edits: false })
                  .then((docs: any) => {
                    resolve(true);
                    // Stop Delete Move Repeat
                    Sledgehammer.cleanUp(tmpHoldings);
                  });
              } else {
                resolve(true);
              }
            })
            .catch((e: Error) => reject(e));
        })
        .catch((e: Error) => reject(e));
    });
  }

  /**
   *
   *
   * @private
   * @static
   * @param {*} tmp
   * @memberof Sledgehammer
   */
  private static cleanUp(tmp: any): void {
    // Only work if we have sudo
    // Will need to come up with solution for none Debian based Linux & Other
    if (process.env.SUDO_UID) {
      // Path override
      let path = ActiveOptions.get<any>("db", {}).path || Sledgehammer.pathDb;

      // Stop Couchdb
      ActiveLogger.info("Stopping Database Service");
      ChildP.execSync("systemctl stop couchdb");

      // Rename cleaned db to original
      // get temporary file system (not cluster support enabled yet)
      let cleaned = FileHound.create()
        .paths(Sledgehammer.pathDb)
        .match(Sledgehammer.tempDb + ".*.couch")
        .find();

      let dirty = FileHound.create()
        .paths(Sledgehammer.pathDb)
        .match(ActiveOptions.get<any>("db", {}).database + ".*.couch")
        .find();

      // Wait for the files to be searched
      Promise.all([cleaned, dirty])
        .then(files => {
          // Which database files are to be changed
          let cleaned = files[0][0];
          let dirty = files[1][0];

          // Do we have clean for dirty
          if (cleaned && dirty) {
            ActiveLogger.info("Hot Swapping Database from Dity to Clean");
            // Rename
            fs.renameSync("/" + cleaned, "/" + dirty);
          }
          // Start Couchdb
          ActiveLogger.info("Starting Database Service");
          ChildP.execSync("systemctl start couchdb");

          // Delete the temporary
          setTimeout(() => {
            tmp.destroy().then(() => {
              ActiveLogger.info("Clean Database Removed");
            });
          }, 5000);
        })
        .catch(e => {
          // Start Couchdb
          ActiveLogger.info("Starting Database Service");
          ChildP.execSync("systemctl start couchdb");
          ActiveLogger.fatal(e);
        });
    } else if (ActiveOptions.get<any>("db", {}).selfhost) {
      // Get PouchDB Process, Send Signal Kill for processing by Activeledger
      let pid = parseInt(
        fs.readFileSync(ActiveOptions.get<any>("db", {}).path + "/.pid").toString()
      );
      process.kill(pid, "SIGKILL");

      // Wait a few seconds
      setTimeout(() => {
        // Delete current activeledger name
        rimraf(
          ActiveOptions.get<any>("db", {}).path +
            "/" +
            ActiveOptions.get<any>("db", {}).database,
          () => {
            // Move Holdings
            fs.renameSync(
              ActiveOptions.get<any>("db", {}).path +
                "/" +
                Sledgehammer.tempDb,
                ActiveOptions.get<any>("db", {}).path +
                "/" +
                ActiveOptions.get<any>("db", {}).database
            );
          }
        );
      }, 2500);
    } else {
      ActiveLogger.fatal(
        "Super User || Self Hosted Required - Cannot Clean Up"
      );
    }
  }
}
