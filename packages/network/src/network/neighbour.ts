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

import { ActiveOptions, ActiveRequest } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Home } from "./home";

/**
 * Manages Node Connection Information
 *
 * @export
 * @class Neighbour
 */
export class Neighbour implements ActiveDefinitions.INeighbourBase {
  /**
   * Holds the reference value of the NodeNeighbour
   *
   * @private
   * @type {string}
   * @memberof Neighbour
   */
  public reference: string;

  /**
   * Controls if this neighbour should slowly be turned off.
   *
   * @type {boolean}
   * @memberof Neighbour
   */
  public graceStop: boolean = false;

  /**
   * Creates an instance of NodeNeighbour.
   * @param {string} host
   * @param {number} port
   * @memberof Neighbour
   */
  constructor(
    protected host: string,
    protected port: number,
    public isHome: boolean = false,
    private identity?: ActiveCrypto.KeyPair
  ) {
    this.reference = ActiveCrypto.Hash.getHash(
      host + port + ActiveOptions.get<string>("network", ""),
      "sha1"
    );
  }

  /**
   * Expose Neighbours address
   *
   * @returns {{host: string, port: number}}
   * @memberof Neighbour
   */
  public getAddress(): { host: string; port: number } {
    return {
      host: this.host,
      port: this.port
    };
  }

  /**
   * Verify Signature for & from this neighbour
   *
   * @param {string} signature
   * @param {string} data
   * @returns {boolean}
   * @memberof Neighbour
   */
  public verifySignature(signature: string, data: string): boolean {
    if (this.identity) {
      return this.identity.verify(data, signature);
    }
    return false;
  }

  /**
   * Send authenticated request to this neighbour (Knock on their door)
   * wrapping http request promise so we can easily log errors and throw whole object
   * without having to always string / parse.
   *
   * @param {string} endpoint
   * @param {*} [params]
   * @param {boolean} [external]
   * @returns {Promise<any>}
   * @memberof Neighbour
   */
  public knock(
    endpoint: string,
    params?: any,
    external?: boolean,
    resend?: number
  ): Promise<any> {
    if (!params) {
      // Not Params, Sent Get without signature
      return new Promise((resolve, reject) => {
        ActiveRequest.send(
          `http://${this.host}:${this.port}/a/${endpoint}`,
          "GET",
          ["X-Activeledger:" + Home.reference]
        )
          .then((response) => {
            resolve(response);
          })
          .catch((error) => {
            ActiveLogger.error(
              error,
              `${this.host}:${this.port}/${endpoint} - GET Failed`
            );
            reject(error);
          });
      });
    } else {
      // Default vars for request
      let url: string;
      let post: any;

      // Does the request need to be marshed externally
      if (external) {
        // External
        url = `http://${this.host}:${this.port}/${endpoint}`;

        // No changes
        post = params;
      } else {
        url = `http://${this.host}:${this.port}/a/${endpoint}`;

        // Sign Request into params
        post = {
          $neighbour: {
            reference: Home.reference,
            signature: Home.sign(params)
          },
          $packet: this.encryptKnock(params)
        };
      }

      // Send SignedFor Post Request
      return new Promise((resolve, reject) => {
        let attempt = (attempts: number) => {
          ActiveRequest.send(
            url,
            "POST",
            ["X-Activeledger:" + Home.reference],
            post,
            true
          )
            .then(resolve)
            .catch((error: any) => {
              if (error && error.response && error.response.data) {
                ActiveLogger.error(
                  error.response.data,
                  `${this.host}:${this.port}/${endpoint} - POST Failed`
                );
                reject(error.response.data);
              } else {
                // TODO : If connection failure rebase neighbourhood?
                if (
                  resend &&
                  resend >= attempts &&
                  error.code == "ECONNRESET"
                ) {
                  // Resend Attempt
                  ActiveLogger.warn(
                    "Network Issue : Resending due to unexpected closed socket"
                  );
                  attempt(++attempts);
                } else {
                  ActiveLogger.fatal(
                    error,
                    `Network Error - ${this.host}:${this.port}/${endpoint}`
                  );
                  reject("Network Communication Error");
                }
              }
            });
        };
        // Start
        attempt(0);
      });
    }
  }

  /**
   * Encrypt transaction if configration is setup for encrypted consensus
   *
   * @private
   * @param {*} data
   * @returns {*}
   * @memberof Neighbour
   */
  private encryptKnock(data: any): any {
    // Don't encrypt to self
    // Make sure we have an idenity to encrypt
    // Is the network encrypt protected?
    if (
      this.reference !== Home.reference &&
      this.identity &&
      ActiveOptions.get<any>("security", {}).encryptedConsensus
    ) {
      return this.identity.encrypt(data);
    }
    return data;
  }
}
