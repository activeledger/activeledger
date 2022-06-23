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
import { ActiveRequest } from "@activeledger/activeutilities";
import { EventEmitter } from "events";
import { ActiveOptions } from "./options";

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
        .catch(reject);
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
        .catch(reject);
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
        .catch(reject);
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
        .catch(reject);
    });
  }

  /**
   * Create New or Gets a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public createget(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve) => {
      ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(() => {
          resolve({ _id: id });
        });
    });
  }

  /**
   * Checks to see if a document exists, If doesn't exist a 404 log will be created
   *
   * @param {string} id
   * @returns {(Promise<{} | Boolean>)}
   * @memberof ActiveDSConnect
   */
  public exists(id: string): Promise<{} | Boolean> {
    return new Promise<Boolean>((resolve) => {
      ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, {})
        .then((response: any) => resolve(response.data))
        .catch(() => {
          resolve(false);
        });
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
        .catch(reject);
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
        .catch(reject);
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
        .catch(reject);
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
        .catch(reject);
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
      if (ActiveOptions.get<any>("db", {}).selfhost) {
        ActiveRequest.send(`${this.location}/${doc._id}`, "DELETE")
          .then((response: any) => resolve(response.data))
          .catch(reject);
      } else {
        // Couchdb 2.3 supports purge again
        ActiveRequest.send(`${this.location}/_purge`, "POST", undefined, {
          [doc._id]: [doc._rev]
        })
          .then((response: any) => resolve(response.data))
          .catch(reject);
      }
    });
  }

  /**
   * Delete a sequence file
   *
   * @param {string} sequence
   * @returns {Promise<any>}
   * @memberof ActiveDSConnect
   */
  public async seqDelete(sequence: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(
        `${this.location}/_seq/${sequence}`,
        "DELETE"
      );
    } else {
      // Not supported, Fail quietly.
    }
  }

  /**
   * Get a sequence file
   *
   * @param {string} sequence
   * @returns {Promise<any>}
   * @memberof ActiveDSConnect
   */
  public async seqGet(sequence: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(
        `${this.location}/_seq/${sequence}`,
        "GET"
      );
    } else {
      // Not supported, Fail quietly.
    }
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
          .catch(reject);
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
export class ActiveDSChanges
  extends EventEmitter
  implements ActiveDefinitions.IActiveDSChanges
{
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
      .catch((error) => this.emit("error", error));
  }

  /**
   * Cancels the changes listner
   *
   * @memberof ActiveDSChanges
   */
  public cancel(): void {
    this.stop = true;
  }

  public restart(): void {
    this.stop = false;
    this.listen();
  }
}
