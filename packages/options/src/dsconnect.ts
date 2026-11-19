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
import { createHash } from "crypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveRequest, StorageSocket } from "@activeledger/activeutilities";
import { ActiveOptions } from "./options";

const REMOVE_CACHE_TIMER = 5 * 60 * 1000;

/**
 * Sends HTTP requests to the data store
 *
 * @export
 * @class ActiveDSConnect
 * @implements {ActiveDefinitions.IActiveDSConnect}
 */
/**
 * Document ids reach these methods from callers that do not own them -
 * Endpoints.streams() passes whatever a peer asked about straight through -
 * so they are encoded before becoming a URL path segment.
 *
 * Unencoded, a "../" inside an id stops being part of the document name the
 * moment a URL parser sees it: it walks up out of the database path, and a
 * request for one database becomes a request for another. The store's
 * getDB() then throws for the unrecognised name from inside a Promise
 * executor, which surfaces as an unhandled rejection rather than a 500.
 *
 * Safe for the ids this ledger actually uses: the ":" in "<id>:stream",
 * "<id>:data" and "umid:..." becomes %3A on the wire, and the store decodes
 * the path again before looking it up.
 */
export class ActiveDSConnect implements ActiveDefinitions.IActiveDSConnect {
  /**
   * Creates an instance of DBConnector.
   * @param {string} location
   */
  constructor(private location: string) {
    // Local socket to the node's storage process, unless switched off
    // (db.selfhost.socket: false), and only when this
    // really is that process (same loopback port)
    const selfhost = ActiveOptions.get<any>("db", {}).selfhost;
    if (selfhost && selfhost.socket !== false) {
      try {
        const url = new URL(location);
        if (
          (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
          url.port === `${selfhost.port}`
        ) {
          StorageSocket.register(url.origin, StorageSocket.defaultPath(selfhost.port));
        }
      } catch {
        // Not a URL: nothing to register
      }
    }
    // Search to make sure the database exists
    // DISABLED
    //this.timerUnCache();
  }

  /**
   * Clears Cache
   *
   * @private
   */
  private timerUnCache() {
    setTimeout(() => {
      const memory = Object.keys(this.secondaryCache);
      const nowMinus5 = new Date(Date.now() - REMOVE_CACHE_TIMER * 2);
      for (let i = memory.length; i--; ) {
        if (this.secondaryCache[memory[i]].data < nowMinus5) {
          // 5 minutes has passed without accessing it so lets clear
          delete this.secondaryCache[memory[i]];
        }
      }
      this.timerUnCache();
    }, REMOVE_CACHE_TIMER);
  }

  /**
   * We need a way to clear this cache for Position Incorrect! (Or all errors?)
   *
   * @param {string} key
   */
  public clearCache(key: string) {
    delete this.secondaryCache[key];
  }

  /**
   * Creates Database / Get Database Info
   *
   * @returns
   */
  public info(): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}`, "GET")
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }

  /**
   * Drops database table
   *
   * @returns {Promise<any>}
   */
  public drop(): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}`, "DELETE")
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }

  /**
   * Create an index
   *
   * @param {*} [options={}]
   * @returns
   */
  public createIndex(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_index`, "POST", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }
  // TODO _rev doesn't go up correct
  // for now disabling this cache

  private secondaryCache: {
    [index: string]: {
      data: any;
      create: Date;
    };
  } = {};

  /**
   * Returns all the documents in the database
   *
   * @param {*} [options]
   * @returns
   */

  public async allDocs(options?: any): Promise<any> {
    //return new Promise(async (resolve, reject) => {

    const x = await ActiveRequest.send(
      `${this.location}/_all_docs`,
      options ? "POST" : "GET",
      undefined,
      options
    );
    return x.data;

    // if (options.keys) {
    //   let tmpKeys = options.keys;
    //   let cached = [];
    //   //const now = new Date();

    //   // for (let i = options.keys.length; i--;) {
    //   //   if (!this.secondaryCache[options.keys[i]]) {
    //   //     tmpKeys.push(options.keys[i]);
    //   //   } else {
    //   //     cached.push({ doc: this.secondaryCache[options.keys[i]].data });
    //   //     this.secondaryCache[options.keys[i]].create = now;
    //   //   }
    //   // }

    //   // Get uncached
    //   if (tmpKeys) {
    //     const result = await ActiveRequest.send(
    //       `${this.location}/_all_docs`,
    //       options ? "POST" : "GET",
    //       undefined,
    //       { ...options, keys: tmpKeys }
    //     );

    //     // Loop and cache
    //     for (let i = (result.data as any).rows.length; i--;) {
    //       const data = (result.data as any).rows[i].doc;

    //       // DISABLED
    //       // this.secondaryCache[data._id] = {
    //       //   data: data,
    //       //   create: new Date()
    //       // }
    //       cached.push({ doc: data });
    //     }
    //   }

    //   // TODO: Track offset?
    //   return { total_rows: cached.length, offset: 0, rows: cached };
    // } else {
    //   const x = await ActiveRequest.send(
    //     `${this.location}/_all_docs`,
    //     options ? "POST" : "GET",
    //     undefined,
    //     options
    //   );
    //   return x.data;
    // }

    //  .then((response: any) => resolve(response.data))
    //  .catch(reject);
    //});
  }

  /**
   * Get a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   */
  public get(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${encodeURIComponent(id)}`, "GET", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });

    // if (!this.secondaryCache[id]) {
    //   const response = await ActiveRequest.send(`${this.location}/${encodeURIComponent(id)}`, "GET", undefined, options);
    //   return response.data
    //   // DISABLED
    //   // this.secondaryCache[id] = {
    //   //   data: response.data,
    //   //   create: new Date()
    //   // } // TODO Error Handling now?
    // }
    // return this.secondaryCache[id].data;
  }

  /**
   * Create New or Gets a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   */
  public createget(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve) => {
      ActiveRequest.send(`${this.location}/${encodeURIComponent(id)}`, "GET", undefined, options)
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
   */
  public exists(id: string): Promise<Boolean> {
    return new Promise<Boolean>((resolve) => {
      ActiveRequest.send(`${this.location}/${encodeURIComponent(id)}`, "GET", undefined, {})
        .then((response: any) => resolve(response.data?._id ? true : false))
        .catch(() => {
          resolve(false);
        });
    });
  }


  /**
   * Create / Append multiple documents at the same time
   *
   * @param {any[]} docs
   * @param {*} [options={}]
   * @param {number} [timeout] seconds, undici's 300 when not given
   * @returns
   */
  public bulkDocs(docs: any[], options: any = {}, timeout?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/_bulk_docs`,
        "POST",
        undefined,
        { docs, options },
        false,
        timeout
      )
        .then((response: any) => {
          resolve(response.data);
          // Update cache
          // const create = new Date();
          // for (let i = docs.length; i--;) {
          //   // Update MD5 (We are doing this twice in 2 different processors)
          //   const md5 = createHash("md5").update(docs[i]).digest("hex");
          //   if (docs[i]._rev) {
          //     const pos = parseInt(docs[i]._rev.split("-")[0]) + 1;
          //     docs[i]._rev = `${pos}-${md5}`;
          //   } else {
          //     // Or just don't cache "new"?
          //     docs[i]._rev = `1-${md5}`;
          //   }

          //   // DISABLED
          //   this.secondaryCache[docs[i]._id] = {
          //     data: docs[i],
          //     create
          //   }
          // }
        })
        .catch(reject);
    });
  }

  /**
   * Create a document with auto generated id
   *
   * @param {} doc
   * @returns
   */
  public post(doc: {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(this.location, "POST", undefined, doc)
        .then((response: any) => {
          resolve(response.data);

          // We need to update _rev here, Should we just fetch in background?
          // Or do we manage md5 ourself

          // Update MD5 (We are doing this twice in 2 different processors)
          // const md5 = createHash("md5").update((doc as any)).digest("hex");
          // if ((doc as any)._rev) {
          //   const pos = parseInt((doc as any)._rev.split("-")[0]) + 1;
          //   (doc as any)._rev = `${pos}-${md5}`;
          // }
          // else {
          //   // Or just don't cache "new"?
          //   (doc as any)._rev = `1-${md5}`;
          // }

          // // DISABLED
          // this.secondaryCache[(doc as any)._id] = {
          //   data: doc,
          //   create: new Date()
          // }
        })
        .catch(reject);
    });
  }

  /**
   * Create / Append a document
   *
   * @param {{ _id: string }} doc
   * @returns
   */
  public put(doc: { _id: string; _rev?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${doc._id}`, "PUT", undefined, doc)
        .then((response: any) => {
          resolve(response.data);

          // We need to update _rev here, Should we just fetch in background?
          // Or do we manage md5 ourself

          // if ((doc as any)._rev) {
          //   // Update MD5 (We are doing this twice in 2 different processors)
          //   const md5 = createHash("md5").update((doc as any)).digest("hex");
          //   const pos = parseInt((doc as any)._rev.split("-")[0]) + 1;
          //   (doc as any)._rev = `${pos}-${md5}`;
          // }

          // // DISABLED
          // this.secondaryCache[(doc as any)._id] = {
          //   data: doc,
          //   create: new Date()
          // }
        })
        .catch(reject);
    });
  }

  /**
   * Purges document from the database
   *
   * @param {{}} doc
   * @returns {Promise<any>}
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
          [doc._id]: [doc._rev],
        })
          .then((response: any) => resolve(response.data))
          .catch(reject);
      }
    });
  }





  /**
   * Backups the database
   *
   * @returns {Promise<any>}
   */
  public async backup(filename?: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(`${this.location}/_backup`, "POST", [], {
        filename,
      });
    } else {
      // Not supported, Fail quietly.
    }
  }

  /**
   * Restore the database
   *
   * @returns {Promise<any>}
   */
  public async restore(filename: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(`${this.location}/_restore`, "POST", [], {
        filename,
      });
    } else {
      // Not supported, Fail quietly.
    }
  }

}
