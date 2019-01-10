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

import * as crypto from "crypto";
//import * as NodeRsa from "node-rsa";
import { ActiveLogger } from "@activeledger/activelogger";
import { Hash } from "./hash";
import { AsnParser } from "./asn";

/**
 * Contains key specific values
 *
 * @export
 * @interface KeyHandleDetails
 */
export interface KeyHandleDetails {
  pkcs8pem: string;
  hash?: string;
}

/**
 * Contains Public & Private key data
 *
 * @export
 * @interface KeyHandler
 */
export interface KeyHandler {
  pub: KeyHandleDetails;
  prv: KeyHandleDetails;
}

/**
 * Manages Public Private Key Cryptography
 *
 * @export
 * @class KeyPair
 */
export class KeyPair {
  /**
   * RSA Object
   *
   * @private
   * @type {NodeRsa}
   * @memberof KeyPair
   */
  private rsa: crypto.DiffieHellman;

  /**
   * Holds Public Private Data
   *
   * @private
   * @type {KeyHandler}
   * @memberof KeyPair
   */
  private handler: KeyHandler;

  /**
   * EC Key been passed for compaitibility
   *
   * @private
   * @memberof KeyPair
   */
  private compatMode = false;

  /**
   * Creates an instance of KeyPair.
   * @param {*} [type="rsa"]
   * @param {*} [pem]
   * @memberof KeyPair
   */
  constructor(type?: string);
  constructor(type?: string, pem?: string);
  constructor(private type: any = "rsa", public pem?: any) {
    if (pem) {
      switch (type) {
        case "rsa":
        case "bitcoin":
        case "ethereum":
        case "secp256k1":
          if (pem.indexOf("PRIVATE") == -1) {
            this.createHandler("", pem);
          } else {
            this.createHandler(pem);
          }
          break;
        default:
          throw "Unknown / unset key type";
      }
    }
  }

  /**
   *Creates handler object
   *
   * @private
   * @param {string} prv
   * @param {string} [pub=""]
   * @memberof KeyPair
   */
  private createHandler(prv: string, pub: string = ""): void {
    this.handler = {
      pub: {
        pkcs8pem: pub
      },
      prv: {
        pkcs8pem: prv
      }
    };
  }

  /**
   * Generate Key Pair
   *
   * @param {number} [bits=2048]
   * @returns {KeyHandler}
   * @memberof KeyPair
   */
  public generate(bits: number = 2048): KeyHandler {
    switch (this.type) {
      case "rsa":
        //@ts-ignore
        let rsa = crypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: {
            type: "spki",
            format: "pem"
          },
          privateKeyEncoding: {
            type: "pkcs8",
            format: "pem"
          }
        });

        // Create Return Object
        this.handler = {
          pub: {
            pkcs8pem: rsa.publicKey
          },
          prv: {
            pkcs8pem: rsa.privateKey
          }
        };

        // Update Hashes
        this.handler.pub.hash = Hash.getHash(this.handler.pub.pkcs8pem);
        this.handler.prv.hash = Hash.getHash(this.handler.prv.pkcs8pem);

        return this.handler;
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        let curve: crypto.ECDH = crypto.createECDH("secp256k1");
        curve.generateKeys();

        // Create Return Object
        this.handler = {
          pub: {
            pkcs8pem: AsnParser.encodeECPublicKey(curve.getPublicKey())
          },
          prv: {
            pkcs8pem: AsnParser.encodeECPrivateKey(
              curve.getPrivateKey(),
              curve.getPublicKey()
            )
          }
        };

        // Update Hashes
        this.handler.pub.hash = Hash.getHash(this.handler.pub.pkcs8pem);
        this.handler.prv.hash = Hash.getHash(this.handler.prv.pkcs8pem);

        return this.handler;
      default:
        throw ActiveLogger.fatal(`Cannot generate ${this.type} key pair type`);
    }
  }

  /**
   * Encrypt
   *
   * @param {*} data
   * @param {*} [encoding="base64"]
   * @returns {string}
   * @memberof KeyPair
   */
  public encrypt(data: string): string;
  public encrypt(data: Object): string;
  public encrypt(data: Buffer): string;
  public encrypt(data: any, encoding: any = "base64"): string {
    // if (this.type == "rsa" && this.rsa) {
    //   return this.rsa.encrypt(data, encoding).toString();
    // }
    throw ActiveLogger.fatal(data, `Cannot encrypt with ${this.type}`);
  }

  /**
   * Decrypt
   *
   * @param {*} data
   * @param {*} [encoding="base64"]
   * @returns {string}
   * @memberof KeyPair
   */
  public decrypt(data: string): string;
  public decrypt(data: Object): string;
  public decrypt(data: Buffer): string;
  public decrypt(data: any, encoding: any = "base64"): string {
    // if (this.type == "rsa" && this.rsa) {
    //   return this.rsa.decrypt(data, encoding).toString();
    // }
    throw ActiveLogger.fatal(data, `Cannot decrypt with ${this.type}`);
  }

  /**
   * Sign
   *
   * @param {*} data
   * @param {*} [encoding="base64"]
   * @returns {string}
   * @memberof KeyPair
   */
  public sign(data: string): string;
  public sign(data: Object): string;
  public sign(data: Buffer): string;
  public sign(data: any, encoding: any = "base64"): string {
    // Check we have a private key
    if (!this.handler.prv.pkcs8pem) {
      throw ActiveLogger.fatal(
        data,
        `Cannot sign with ${this.type} Public key`
      );
    }

    // Signing Digest Object
    let sign;

    // Sign by type
    switch (this.type) {
      case "rsa":
        sign = crypto.createSign("RSA-SHA256");
        sign.update(data);
        return new Buffer(
          sign.sign(this.handler.prv.pkcs8pem, "hex"),
          "hex"
        ).toString(encoding);
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        try {
          sign = crypto.createSign("SHA256");
          sign.update(data);
          return new Buffer(
            sign.sign(this.handler.prv.pkcs8pem, "hex"),
            "hex"
          ).toString(encoding);
        } catch {
          if (!this.compatMode) {
            // Convert PEM for compatibility?
            this.handler.prv.pkcs8pem = AsnParser.encodeECPrivateKey(
              Buffer.from(
                AsnParser.decodeECPrivateKey(this.handler.prv.pkcs8pem),
                "hex"
              ),
              Buffer.from("")
            );

            return this.sign(data);
          } else {
            throw ActiveLogger.fatal(
              data,
              `Cannot sign with ${this.type} supplied PEM`
            );
          }
        }
      default:
        throw ActiveLogger.fatal(data, `Cannot sign with ${this.type}`);
    }
  }

  /**
   * Verify
   *
   * @param {*} data
   * @param {*} [encoding="base64"]
   * @returns {string}
   * @memberof KeyPair
   */
  public verify(data: string, signature: string): boolean;
  public verify(data: Object, signature: string): boolean;
  public verify(data: Buffer, signature: string): boolean;
  public verify(
    data: any,
    signature: string,
    encoding: any = "base64"
  ): boolean {
    // Presence of pub key may not be in pem.
    if (!this.handler.pub.pkcs8pem) {
      throw ActiveLogger.fatal(
        data,
        `Cannot verify with ${this.type} Private Key`
      );
    } else {
      // Verify Digest Object
      let verify;

      switch (this.type) {
        case "rsa":
          //if (this.rsa) return this.rsa.verify(data, signature, "utf8", encoding);
          throw ActiveLogger.fatal(data, `Failed to verify with RSA`);
        case "bitcoin":
        case "ethereum":
        case "secp256k1":
          verify = crypto.createVerify("SHA256");
          verify.update(data);
          return verify.verify(
            this.handler.pub.pkcs8pem,
            Buffer.from(signature, "base64")
          );
        default:
          throw ActiveLogger.fatal(data, `Cannot verify with ${this.type}`);
      }
    }
  }
}
