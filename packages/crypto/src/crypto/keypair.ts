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
  /**
   * Lazily-calculated hash of the PEM.
   *
   * @type {string}
   */
  readonly hash?: string;
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
   */
  private handler: KeyHandler;

  /**
   * EC Key been passed for compaitibility
   *
   * @private
   */
  private compatMode = false;

  /**
   * Prevents webpack throwing not found, We are checking for it.
   *
   * @private
   */
  private readonly webpackBypassCheck = "generateKeyPairSync";

  /**
   * Cached parsed public KeyObject for verify(), keyed by the pem it was
   * parsed from. Avoids re-parsing the same PEM/DER on every verify call.
   *
   * @private
   */
  private cachedVerifyKey?: { pem: string; key: crypto.KeyObject };

  /**
   * Creates an instance of KeyPair.
   * @param {*} [type="rsa"]
   * @param {*} [pem]
   */
  constructor(type?: string);
  constructor(type?: string, pem?: string);
  constructor(private type: string = "rsa", public pem?: string) {
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
              //pem.startsWith("0x04") || // Uncompressed Public key // Silly mistake private keys may start as 02 03 04
              // (below 66 is to account for 0x string public keys are 64 hex privates are 64)
              // Heuristic to differentiate public vs private hex keys.
              // Private keys are 32 bytes (64 hex chars + '0x' = 66). Public keys are longer.
              pem.length > 66
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
   */
  private createHandler(prv: string, pub: string = ""): void {
    this.handler = {
      get pub() {
        return {
          pkcs8pem: pub,
          get hash() {
            return Hash.getHash(pub);
          },
        };
      },
      get prv() {
        return {
          pkcs8pem: prv,
          get hash() {
            return Hash.getHash(prv);
          },
        };
      },
    };
  }

  /**
   * Parse PEM again to convert format
   *
   * @private
   * @returns {boolean}
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
   */
  private getString(data: string): string;
  private getString(data: Object): string;
  private getString(data: Buffer): string;
  private getString(data: string | Object | Buffer): string {
    // Data Object to string
    if (Buffer.isBuffer(data)) return data.toString();
    if (typeof data === "object") {
      return JSON.stringify(data);
    }
    return data as string;
  }

  /**
   * Reduce string size for concated encryption
   *
   * @private
   * @param {string} data
   * @param {number} [size=100]
   * @returns {string[]}
   */
  private chunkString(data: string, size: number = 100): string[] {
    if (data.length <= size) {
      return [data];
    }
    const numChunks = Math.ceil(data.length / size);
    const chunks = new Array(numChunks);
    for (let i = 0, o = 0; i < numChunks; ++i, o += size) {
      chunks[i] = data.substr(o, size);
    }
    return chunks;
  }

  /**
   * Left-pad a big-endian scalar to a fixed byte length. node:crypto's
   * ECDH.getPrivateKey() returns the minimal-length encoding (leading zero
   * bytes stripped), not a fixed-width one.
   *
   * @private
   * @param {Buffer} key
   * @param {number} [length=32] secp256k1's field size in bytes
   * @returns {Buffer}
   */
  private padPrivateKey(key: Buffer, length: number = 32): Buffer {
    if (key.length === length) {
      return key;
    }
    const padded = Buffer.alloc(length);
    key.copy(padded, length - key.length);
    return padded;
  }

  /**
   * Generate Key Pair
   *
   * @param {number} [bits=2048]
   * @param {boolean} [pem] ASN encoded PEM or HEX (EC Only)
   * @param {boolean} [compressed] return compressed public key (EC Only)
   * @returns {KeyHandler}
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

        return this.handler;
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        let curve: crypto.ECDH = crypto.createECDH("secp256k1");
        curve.generateKeys();

        // ECDH.getPrivateKey() strips leading zero bytes instead of
        // returning a fixed-width 32-byte scalar (about 1 in 400 keys hit
        // this) - left-pad back to 32 bytes, or a short-by-chance key
        // silently produces a non-standard-length SEC1 private key field
        // that other, stricter parsers (other-language SDKs, etc.) may not
        // accept.
        const privateKey = this.padPrivateKey(curve.getPrivateKey());

        if (pem) {
          // Create Return Object
          this.createHandler(
            AsnParser.encodeECPrivateKey(privateKey, curve.getPublicKey()),
            AsnParser.encodeECPublicKey(curve.getPublicKey())
          );
        } else {
          this.createHandler(
            "0x" + privateKey.toString("hex"),
            compressed
              ? "0x" + curve.getPublicKey("hex", "compressed")
              : "0x" + curve.getPublicKey("hex", "uncompressed")
          );
        }

        return this.handler;
      default:
        throw ActiveLogger.fatal(`Cannot generate ${this.type} key pair type`);
    }
  }

  /**
   * Encrypt
   *
   * @param {*} rawData
   * @param {*} [encoding="base64"]
   * @returns {string}
   */
  public encrypt(rawData: string): string;
  public encrypt(rawData: Object): string;
  public encrypt(rawData: Buffer): string;
  public encrypt(
    rawData: string | Object | Buffer,
    encoding: any = "base64"
  ): string {
    // Data Object to string
    const data = this.getString(rawData);

    if (this.type == "rsa") {
      // Check we have public
      if (!this.handler.pub.pkcs8pem) {
        throw ActiveLogger.fatal(
          data,
          `Cannot encrypt without ${this.type} Public Key`
        );
      } else {
        // Split data
        let chunked = this.chunkString(this.getString(data));
        return chunked
          .map((chunk) =>
            crypto
              .publicEncrypt(this.handler.pub.pkcs8pem, Buffer.from(chunk))
              .toString(encoding)
          )
          .join("|");
      }
    }
    throw ActiveLogger.fatal(data, `Cannot encrypt with ${this.type}`);
  }

  /**
   * Decrypt
   *
   * @param {*} rawData
   * @param {*} [encoding="base64"]
   * @returns {string}
   */
  public decrypt(rawData: string): string;
  public decrypt(rawData: Object): string;
  public decrypt(rawData: Buffer): string;
  public decrypt(
    rawData: string | Object | Buffer,
    encoding: any = "base64"
  ): string {
    // Data Object to string
    const data = this.getString(rawData);

    if (this.type == "rsa") {
      // Check we have public
      if (!this.handler.prv.pkcs8pem) {
        throw ActiveLogger.fatal(
          data,
          `Cannot decrypt without ${this.type} Private Key`
        );
      } else {
        // Get data as string
        let chunked = data.split("|");
        const decrypted = chunked
          .map((chunk) =>
            crypto
              .privateDecrypt(
                this.handler.prv.pkcs8pem,
                Buffer.from(chunk, encoding)
              )
          )
          .join("");
        return decrypted;
      }
    }
    throw ActiveLogger.fatal(data, `Cannot decrypt with ${this.type}`);
  }

  /**
   * Sign
   *
   * @param {*} rawData
   * @param {*} [encoding="base64"]
   * @returns {string}
   */
  public sign(rawData: string): string;
  public sign(rawData: Object): string;
  public sign(rawData: Buffer): string;
  public sign(
    rawData: string | Object | Buffer,
    encoding: any = "base64"
  ): string {
    // Data Object to string
    const data = this.getString(rawData);

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
        return Buffer.from(
          sign.sign(this.handler.prv.pkcs8pem, "hex"),
          "hex"
        ).toString(encoding);
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        try {
          sign = crypto.createSign("sha256");
          sign.update(data);
          return Buffer.from(
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
   * Returns a parsed public KeyObject for verify(), reusing the cached
   * one when the underlying pem hasn't changed.
   *
   * @private
   */
  private getVerifyKeyObject(): crypto.KeyObject {
    const pem = this.handler.pub.pkcs8pem;
    if (!this.cachedVerifyKey || this.cachedVerifyKey.pem !== pem) {
      this.cachedVerifyKey = { pem, key: crypto.createPublicKey(pem) };
    }
    return this.cachedVerifyKey.key;
  }

  /**
   * Verify
   *
   * @param {*} data
   * @param {*} [encoding="base64"]
   * @returns {string}
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

      // Parsing the PEM/DER into a KeyObject is the expensive part of
      // verify() - cache it since the public key is immutable per instance.
      const pubKey = this.getVerifyKeyObject();

      switch (this.type) {
        case "rsa":
          verify = crypto.createVerify("RSA-SHA256");
          verify.update(data);
          return verify.verify(pubKey, Buffer.from(signature, encoding));
        case "bitcoin":
        case "ethereum":
        case "secp256k1":
          try {
            verify = crypto.createVerify("sha256");
            verify.update(data);
            return verify.verify(pubKey, Buffer.from(signature, encoding));
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
