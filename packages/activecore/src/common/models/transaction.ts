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
import Client, { CouchDoc, FindOptions } from "davenport";
import { Model } from "@mean-expert/model";
import { Model as LBModel } from "../../fireloop";

/**
 * Exposes methods to search the ledger transactions
 *
 * @export
 * @class Transaction
 */
@Model({
  hooks: {},
  remotes: {
    Transaction: {
      accepts: { arg: "umid", type: "string", required: true },
      returns: { arg: "tx", type: "object" },
      http: { path: "/:umid", verb: "get" }
    }
  }
})
export default class Transaction {
  /**
   * Database Connection
   *
   * @private
   * @type {Client}
   * @memberof Transaction
   */
  private db: Client<CouchDoc>;

  /**
   * Configuration
   *
   * @private
   * @type {*}
   * @memberof Transaction
   */
  private config: any;

  /**
   * Creates an instance of Transaction.
   * @param {LBModel} model
   * @memberof Transaction
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
    this.db = new Client(this.config.db.url, this.config.db.database);

    // Create the design document if it doesn't exist
    this.db
      .exists("_design/activecore")
      .then(exists => {
        if (!exists) {
          this.db.put(
            "_design/activecore",
            {
              views: {
                tx: {
                  map:
                    'function (doc) {\n  if(doc.$stream && doc._id.substr(-7) === ":stream") {\n  for(let tx of doc.txs) {\n    emit(tx.$umid, 1);\n  }\n  }\n}'
                }
              },
              language: "javascript",
            } as CouchDoc,
            ""
          );
        }
      })
      .catch(() => {});
  }

  /**
   * Returns Transaction data
   *
   * @param {string} umid
   * @param {Function} next
   * @memberof Transaction
   */
  public Transaction(umid: string, next: Function): void {
    this.db
      .viewWithDocs("activecore", "tx", {
        key: umid,
        limit: 1
      })
      .then(document => {
        // Make sure we have rows
        if (document.rows.length) {
          let stream = document.rows[0].doc as any;
          // Now we need to find the transaction with the umid
          let i = stream.txs.length;
          while (i--) {
            if (stream.txs[i].$umid == umid) {
              return next(null, stream.txs[i]);
            }
          }
        }
        // We shouldn't get here so show error
        return next(`${umid} cannot be found`);
      })
      .catch(error => {
        return next(error);
      });
  }
}
