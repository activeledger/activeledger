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
import { Neighbourhood } from "./neighbourhood";

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
   */
  public reference: string;

  /**
   * Controls if this neighbour should slowly be turned off.
   *
   * @type {boolean}
   */
  public graceStop: boolean = false;

  /**
   * Creates an instance of NodeNeighbour.
   * @param {string} host
   * @param {number} port
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

    // Has this address reference been remapped out
    if (
      Neighbourhood.remapedAddr &&
      Neighbourhood.remapedAddr[this.reference]
    ) {
      this.reference = Neighbourhood.remapedAddr[this.reference];
    }
  }

  /**
   * Expose Neighbours address
   *
   * @returns {{host: string, port: number}}
   */
  public getAddress(): { host: string; port: number } {
    return {
      host: this.host,
      port: this.port,
    };
  }

  /**
   * Verify Signature for & from this neighbour
   *
   * @param {string} signature
   * @param {string} data
   * @returns {boolean}
   */
  public verifySignature(signature: string, data: string): boolean {
    if (this.identity) {
      return this.identity.verify(data, signature);
    }
    return false;
  }

  private bundle: any[] = [];
  private nextSend: NodeJS.Timeout | null;

  /**
   * Send authenticated request to this neighbour (Knock on their door)
   * wrapping http request promise so we can easily log errors and throw whole object
   * without having to always string / parse.
   *
   * @param {string} endpoint
   * @param {*} [params]
   * @param {boolean} [external]
   * @returns {Promise<any>}
   */
  public knock(
    endpoint: string,
    params?: any,
    external?: boolean,
    resend?: number,
    bundle?: boolean
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
            // ActiveLogger.error(
            //   error,
            //   `${this.host}:${this.port}/${endpoint} - GET Failed`
            // );
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
            signature: Home.sign(params, params.$signed),
          },
          $packet: this.encryptKnock(params, params.$encrypt),
          $enc: params.$encrypt ? true : false,
        };
      }
      // TODO 
      // Why sending as buffer here with errors "data that sent error"
      // Fix this will give performance. Maybe tx could be lost?
      // Currently this boosted performance by about 4x

      // Send SignedFor Post Request
      const sender = (post: Buffer, extraHeader: string) => new Promise((resolve, reject) => {
        let attempt = (attempts: number) => {
          ActiveRequest.send(
            url,
            "POST",
            ["X-Activeledger:" + Home.reference, "content-type: application/json", extraHeader],
            post, // TODO above is a bit of a lie but managed by host
            ActiveOptions.get<boolean>("gzip", true)
          )
            // TODO: Interface needed
            .then((response: any) => {
              if (response.data.$enc && response.data.$packet) {
                response.data = JSON.parse(
                  Buffer.from(
                    Home.identity.decrypt(response.data.$packet),
                    "base64"
                  ).toString()
                );
              }
              resolve(response);
            })
            .catch((error: any) => {
              if (error && error.response && error.response.data) {
                // ActiveLogger.error(
                //   error.response.data,
                //   `${this.host}:${this.port}/${endpoint} - POST Failed`
                // );
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
                  // ActiveLogger.error(
                  //   post,
                  //   `Data sent which caused the error`
                  // );
                  if (extraHeader !== "X-Bundle: 1") {
                    reject("Network Communication Error");
                  } else {
                    resolve({ ok: 1 });
                  }
                }
              }
            });
        };
        // Start
        attempt(0);
      });

      // Now can we detect "response broadcast, not waiting maybe faster?"
      // or possibly waiting less

      // Another idea is dynamic settimeout keep changing it? Such as "wait 10ms +10ms if sending again"

      // TODO make better!
      if (bundle) {

        // if(Buffer.isBuffer(post)) {
        //   console.log("POST IS ALREADY A BUFFER!!!!!");
        //   console.trace();
        // }

        this.bundle.push(JSON.stringify(post));

        if (this.bundle.length >= 80) {
          // Cancel & Just Send
          // if (this.nextSend) {
          //   clearTimeout(this.nextSend);
          //   this.nextSend = null;
          // }
          //console.log("SENDING FROM LIMIT " + this.bundle.length);
          sender(Buffer.from(this.bundle.join(":$ALB:")), "X-Bundle: 1");
          this.bundle = []
          // Need to clear better

          // Cancel & Just Send
          if (this.nextSend) {
            clearTimeout(this.nextSend);
            this.nextSend = null;
          }
        } else {
          //if (this.bundle.length === 1) {
          if(!this.nextSend) {
            let x = this.nextSend = setTimeout(() => {
              this.nextSend = null;
              //console.log("SENDING FROM TIMEOUT ("+x+") " + this.bundle.length);
              sender(Buffer.from(this.bundle.join(":$ALB:")), "X-Bundle: 1");
              this.bundle = []
              // Need to clear better
            }, 80);

          }

          // maybe a/b bundles?

          //this.bundle.push(JSON.stringify(post));

        }


        // this.bundle.push(JSON.stringify(post));
        // if (this.bundle.length == 1) {

        //   // Now lets try and be smart!



        //   //Need a timeout to send the bundle
        //   setTimeout(() => {
        //     const data = this.bundle.join(":$ALB:");
        //     sender(Buffer.from(data), "X-Bundle: 1");
        //     // Need to clear better
        //     this.bundle = []
        //   }, 50);
        // }
        // Just return, Bundle doesn't want a response!
        return Promise.resolve();
      } else {

        // if(Buffer.isBuffer(post)) {
        //   console.log("POST IS ALREADY A BUFFER!!!!!");
        //   console.trace();
        // }
        return sender(Buffer.from(JSON.stringify(post)), 'X-Null: 0');
      }

    }
  }

  /**
   * Encrypt transaction if configration is setup for encrypted consensus
   *
   * @private
   * @param {*} data
   * @param {boolean} [encrypted=false]
   * @returns {*}
   */
  public encryptKnock(data: any, encrypted: boolean = false): any {
    // Don't encrypt to self
    // Make sure we have an idenity to encrypt
    // Is the network encrypt protected?
    if (
      this.reference !== Home.reference &&
      this.identity &&
      (encrypted || ActiveOptions.get<any>("security", {}).encryptedConsensus)
    ) {
      return this.identity.encrypt(data);
    }
    return data;
  }
}
