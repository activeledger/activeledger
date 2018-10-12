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

import { ActiveOptions } from "@activeledger/activeoptions";
import { QueryEngine } from "@activeledger/activequery";
import * as axios from "axios";
import { Model } from "@mean-expert/model";
import { Model as LBModel } from "../../fireloop";
// @ts-ignore
import * as PouchDB from "pouchdb";
// @ts-ignore
import * as PouchDBFind from "pouchdb-find";
// Add Find Plugin
PouchDB.plugin(PouchDBFind);

/**
 * Exposes methods to search the ledger data
 *
 * @export
 * @class Stream
 */
@Model({
  hooks: {},
  remotes: {
    changes: {
      accepts: { arg: "include_docs", type: "boolean", default: false },
      returns: { arg: "changes", type: "object" },
      http: { path: "/changes", verb: "get" }
    },
    search: {
      accepts: { arg: "sql", type: "string", required: true },
      returns: { arg: "streams", type: "array" },
      http: { path: "/search", verb: "post" }
    },
    stream: {
      accepts: { arg: "stream", type: "string", required: true },
      returns: { arg: "stream", type: "object" },
      http: { path: "/:stream", verb: "get" }
    },
    volatile: {
      accepts: { arg: "stream", type: "string", required: true },
      returns: { arg: "write", type: "object" },
      http: { path: "/:stream/volatile", verb: "get" }
    },
    save: {
      accepts: [
        { arg: "stream", type: "string", required: true },
        {
          arg: "data",
          type: "object",
          required: true,
          http: { source: "body" }
        }
      ],
      returns: { arg: "stream", type: "boolean" },
      http: { path: "/:stream/volatile", verb: "post" }
    }
  }
})
export default class Stream {
  /**
   * Database Connection
   *
   * @private
   * @type {PouchDB}
   * @memberof Stream
   */
  private db: any;

  /**
   * Activeledger query engine
   *
   * @private
   * @type {QueryEngine}
   * @memberof Stream
   */
  private query: QueryEngine;

  /**
   * Configuration
   *
   * @private
   * @type {*}
   * @memberof Stream
   */
  private config: any;

  /**
   * Creates an instance of Stream.
   * @param {LBModel} model
   * @memberof Stream
   */
  constructor(public model: LBModel) {
    // Self Hosted?
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      // Get Database
      let db = ActiveOptions.get<any>("db", {});

      // Set Url
      db.url = "http://127.0.0.1:" + db.selfhost.port;

      // We can also update the path to override the default couch install
      db.path = db.selfhost.dir || "./.ds";

      // Set Database
      ActiveOptions.set("db", db);
    }

    // Get Config from global
    this.config = ActiveOptions.fetch(false);

    // Create Database Connection
    this.db = new PouchDB(this.config.db.url + "/" + this.config.db.database);
    this.query = new QueryEngine(
      this.db,
      false,
      ActiveOptions.get<number>("queryLimit", 0)
    );
  }

  /**
   * Get latest Changes
   *
   * @param {boolean} docs
   * @param {Function} next
   * @memberof Stream
   */
  public changes(docs: boolean, next: Function): void {
    axios.default
      .get(
        this.config.db.url +
          "/" +
          this.config.db.database +
          "/_changes?descending=true&include_docs=" +
          docs
      )
      .then(response => {
        // Filter out changes
        // TODO: consider using predefined filter (with auto install)
        let changes = [];
        let i = response.data.results.length;
        while (i--) {
          // First remove volatile (no $volatile for quick lookup as we cannot control who or what wil lwrite the data)
          if (
            response.data.results[i].id.substring(
              response.data.results[i].id.length - 8
            ) != "volatile"
          ) {
            // Check for docs as quicker lookup
            if (docs) {
              if (!response.data.results[i].doc.$stream)
                changes.push(response.data.results[i]);
            } else {
              // Need to match id
              if (
                response.data.results[i].id.substring(
                  response.data.results[i].id.length - 6
                ) != "stream"
              )
                changes.push(response.data.results[i]);
            }
          }
        }
        return next(null, changes);
      })
      .catch(error => {
        next(error);
      });
  }

  /**
   * Returns stream data
   *
   * @param {string} stream
   * @param {Function} next
   * @memberof Stream
   */
  public stream(stream: string, next: Function): void {
    this.db
      .get(stream)
      .then((document:any) => {
        return next(null, document);
      })
      .catch((error:any) => {
        return next(error);
      });
  }

  /**
   * Returns volatile stream data
   *
   * @param {string} stream
   * @param {Function} next
   * @memberof Stream
   */
  public volatile(stream: string, next: Function): void {
    this.db
      .get(stream + ":volatile")
      .then((document:any) => {
        next(null, document);
      })
      .catch((error:any) => {
        if (error.message) {
          return next(error.message);
        }
        next(error);
      });
  }

  /**
   * save volatile stream data
   * TODO: Decide if we should have some kind of control over this write
   *
   * @param {string} stream
   * @param {Function} next
   * @memberof Stream
   */
  public save(stream: string, data: any, next: Function): void {
    this.db
      .get(stream + ":volatile")
      .then((document:any) => {
        // Now add _id and _rev to data
        data._id = document._id;
        data._rev = document._rev;

        // Now we can commit
        this.db
          .put(data)
          .then(() => {
            next(null, true);
          })
          .catch((error: any) => {
            if (error.message) {
              return next(error.message);
            }
            next(error);
          });
      })
      .catch((error:any) => {
        next(error);
      });
  }

  /**
   * Returns streams matching basic SQL query
   *
   * @param {string} sql
   * @param {Function} next
   * @memberof Stream
   */
  public search(sql: string, next: Function): void {
    this.query
      .sql(sql)
      .then(documents => {
        next(null, documents);
      })
      .catch(error => {
        next(error);
      });
  }
}
