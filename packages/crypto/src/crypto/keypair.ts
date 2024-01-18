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
   * Prevents webpack throwing not found, We are checking for it.
   *
   * @private
   * @memberof KeyPair
   */
  private readonly webpackBypassCheck = "generateKeyPairSync";

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
          if (pem.startsWith("0x")) {
            // Raw Hex based key
            if (
              //pem.startsWith("0x02") || // compressed y point even
              //pem.startsWith("0x03") || // compressed y point odd
              //pem.startsWith("0x04") || // Uncompressed Public key
              // Silly mistake private keys may start as 02 03 04 
              // (below 66 is to account for 0x string public keys are 64 hex privates are 64)
              pem.length > 66 // Default to uncompressed Public Key with 0x accounted for if over 66 characters long
            ) {
              // Public
              this.createHandler(
                "",
                AsnParser.encodeECPublicKey(
                  Buffer.from(pem.replace("0x", ""), "hex")
                )
              );
            } else {
              // Private
              this.createHandler(
                AsnParser.encodeECPrivateKey(
                  Buffer.from(pem.replace("0x", ""), "hex"),
                  Buffer.from("")
                ),
                ""
              );
            }
          } else {
            // Original Method
            if (pem.indexOf("PRIVATE") == -1) {
              this.createHandler("", pem);
            } else {
              this.createHandler(pem);
            }
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
        pkcs8pem: pub,
      },
      prv: {
        pkcs8pem: prv,
      },
    };
  }

  /**
   * Parse PEM again to convert format
   *
   * @private
   * @returns {boolean}
   * @memberof KeyPair
   */
  private enableCompatMode(): boolean {
    if (!this.compatMode) {
      // Convert Public if available
      if (this.handler.pub.pkcs8pem) {
        if (this.handler.pub.pkcs8pem.indexOf("PUBLIC-") !== -1) {
          // Key should be PEM style with RAW value.
          // Remove Header & Footer & New Lines
          let pem = this.handler.pub.pkcs8pem.replace(/-*[A-Z ]*-|\n/g, "");

          // Convert to HEX from base64
          pem = Buffer.from(pem, "base64").toString();

          // Encode into valid PEM
          this.handler.pub.pkcs8pem = AsnParser.encodeECPublicKey(
            Buffer.from(pem, "hex")
          );
        }
      }

      // Convert Private if available
      if (this.handler.prv.pkcs8pem) {
        // Backwards compatibility mode (NO ASN PEM)
        if (this.handler.prv.pkcs8pem.indexOf("PRIVATE-") !== -1) {
          // Key should be PEM style with RAW value.
          // Remove Header & Footer & New Lines
          let pem = this.handler.prv.pkcs8pem.replace(/-*[A-Z ]*-|\n/g, "");

          // Convert to HEX from base64
          pem = Buffer.from(pem, "base64").toString();

          // Encode into valid PEM
          this.handler.prv.pkcs8pem = AsnParser.encodeECPrivateKey(
            Buffer.from(pem, "hex"),
            Buffer.from("")
          );
        } else {
          // Decode Nested Parser into unnested valid PEM
          this.handler.prv.pkcs8pem = AsnParser.encodeECPrivateKey(
            Buffer.from(
              AsnParser.decodeECPrivateKey(this.handler.prv.pkcs8pem),
              "hex"
            ),
            Buffer.from("")
          );
        }
      }

      // Return from conversion
      this.compatMode = true;
      return true;
    }
    return false;
  }

  /**
   * Node or Webpack Environment
   *
   * @private
   * @returns {boolean}
   * @memberof KeyPair
   */
  private isFullNodeEnv(): boolean {
    return typeof crypto[this.webpackBypassCheck] === "function" ? true : false;
  }

  /**
   * Makes sure the data is a string
   *
   * @private
   * @param {string} data
   * @returns {string}
   * @memberof KeyPair
   */
  private getString(data: string): string;
  private getString(data: Object): string;
  private getString(data: Buffer): string;
  private getString(data: any): any {
    // Data Object to string
    if (typeof data === "object") {
      data = JSON.stringify(data);
    } else if (Buffer.isBuffer(data)) {
      data = data.toString();
    }
    return data;
  }

  /**
   * Reduce string size for concated encryption
   *
   * @private
   * @param {string} data
   * @param {number} [size=100]
   * @returns {string[]}
   * @memberof KeyPair
   */
  private chunkString(data: string, size: number = 100): string[] {
    let chunks = [];
    if (data.length > size) {
      chunks = [];
      while (data !== "") {
        chunks.push(data.slice(0, size));
        data = data.slice(size);
      }
    } else {
      chunks.push(data);
    }
    return chunks;
  }

  /**
   * Generate Key Pair
   *
   * @param {number} [bits=2048]
   * @param {boolean} [pem] ASN encoded PEM or HEX (EC Only)
   * @param {boolean} [compressed] return compressed public key (EC Only)
   * @returns {KeyHandler}
   * @memberof KeyPair
   */
  public generate(
    bits: number = 2048,
    pem?: boolean,
    compressed?: boolean
  ): KeyHandler {
    switch (this.type) {
      case "rsa":
        // Node or Browser (Webpack doesn't have this yet)
        if (!this.isFullNodeEnv()) {
          // Temp Import Pure JS RSA Lib to generate
          // TODO : Use This lib for sign/verify/enc/dec if not in node or webpack shims
          let jsRSA = require("node-rsa");
          let rsa = new jsRSA({ b: bits });

          // Create Return Object
          this.createHandler(
            rsa.exportKey("pkcs8-private-pem").toString(),
            rsa.exportKey("pkcs8-public-pem").toString()
          );
        } else {
          let rsa = crypto[this.webpackBypassCheck]("rsa", {
            modulusLength: bits,
            publicKeyEncoding: {
              type: "spki",
              format: "pem",
            },
            privateKeyEncoding: {
              type: "pkcs8",
              format: "pem",
            },
          });

          // Create Return Object
          this.createHandler(rsa.privateKey, rsa.publicKey);
        }

        // Update Hashes
        this.handler.pub.hash = Hash.getHash(this.handler.pub.pkcs8pem);
        this.handler.prv.hash = Hash.getHash(this.handler.prv.pkcs8pem);

        return this.handler;
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        let curve: crypto.ECDH = crypto.createECDH("secp256k1");
        curve.generateKeys();

        if (pem) {
          // Create Return Object
          this.createHandler(
            AsnParser.encodeECPrivateKey(
              curve.getPrivateKey(),
              curve.getPublicKey()
            ),
            AsnParser.encodeECPublicKey(curve.getPublicKey())
          );
        } else {
          this.createHandler(
            "0x" + curve.getPrivateKey().toString("hex"),
            compressed
              ? "0x" + curve.getPublicKey("hex", "compressed")
              : "0x" + curve.getPublicKey("hex", "uncompressed")
          );
        }

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
    if (this.type == "rsa") {
      // Check we have public
      if (!this.handler.pub.pkcs8pem) {
        throw ActiveLogger.fatal(
          data,
          `Cannot encrypt without ${this.type} Public Key`
        );
      } else {
        // Get data as string
        data = this.getString(data);

        // Split data
        let chunked = this.chunkString(data);

        // Concated Encrypted string
        let encrypted = "";

        chunked.forEach((chunk: string) => {
          // Get Encryption Chunk
          encrypted +=
            crypto
              .publicEncrypt(this.handler.pub.pkcs8pem, Buffer.from(chunk))
              .toString(encoding) + "|";
        });

        return encrypted.slice(0, -1);
      }
    }
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
    if (this.type == "rsa") {
      // Check we have public
      if (!this.handler.prv.pkcs8pem) {
        throw ActiveLogger.fatal(
          data,
          `Cannot decrypt without ${this.type} Private Key`
        );
      } else {
        // Get data as string
        let chunked = this.getString(data).split("|");

        // Concated decrypted string
        let decrypted = "";

        // Loop and decrypt
        chunked.forEach((chunk) => {
          decrypted += crypto
            .privateDecrypt(
              this.handler.prv.pkcs8pem,
              Buffer.from(chunk, encoding)
            )
            .toString();
        });
        return Buffer.from(decrypted).toString(encoding);
      }
    }
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

    // Data Object to string
    data = this.getString(data);

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
          sign = crypto.createSign("sha256");
          sign.update(data);
          return new Buffer(
            sign.sign(this.handler.prv.pkcs8pem, "hex"),
            "hex"
          ).toString(encoding);
        } catch {
          if (this.enableCompatMode()) {
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

      // Data Object to string
      data = this.getString(data);

      switch (this.type) {
        case "rsa":
          verify = crypto.createVerify("RSA-SHA256");
          verify.update(data);
          return verify.verify(
            this.handler.pub.pkcs8pem,
            Buffer.from(signature, encoding)
          );
        case "bitcoin":
        case "ethereum":
        case "secp256k1":
          try {
            verify = crypto.createVerify("sha256");
            verify.update(data);
            return verify.verify(
              this.handler.pub.pkcs8pem,
              Buffer.from(signature, encoding)
            );
          } catch {
            if (this.enableCompatMode()) {
              return this.verify(data, signature);
            } else {
              throw ActiveLogger.fatal(
                data,
                `Cannot verify with ${this.type} supplied PEM`
              );
            }
          }
        default:
          throw ActiveLogger.fatal(data, `Cannot verify with ${this.type}`);
      }
    }
  }
}
