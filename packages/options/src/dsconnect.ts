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
import * as querystring from "querystring";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveRequest } from "./request";
import { EventEmitter } from "events";
import { ActiveOptions } from "./options";
import { PouchDB } from "./pouchdb";

/**
 * Sends HTTP requests to the data store
 *
 * @export
 * @class ActiveDSConnect
 * @implements {ActiveDefinitions.IActiveDSConnect}
 */
export class ActiveDSConnect implements ActiveDefinitions.IActiveDSConnect {
  /**
   * Creates an instance of DBConnector.
   * @param {string} location
   * @memberof DBConnector
   */
  constructor(private location: string) {
    // Search to make sure the database exists
  }

  /**
   * Creates Database / Get Database Info
   *
   * @returns
   * @memberof ActiveDSConnect
   */
  public info(): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}`, "GET")
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Create an index
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public createIndex(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_index`, "POST", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Returns all the documents in the database
   *
   * @param {*} [options]
   * @returns
   * @memberof ActiveDSConnect
   */

  public allDocs(options?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/_all_docs`,
        options ? "POST" : "GET",
        undefined,
        options
      )
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Get a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public get(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Query the data store
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public find(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_find`, "POST", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Create / Append multiple documents at the same time
   *
   * @param {any[]} docs
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public bulkDocs(docs: any[], options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_bulk_docs`, "POST", undefined, {
        docs,
        options
      })
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Create a document with auto generated id
   *
   * @param {} doc
   * @returns
   * @memberof ActiveDSConnect
   */
  public post(doc: {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(this.location, "POST", undefined, doc)
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Create / Append a document
   *
   * @param {{ _id: string }} doc
   * @returns
   * @memberof ActiveDSConnect
   */
  public put(doc: { _id: string; _rev?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${doc._id}`, "PUT", undefined, doc)
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Purges document from the database
   *
   * @param {{}} doc
   * @returns {Promise<any>}
   * @memberof ActiveDSConnect
   */
  public purge(doc: { _id: string; _rev?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${doc._id}`, "DELETE")
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Restore needs to happen, Proxy to selfhost or processing external
   *
   * @param {string} source
   * @param {string} target
   * @returns {Promise<any>}
   * @memberof ActiveDSConnect
   */
  public static smash(source: string, target: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (ActiveOptions.get<any>("db", {}).selfhost) {
        // Internal, Can use File System exposed via hosted /smash
        // ActiveRequest.send(
        //   `${
        //     ActiveOptions.get<any>("db", {}).url
        //   }/smash?s=${source}&t=${target}`,
        //   "GET"
        // )
        //   .then((response: any) => resolve(response.data))
        //   .catch(error => reject(error));
        // Internal, We have Purge Ability
        resolve({ status: "ok" });
      } else {
        // External, Need Double replication (Local First for filter)
        let sourceDb = new PouchDB(source);
        let targetDb = new PouchDB(target);

        // Rewrited Document Store
        let bulkdocs: any[] = [];

        // Make sure the target database is empty
        targetDb
          .destroy()
          .then(() => {
            // Close connection and create again
            targetDb.close();
            targetDb = new PouchDB(target);

            // Make sure db has been created
            targetDb.info().then(() => {
              // Replicate to target
              sourceDb.replicate
                .to(target, {
                  filter: (doc: any, req: any) => {
                    if (
                      doc.$activeledger &&
                      doc.$activeledger.delete &&
                      doc.$activeledger.rewrite
                    ) {
                      // Get Rewrite for later
                      bulkdocs.push(doc.$activeledger.rewrite);
                      return false;
                    } else {
                      return true;
                    }
                  }
                })
                .then(() => {
                  // Any Bulk docs to update
                  ActiveLogger.warn(
                    `Restoration : ${bulkdocs.length} streams being corrected`
                  );
                  targetDb.bulkDocs(bulkdocs, { new_edits: false }).then(() => {
                    // Delete original source database
                    sourceDb.destroy().then(() => {
                      // Now replicate back to a new "source"
                      targetDb.replicate.to(source).then(() => {
                        resolve({ ok: true });
                      });
                    });
                  });
                });
            });
          })
          .catch((e: Error) => reject(e));
      }
    });
  }

  /**
   * Fetch latest changes
   *
   * @param {{}} opts
   * @returns {Promise<ActiveDSChanges | any>}
   * @memberof DBConnector
   */
  public changes(opts: {
    live?: boolean;
    [opt: string]: any;
  }): Promise<any> | ActiveDSChanges {
    if (opts.live) {
      return new ActiveDSChanges(opts, `${this.location}/_changes`);
    } else {
      return new Promise((resolve, reject) => {
        ActiveRequest.send(
          `${this.location}/_changes?${querystring.stringify(opts)}`,
          "GET"
        )
          .then((response: any) => resolve(response.data))
          .catch(error => reject(error));
      });
    }
  }
}

/**
 * Simple DS Changes Listener
 *
 * @export
 * @class ActiveDSChanges
 * @extends {EventEmitter}
 * @implements {ActiveDefinitions.IActiveDSChanges}
 */
export class ActiveDSChanges extends EventEmitter
  implements ActiveDefinitions.IActiveDSChanges {
  /**
   * Flag for cancelling the next listeing round
   *
   * @private
   * @memberof ActiveDSChanges
   */
  private stop = false;

  /**
   *Creates an instance of ActiveDSChanges.
   * @param {{ live?: boolean; [opt: string]: any }} opts
   * @param {string} location
   * @param {boolean} [bulk=false]
   * @memberof ActiveDSChanges
   */
  constructor(
    private opts: { live?: boolean; [opt: string]: any },
    private location: string,
    private bulk: boolean = false
  ) {
    super();

    // Set default feed type (currently longpoll supported only on httpd)
    if (!opts.feed) {
      opts.feed = "longpoll";
    }

    // Give time before listening
    setTimeout(() => {
      this.listen();
    }, 250);
  }

  /**
   * Listen for changes from the data store
   *
   * @private
   * @memberof ActiveDSChanges
   */
  private listen(): void {
    ActiveRequest.send(
      `${this.location}?${querystring.stringify(this.opts)}`,
      "GET"
    )
      .then((response: any) => {
        if (!this.stop) {
          // Map last_seq -> seq (Matches Pouch Connector)
          // and update since for next round of listening
          this.opts.since = response.data.last_seq;

          if (this.bulk) {
            // Emit all changed data
            this.emit("change", response.data);
          } else {
            // Emit each change
            response.data.results.forEach((elm: any) => {
              this.emit("change", {
                doc: elm.doc,
                seq: elm.seq
              });
            });
          }

          // Listen for next update
          this.listen();
        }
      })
      .catch(error => this.emit("error", error));
  }

  /**
   * Cancels the changes listner
   *
   * @memberof ActiveDSChanges
   */
  public cancel(): void {
    this.stop = true;
  }
}
