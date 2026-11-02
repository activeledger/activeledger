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
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { falcon512 } from "@noble/post-quantum/falcon.js";
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
/**
 * The post-quantum signature schemes, by the type string that goes into a
 * stream's `meta.authorities[].type`.
 *
 * Named for their parameter sets rather than shortened, because that string
 * is written into ledger metadata once and read for the life of the identity
 * - "ml-dsa" without the 65 would be ambiguous the moment a second parameter
 * set is wanted, and nothing can rewrite it afterwards.
 *
 * ML-DSA-65 is FIPS 204, the conservative choice. Falcon-512 is FN-DSA,
 * still a draft standard, and earns its place on size: 653 byte signatures
 * against ML-DSA-65's 3309, which matters because every signature is
 * broadcast to every node and then stored for good.
 *
 * Both come from @noble/post-quantum - pure JavaScript, no native binding,
 * so the same code runs in a node, in the SDK and in a React Native client.
 */
const POST_QUANTUM: {
  [type: string]: {
    keygen: (seed: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
    sign: (
      msg: Uint8Array,
      secretKey: Uint8Array,
      opts?: { extraEntropy?: Uint8Array | false }
    ) => Uint8Array;
    verify: (sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array) => boolean;
    // Deliberately no `signature` here. ML-DSA's is fixed at 3309 bytes, but
    // Falcon's varies with the signature it produces - 649 to 662 bytes over
    // 300 samples - and noble does not declare one for it at all. Nothing
    // here needs it, and declaring it would assert a fact that is false for
    // half the table.
    lengths: { publicKey: number; secretKey: number; seed: number };
  };
} = {
  "ml-dsa-65": ml_dsa65 as any,
  "falcon-512": falcon512 as any,
};

/**
 * Order of the secp256k1 group: valid private scalars are 1 to this minus 1.
 */
const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);

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
      // Post-quantum keys are raw bytes, not PEM. Which of the pair this is
      // can be read off its length - the parameter sets fix both, and they
      // never collide - so a caller does not have to say, exactly as the
      // hex branch below infers it for secp256k1.
      const pq = POST_QUANTUM[type];
      if (pq) {
        const raw = Buffer.from(pem, "base64");
        if (raw.length === pq.lengths.publicKey) {
          this.createHandler("", pem);
        } else if (raw.length === pq.lengths.secretKey) {
          this.createHandler(pem, "");
        } else {
          throw ActiveLogger.fatal(
            `${type} key is ${raw.length} bytes, expected ${pq.lengths.publicKey} (public) or ${pq.lengths.secretKey} (private)`
          );
        }
        return;
      }
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
                  this.hexToKey(pem.slice(2), false)
                )
              );
            } else {
              // Private
              this.createHandler(
                AsnParser.encodeECPrivateKey(
                  this.hexToKey(pem.slice(2), true),
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
    this.handler = this.makeHandler(prv, pub);
  }

  /**
   * Builds a key handler without assigning it to this instance
   *
   * @private
   * @param {string} prv
   * @param {string} [pub=""]
   * @returns {KeyHandler}
   */
  private makeHandler(prv: string, pub: string = ""): KeyHandler {
    return {
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
   * Hex key text to bytes. Buffer.from(hex, "hex") stops at the first
   * character that is not hex without complaint, so a typo, an odd digit or
   * trailing junk would silently become a different key - an empty one at
   * worst, which node signs with. And a private scalar of 0, or at or above
   * the group order, is not a private key at all. Refuse both.
   *
   * @private
   * @param {string} hex Without any 0x prefix
   * @param {boolean} scalar A private key, so range checked
   * @returns {Buffer}
   */
  private hexToKey(hex: string, scalar: boolean): Buffer {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
      throw ActiveLogger.fatal(
        `Invalid ${this.type} key: expected whole bytes of hex`
      );
    }
    if (scalar) {
      const value = BigInt("0x" + hex);
      if (value < BigInt(1) || value >= SECP256K1_ORDER) {
        throw ActiveLogger.fatal(
          `Invalid ${this.type} private key: out of range for secp256k1`
        );
      }
    }
    return Buffer.from(hex, "hex");
  }

  /**
   * Parse PEM again to convert format
   *
   * @private
   * @returns {boolean}
   */
  private enableCompatMode(): boolean {
    if (!this.compatMode) {
      // handler.pub / handler.prv are getters that return a fresh object on
      // every read, so assigning to their pkcs8pem changes nothing. Convert
      // into locals and rebuild the handler at the end.
      let pub = this.handler.pub.pkcs8pem;
      let prv = this.handler.prv.pkcs8pem;

      // Convert Public if available
      if (pub) {
        if (pub.indexOf("PUBLIC-") !== -1) {
          // Key should be PEM style with RAW value.
          // Remove Header & Footer & New Lines
          let pem = pub.replace(/-*[A-Z ]*-|\n/g, "");

          // Convert to HEX from base64
          pem = Buffer.from(pem, "base64").toString();

          // Encode into valid PEM
          pub = AsnParser.encodeECPublicKey(this.hexToKey(pem, false));
        }
      }

      // Convert Private if available
      if (prv) {
        // Backwards compatibility mode (NO ASN PEM)
        if (prv.indexOf("PRIVATE-") !== -1) {
          // Key should be PEM style with RAW value.
          // Remove Header & Footer & New Lines
          let pem = prv.replace(/-*[A-Z ]*-|\n/g, "");

          // Convert to HEX from base64
          pem = Buffer.from(pem, "base64").toString();

          // Encode into valid PEM
          prv = AsnParser.encodeECPrivateKey(
            this.hexToKey(pem, true),
            Buffer.from("")
          );
        } else {
          // Decode Nested Parser into unnested valid PEM
          prv = AsnParser.encodeECPrivateKey(
            Buffer.from(
              AsnParser.decodeECPrivateKey(prv),
              "hex"
            ),
            Buffer.from("")
          );
        }
      }

      // Return from conversion
      this.createHandler(prv, pub);
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
   * Splits on whole characters, never inside a surrogate pair, and also caps
   * each chunk's UTF-8 size: RSA-OAEP takes only the modulus size minus 42
   * bytes a block, and 100 characters can be 400 bytes.
   *
   * @private
   * @param {string} data
   * @param {number} [size=100] Most UTF-16 units in a chunk
   * @param {number} [maxBytes=Infinity] Most UTF-8 bytes in a chunk
   * @returns {string[]}
   */
  private chunkString(
    data: string,
    size: number = 100,
    maxBytes: number = Infinity
  ): string[] {
    const chunks: string[] = [];
    let chunk = "";
    let bytes = 0;
    // Iterating a string yields code points, so a pair is never split
    for (const char of data) {
      const charBytes = Buffer.byteLength(char);
      if (
        chunk &&
        (chunk.length + char.length > size || bytes + charBytes > maxBytes)
      ) {
        chunks.push(chunk);
        chunk = "";
        bytes = 0;
      }
      chunk += char;
      bytes += charBytes;
    }
    chunks.push(chunk);
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
    const pq = POST_QUANTUM[this.type];
    if (pq) {
      const keys = pq.keygen(
        new Uint8Array(crypto.randomBytes(pq.lengths.seed))
      );
      this.createHandler(
        Buffer.from(keys.secretKey).toString("base64"),
        Buffer.from(keys.publicKey).toString("base64")
      );
      return this.handler;
    }

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

        // sign() and verify() read PEM from the instance's own handler, so
        // that is always PEM, whichever format is handed back
        this.createHandler(
          AsnParser.encodeECPrivateKey(privateKey, curve.getPublicKey()),
          AsnParser.encodeECPublicKey(curve.getPublicKey())
        );

        if (pem) {
          return this.handler;
        }

        // Raw hex keys for the caller, as the constructor accepts them. Not
        // assigned to the instance: it used to be, which left an instance
        // that could not sign or verify what it had just generated.
        return this.makeHandler(
          "0x" + privateKey.toString("hex"),
          compressed
            ? "0x" + curve.getPublicKey("hex", "compressed")
            : "0x" + curve.getPublicKey("hex", "uncompressed")
        );
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
        // OAEP (SHA-1) carries the modulus size minus 42 bytes a block
        const modulusBytes =
          (crypto.createPublicKey(this.handler.pub.pkcs8pem)
            .asymmetricKeyDetails?.modulusLength || 2048) / 8;
        let chunked = this.chunkString(
          this.getString(data),
          100,
          modulusBytes - 42
        );
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

    const pq = POST_QUANTUM[this.type];
    if (pq) {
      // Entropy is supplied rather than left to noble, which otherwise reads
      // globalThis.crypto.getRandomValues. That global is not ours to rely
      // on: the contract VM hands contracts an Activeledger `crypto` object
      // under the same name, and anything doing that process-wide - as
      // tests/contract.test.ts does - takes getRandomValues away and signing
      // fails with "crypto.getRandomValues must be defined". Passing it
      // explicitly keeps signing hedged (FIPS 204 recommends it over
      // deterministic) while depending only on node's own crypto, which is
      // already imported here.
      //
      // The length differs per scheme - 32 for ML-DSA, 48 for Falcon - and
      // both happen to equal that scheme's seed length.
      return Buffer.from(
        pq.sign(
          new Uint8Array(Buffer.from(data, "utf8")),
          new Uint8Array(Buffer.from(this.handler.prv.pkcs8pem, "base64")),
          { extraEntropy: new Uint8Array(crypto.randomBytes(pq.lengths.seed)) }
        )
      ).toString(encoding);
    }

    // Signing Digest Object
    let sign;

    // Sign by type
    switch (this.type) {
      case "rsa":
        sign = crypto.createSign("RSA-SHA256");
        sign.update(data);
        return Buffer.from(
          sign.sign(this.checkKeyType(
            crypto.createPrivateKey(this.handler.prv.pkcs8pem),
            data
          ), "hex"),
          "hex"
        ).toString(encoding);
      case "bitcoin":
      case "ethereum":
      case "secp256k1":
        let prvKey: crypto.KeyObject;
        try {
          prvKey = crypto.createPrivateKey(this.handler.prv.pkcs8pem);
        } catch {
          if (this.enableCompatMode()) {
            return (this as any).sign(data, encoding);
          } else {
            throw ActiveLogger.fatal(
              data,
              `Cannot sign with ${this.type} supplied PEM`
            );
          }
        }
        sign = crypto.createSign("sha256");
        sign.update(data);
        return Buffer.from(
          sign.sign(this.checkKeyType(prvKey, data), "hex"),
          "hex"
        ).toString(encoding);
      default:
        throw ActiveLogger.fatal(data, `Cannot sign with ${this.type}`);
    }
  }

  /**
   * The type string travels with the transaction and picks the algorithm,
   * but node will verify an ECDSA signature against any EC key and an RSA one
   * against any RSA key whatever was declared - so a P-256 or RSA key would
   * pass as secp256k1, and an EC key as "rsa". Refuse any key that is not of
   * the kind the declared type means.
   *
   * @private
   * @param {crypto.KeyObject} key
   * @param {string} data Logged with the failure
   * @returns {crypto.KeyObject} The same key
   */
  private checkKeyType(key: crypto.KeyObject, data: string): crypto.KeyObject {
    const found = key.asymmetricKeyType === "ec"
      ? `ec ${key.asymmetricKeyDetails?.namedCurve}`
      : key.asymmetricKeyType;
    const expected = this.type === "rsa" ? "rsa" : "ec secp256k1";
    if (found !== expected) {
      throw ActiveLogger.fatal(
        data,
        `Cannot use a ${found} key as ${this.type}, expected ${expected}`
      );
    }
    return key;
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
    const pq = POST_QUANTUM[this.type];
    if (pq) {
      if (!this.handler.pub.pkcs8pem) {
        throw ActiveLogger.fatal(
          data,
          `Cannot verify with ${this.type} Private Key`
        );
      }
      // Deliberately never throws on malformed input. A bad signature and a
      // signature of the wrong length mean the same thing to a caller -
      // this signature is not valid - and shared.signatureCheck() treats a
      // throw as a check failure anyway, so raising would only turn a clean
      // false into a logged error on every junk signature.
      try {
        return pq.verify(
          new Uint8Array(Buffer.from(signature, encoding)),
          new Uint8Array(Buffer.from(this.getString(data), "utf8")),
          new Uint8Array(Buffer.from(this.handler.pub.pkcs8pem, "base64"))
        );
      } catch {
        return false;
      }
    }

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
          // Parsing the PEM/DER into a KeyObject is the expensive part of
          // verify() - getVerifyKeyObject() caches it, the public key being
          // immutable per instance.
          return verify.verify(
            this.checkKeyType(this.getVerifyKeyObject(), data),
            Buffer.from(signature, encoding)
          );
        case "bitcoin":
        case "ethereum":
        case "secp256k1":
          let pubKey: crypto.KeyObject;
          try {
            // Parsed inside the try: a first-generation PUBLIC key is not a
            // PEM node can read until enableCompatMode() has converted it.
            pubKey = this.getVerifyKeyObject();
          } catch {
            if (this.enableCompatMode()) {
              return (this as any).verify(data, signature, encoding);
            } else {
              throw ActiveLogger.fatal(
                data,
                `Cannot verify with ${this.type} supplied PEM`
              );
            }
          }
          verify = crypto.createVerify("sha256");
          verify.update(data);
          return verify.verify(
            this.checkKeyType(pubKey, data),
            Buffer.from(signature, encoding)
          );
        default:
          throw ActiveLogger.fatal(data, `Cannot verify with ${this.type}`);
      }
    }
  }
}
