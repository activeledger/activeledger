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

//@ts-ignore
import * as asn1 from "asn1.js";

/**
 * Manages parsing over PEM / ASN for cyrptograhpic keys
 *
 * @export
 * @class AsnParser
 */
export class AsnParser {
  /**
   * Decode EC private key as HEX from PEM
   *
   * @static
   * @param {string} pkcs8pem
   * @param {string} [label="EC PRIVATE KEY"]
   * @returns {string}
   * @memberof AsnParser
   */
  public static decodeECPrivateKey(
    pkcs8pem: string,
    label = "EC PRIVATE KEY"
  ): string {
    return AsnParser.extractNestedKeys(
      AsnParser.ECPrivASN.decode(pkcs8pem, "pem", {
        label: label,
        partial: true
      }).result
    );
  }

  /**
   * Encode EC private key from HEX as PEM
   *
   * @static
   * @param {string} key
   * @param {string} [label="EC PRIVATE KEY"]
   * @returns {string}
   * @memberof AsnParser
   */
  public static encodeECPrivateKey(
    prv: Buffer,
    pub: Buffer,
    label = "EC PRIVATE KEY"
  ): string {
    return AsnParser.ECPrivLiteASN.encode(
      {
        version: 1,
        privateKey: prv,
        params: { type: "curve", value: [1, 3, 132, 0, 10] },
        publicKey: { unused: 0, data: pub }
      },
      "pem",
      {
        label: label,
        partial: true
      }
    );
  }

  /**
   * Decode EC public key as HEX from PEM
   *
   * @static
   * @param {string} pkcs8pem
   * @param {string} [label="PUBLIC KEY"]
   * @returns {string}
   * @memberof AsnParser
   */
  public static decodeECPublicKey(
    pkcs8pem: string,
    label = "PUBLIC KEY"
  ): string {
    return AsnParser.extractNestedKeys(
      AsnParser.ECPubASN.decode(pkcs8pem, "pem", {
        label: label,
        partial: true
      }).result,
      "publicKey"
    );
  }

  /**
   * Decode EC public key from HEX as PEM
   *
   * @static
   * @param {string} key
   * @param {string} [label="PUBLIC KEY"]
   * @returns {string}
   * @memberof AsnParser
   */
  public static encodeECPublicKey(key: Buffer, label = "PUBLIC KEY"): string {
    return AsnParser.ECPubASN.encode(
      {
        algorithm: {
          id: [1, 2, 840, 10045, 2, 1],
          curve: [1, 3, 132, 0, 10]
        },
        publicKey: {
          unused: 0,
          data: key
        }
      },
      "pem",
      {
        label: label,
        partial: true
      }
    );
  }

  /**
   * Define ASN parser for EC Private with nested format (OpenSSL Default)
   *
   * @private
   * @static
   * @memberof AsnParser
   */
  private static ECPrivASN = asn1.define("ECPrivASN", function() {
    this.seq().obj(
      // Version
      this.key("version").int(),
      // Root Key (Optional)
      this.key("privateKey")
        .octstr()
        .optional(),
      // Key Metadata (Optional)
      this.seq()
        .optional()
        .obj(),
      // OpenSSL Nested Key
      this.key("ECNested")
        .octstr()
        .optional()
        .contains(
          asn1.define("ECNested", function() {
            this.seq().obj(
              // Version
              this.key("version").int(),
              // Root Key
              this.key("privateKey").octstr()
            );
          })
        )
    );
  });

  /**
   * Save only what we need. Don't need optional nesting in our files.
   *
   * @private
   * @static
   * @memberof AsnParser
   */
  private static ECPrivLiteASN = asn1.define("ECPrivASN", function() {
    this.seq().obj(
      // Version
      this.key("version").int(),
      // Root Key (Optional)
      this.key("privateKey").octstr(),
      this.key("params")
        .optional()
        .explicit(0)
        .use(
          asn1.define("params", function() {
            this.choice({ curve: this.objid() });
          })
        ),
      this.key("public_key")
        .optional()
        .explicit(1)
        .bitstr()
    );
  });

  /**
   * Define ASN parser for EC Public Keys
   *
   * @private
   * @static
   * @memberof AsnParser
   */
  private static ECPubASN = asn1.define("ECPubASN", function() {
    this.seq().obj(
      this.key("algorithm")
        .optional()
        .seq()
        .obj(this.key("id").objid(), this.key("curve").objid()),
      this.key("publicKey").bitstr()
    );
  });

  /**
   * Extract Keys from a potential nested ASN
   *
   * @private
   * @static
   * @param {*} asn
   * @param {string} [type="privateKey"]
   * @returns {string}
   * @memberof AsnParser
   */
  private static extractNestedKeys(
    asn: any,
    type: string = "privateKey"
  ): string {
    if (asn[type]) {
      if (asn[type].data) {
        return asn[type].data.toString("hex");
      } else {
        return asn[type].toString("hex");
      }
    } else {
      if (asn.ECNested) {
        return AsnParser.extractNestedKeys(asn.ECNested, type);
      } else {
        throw new Error("PPK not found inside ASN");
      }
    }
  }
}
