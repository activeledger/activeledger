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

import { ActiveledgerDatasource } from "../datasources/activeledger";
import { param, get, HttpErrors } from "@loopback/rest";
// import {inject} from '@loopback/context';

export class TransactionController {
  /**
   * Creates an instance of TransactionController.
   * Adds a design view document into the database.
   *
   * @memberof TransactionController
   */
  constructor() {
    // Create the design document if it doesn't exist
    ActiveledgerDatasource.getDb()
      .get("_design/activecore")
      .then(() => {})
      .catch((exists: any) => {
        if (exists.status === 404) {
          ActiveledgerDatasource.getDb().put({
            _id: "_design/activecore",
            views: {
              tx: {
                map:
                  'function (doc) {\n  if(doc.$stream && doc._id.substr(-7) === ":stream") {\n  for(let tx of doc.txs) {\n    emit(tx.$umid, 1);\n  }\n  }\n}'
              }
            },
            language: "javascript"
          });
        }
      });
  }

  /**
   * Returns Transaction data
   *
   * @param {string} umid
   * @returns {Promise<any>}
   * @memberof TransactionController
   */
  @get("/api/tx/{umid}", {
    responses: {
      "200": {
        description: "Transaction Message",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                stream: {
                  type: "object",
                  properties: {
                    $umid: { type: "object" },
                    $tx: { type: "object" },
                    $sigs: { type: "object" },
                    $revs: { type: "object" },
                    $selfsign: { type: "boolean" }
                  }
                }
              }
            }
          }
        }
      },
      "404": {
        description: "Transaction Message Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: {
                  type: "object",
                  properties: {
                    statusCode: { type: "number" },
                    name: { type: "string" },
                    message: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  })
  async tx(@param.path.string("umid") umid: string): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveledgerDatasource.getDb()
        .query("activecore/tx", {
          key: umid,
          limit: 1,
          reduce: false,
          include_docs: true
        })
        .then((document: any) => {
          // Make sure we have rows
          if (document.rows.length) {
            let stream = document.rows[0].doc as any;
            // Now we need to find the transaction with the umid
            let i = stream.txs.length;
            while (i--) {
              if (stream.txs[i].$umid === umid) {
                resolve(stream.txs[i]);
              }
            }
          }
          // We shouldn't get here so show error
          return reject(new HttpErrors.NotFound(`${umid} cannot be found`));
        })
        .catch((error: Error) => {
          return reject(error.message);
        });
    });
  }
}
