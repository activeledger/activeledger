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
import { requestBody, post } from "@loopback/rest";
// import {inject} from '@loopback/context';
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveNetwork } from "@activeledger/activenetwork";

export class SecuredController {
  /**
   * Creates an instance of TransactionController.
   * Adds a design view document into the database.
   *
   * @memberof SecuredController
   */
  constructor() {
    // Setup Mock Network Home
    ActiveledgerDatasource.getSelfNeighbour();
  }

  /**
   * Expose helpful encrypt method (Add warning about not SSL)
   *
   * @param {*} data
   * @returns {Promise<any>}
   * @memberof SecuredController
   */
  @post("/api/secured/encrypt", {
    description:
      "Warning Core doesn't natively support HTTPS so any data you send is clear text. Localhost or testing usage only recommended.",
    responses: {
      "200": {
        description: "Nested Permissioned Encrypted Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                $ADAC: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      ref: { type: "string" },
                      type: { type: "string" },
                      roles: { type: "string" }
                    }
                  }
                },
                data: {
                  type: "object",
                  additionalProperties: true
                }
              }
            }
          }
        }
      },
      "500": {
        description: "Failed to Encrypt",
        content: {
          "application/json": {
            schema: {
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
  })
  encrypt(
    @requestBody({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              $ADAC: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ref: { type: "string" },
                    type: { type: "string" },
                    roles: { type: "array", items: { type: "string" } }
                  }
                }
              },
              data: {
                type: "object",
                additionalProperties: true
              }
            }
          }
        }
      }
    })
    data: any
  ): Promise<{}> {
    return new Promise((resolve, reject) => {
      let secured = new ActiveCrypto.Secured(
        ActiveledgerDatasource.getDb(),
        ActiveledgerDatasource.getNeighbourhood(),
        {
          reference: ActiveNetwork.Home.reference,
          public: Buffer.from(ActiveNetwork.Home.publicPem, "base64").toString(
            "utf8"
          ),
          private: ActiveNetwork.Home.identity.pem
        }
      );
      secured
        .encrypt(data)
        .then(resolve)
        .catch(error => {
          resolve({
            statusCode: 500,
            message: error
          });
        });
    });
  }

  /**
   * Expose Helpful decrypt function
   *
   * @param {*} data
   * @returns {Promise<any>}
   * @memberof SecuredController
   */
  @post("/api/secured/decrypt", {
    description:
      "Warning Core doesn't natively support HTTPS so any data you receive is clear text. Localhost or testing usage only recommended.",
    responses: {
      "200": {
        description: "Nested Permissioned Decrypted Data",
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: true
            }
          }
        }
      },
      "500": {
        description: "Failed to Decrypt",
        content: {
          "application/json": {
            schema: {
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
  })
  async decrypt(
    @requestBody({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              $ADAC: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ref: { type: "string" },
                    type: { type: "string" },
                    roles: { type: "string" }
                  }
                }
              },
              data: {
                type: "object",
                additionalProperties: true
              }
            }
          }
        }
      }
    })
    data: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {      
      let secured = new ActiveCrypto.Secured(
        ActiveledgerDatasource.getDb(),
        ActiveledgerDatasource.getNeighbourhood(),
        {
          reference: ActiveNetwork.Home.reference,
          public: Buffer.from(ActiveNetwork.Home.publicPem, "base64").toString(
            "utf8"
          ),
          private: ActiveNetwork.Home.identity.pem
        }
      );
      secured
        .decrypt(data)
        .then((result: any) => {
          resolve(result.data);
        })
        .catch(error => {
          resolve({
            statusCode: 500,
            message: error
          });
        });
    });
  }
}
