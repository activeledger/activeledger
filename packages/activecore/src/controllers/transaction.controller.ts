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
import { param, get } from "@loopback/rest";

export class TransactionController {
  /**
   * Creates an instance of TransactionController.
   * Adds a design view document into the database.
   *
   * @memberof TransactionController
   */
  constructor() {}

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
                umid: {
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
    let result = await ActiveledgerDatasource.getDb().get(umid + ":umid");
    if (result) {
      return {
        umid: result.umid
      };
    } else {
      return result;
    }
  }
}
