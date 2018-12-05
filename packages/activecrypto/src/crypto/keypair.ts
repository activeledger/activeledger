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

import * as NodeRsa from "node-rsa";
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
  hash: string;
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
  private rsa: NodeRsa;

  /**
   * Holds Curve Object
   *
   * @private
   * @type {*}
   * @memberof KeyPair
   */
  private curve: any;

  /**
   * Holds Curve Key Object
   *
   * @private
   * @type {*}
   * @memberof KeyPair
   */
  private key: any;

  /**
   * Creates an instance of KeyPair.
   * @param {*} [type="rsa"]
   * @param {*} [pem]
   * @memberof KeyPair
   */
  constructor(type?: string);
  constructor(type?: string, pem?: string);
  constructor(private type: any = "rsa", public pem?: any) {
    switch (type) {
      case "rsa":
        if (pem) this.rsa = new NodeRsa(pem);
        break;
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        // Get Curve
        this.curve = new (require("elliptic")).ec("secp256k1");

        if (pem) {
          // Backwards compatibility mode (NO ASN PEM)
          if (pem.indexOf("PRIVATE-") !== -1 || pem.indexOf("PUBLIC-") !== -1) {

            // Learn if its private
            let isPriv = false;
            if (pem.indexOf("PRIVATE") !== -1) {
              isPriv = true;
            }

            // Key should be PEM style with RAW value.
            // Remove Header & Footer & New Lines
            pem = pem.replace(/-*[A-Z ]*-|\n/g, "");

            // Convert to HEX from base64
            pem = Buffer.from(pem, "base64").toString();

            // Private or Public key being imported?
            if (!isPriv) {
              this.key = this.curve.keyFromPublic(
                pem,
                "hex"
              );
            } else {
              this.key = this.curve.keyFromPrivate(
                pem,
                "hex"
              );
            }
          } else {
            // Private or Public key being imported?
            if (pem.indexOf("PRIVATE") == -1) {
              this.key = this.curve.keyFromPublic(
                AsnParser.decodeECPublicKey(pem),
                "hex"
              );
            } else {
              this.key = this.curve.keyFromPrivate(
                AsnParser.decodeECPrivateKey(pem),
                "hex"
              );
            }
          }
        }
        break;
      default:
        throw "Unknown / unset key type";
    }
  }

  /**
   * Generate Key Pair
   *
   * @param {number} [bits=2048]
   * @returns {KeyHandler}
   * @memberof KeyPair
   */
  public generate(bits: number = 2048): KeyHandler {
    // Return Object
    let handler: KeyHandler;

    switch (this.type) {
      case "rsa":
        this.rsa = new NodeRsa({ b: bits });

        // Create Return Object
        handler = {
          pub: {
            pkcs8pem: this.rsa.exportKey("pkcs8-public-pem").toString(),
            hash: ""
          },
          prv: {
            pkcs8pem: this.rsa.exportKey("pkcs8-private-pem").toString(),
            hash: ""
          }
        };

        // Update Hashes
        handler.pub.hash = Hash.getHash(handler.pub.pkcs8pem);
        handler.prv.hash = Hash.getHash(handler.prv.pkcs8pem);

        return handler;
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        this.key = this.curve.genKeyPair();

        // Create Return Object
        handler = {
          pub: {
            pkcs8pem: AsnParser.encodeECPublicKey(this.key.getPublic("hex")),
            hash: ""
          },
          prv: {
            pkcs8pem: AsnParser.encodeECPrivateKey(this.key.getPrivate("hex")),
            hash: ""
          }
        };

        // Update Hashes
        handler.pub.hash = Hash.getHash(handler.pub.pkcs8pem);
        handler.prv.hash = Hash.getHash(handler.prv.pkcs8pem);

        return handler;
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
    if (this.type == "rsa" && this.rsa) {
      return this.rsa.encrypt(data, encoding).toString();
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
    if (this.type == "rsa" && this.rsa) {
      return this.rsa.decrypt(data, encoding).toString();
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
    switch (this.type) {
      case "rsa":
        if (this.rsa && this.rsa.isPrivate()) {
          return this.rsa.sign(data, encoding).toString();
        }
        throw ActiveLogger.fatal(data, `Failed to sign`);
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        if (this.key.priv) {
          // Make sure data is string
          if (typeof data !== "string") data = JSON.stringify(data);

          // Hash Data
          data = Hash.getHash(data);

          // Parse & Hash for EC
          return new Buffer(this.key.sign(data).toDER()).toString("base64");
        }
        throw ActiveLogger.fatal(data, `Failed to sign`);
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
    switch (this.type) {
      case "rsa":
        if (this.rsa) return this.rsa.verify(data, signature, "utf8", encoding);
        throw ActiveLogger.fatal(data, `Failed to verify with RSA`);
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        // Make sure data is string
        if (typeof data !== "string") data = JSON.stringify(data);

        // Hash Data
        data = Hash.getHash(data);

        // Verify
        return this.curve.verify(
          data,
          Buffer.from(signature, "base64").toString("hex"),
          this.key.getPublic()
        );
      default:
        throw ActiveLogger.fatal(data, `Cannot verify with ${this.type}`);
    }
  }
}
