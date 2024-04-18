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
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { KeyPair } from "./keypair";

/**
 * Manages secured data with role permissions
 *
 * @export
 * @class SecuredData
 */
export class Secured {
  /**
   * Create a secured password
   *
   * @private
   * @static
   * @param {string} seed
   * @param {number} [length=32]
   * @returns {string}
   */
  private static createPassword(seed: string, length = 32): string {
    let salt = crypto.randomBytes(32);
    return crypto
      .pbkdf2Sync(seed, salt, 1000, length, "sha256")
      .toString("hex");
  }

  /**
   * Basic untyped constructor for public privateresolution
   *
   * @param {ActiveDSConnect} db
   * @param {*} neighbour
   * @param {*} self
   */
  public constructor(
    private db: ActiveDefinitions.IActiveDSConnect,
    private neighbour: any,
    private self: any
  ) {}

  /**
   * Encryption Routine
   *
   * @private
   * @param {string} password
   * @param {string} data
   * @returns {Promise<string>}
   */
  private cipherEncrypt(password: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Get IV
      let iv = crypto.randomBytes(16);

      // Get Salt
      let salt = crypto.randomBytes(64);

      // Get Key with high itterations
      var key = crypto.pbkdf2Sync(password, salt, 10000, 32, "sha512");

      // Get Cipher Object
      var cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

      // Hold Encrypted Chunks
      var encrypted = Buffer.concat([
        cipher.update(data, "utf8"),
        cipher.final()
      ]);

      // extract the auth tag
      var tag = cipher.getAuthTag();

      // generate output
      resolve(Buffer.concat([salt, iv, tag, encrypted]).toString("base64"));
    });
  }

  private cipherDecrypt(password: string, data: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // base64 decoding
      var bData = Buffer.from(data, "base64");

      // convert data to buffers
      let salt = bData.slice(0, 64);
      let iv = bData.slice(64, 80);
      let tag = bData.slice(80, 96);
      let text = bData.slice(96);

      // Get Key
      var key = crypto.pbkdf2Sync(password, salt, 10000, 32, "sha512");

      // Get Cipher Object
      var decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      // Get Decryption
      // resolve(decipher.update(text, "binary", "utf8") + decipher.final("utf8"));
      resolve(decipher.update(text, undefined, "utf8") + decipher.final("utf8"));
    });
  }

  /**
   * Loop over nested objects to see nested encryption rules
   *
   * @private
   * @param {*} data
   * @param {*} passwords
   * @returns {Promise<ISecuredData>}
   */
  private deepMapEncrypt(data: any, passwords: any): Promise<ISecuredData> {
    return new Promise(async (resolve, reject) => {
      // Out Object
      let out: any = {};

      // Loop all props
      let keys = Object.keys(data);
      let i = keys.length;

      while (i--) {
        let property = keys[i];
        let value = data[property];

        // Is the value, not empty and an object
        if (value !== null && typeof value === "object") {
          // Process Nested Encryptions first
          let nested = await this.deepMapEncrypt(
            value as ISecuredData,
            passwords
          );

          // Do we need to encrypt the result (Make sure it hasn't been encrypted)
          if (nested.$ADAR && passwords[nested.$ADAR] && !nested.$ADENC) {
            let eData = await this.cipherEncrypt(
              passwords[nested.$ADAR],
              JSON.stringify(nested)
            );

            // Update Object
            out[property] = {
              $ADENC: eData,
              $ADAR: nested.$ADAR
            };
          } else {
            out[property] = nested;
          }
        } else {
          // Assign to output
          out[property] = value;
        }
      }

      // Do we need to encrypt the root?
      if (out.$ADAR && passwords[out.$ADAR]) {
        let oData = await this.cipherEncrypt(
          passwords[out.$ADAR],
          JSON.stringify(out)
        );
        resolve({
          $ADENC: oData,
          $ADAR: out.$ADAR
        });
      } else {
        // Finished encryption loop
        resolve(out);
      }
    });
  }

  /**
   * Loop over nested objects to see nested decryption
   *
   * @private
   * @param {ISecuredData} data
   * @param {*} passwords
   * @returns {Promise<ISecuredData>}
   */
  private deepMapDecrypt(
    data: ISecuredData,
    passwords: any
  ): Promise<ISecuredData> {
    return new Promise(async (resolve, reject) => {
      // Out Object
      let out: ISecuredData = data;

      // Do we need to decrypt the root?
      if (data.$ADENC && data.$ADAR && passwords[data.$ADAR]) {
        // Open "decrypted" data
        out = JSON.parse(
          await this.cipherDecrypt(passwords[data.$ADAR], data.$ADENC)
        );
      }

      // Loop all other props
      let keys = Object.keys(out);
      let i = keys.length;

      while (i--) {
        let property = keys[i];
        let value = out[property];

        // Is the value, not empty and an object
        if (value !== null && typeof value === "object") {
          // Update Object (Why is twice needed?)
          out[property] = await this.deepMapDecrypt(
            value as ISecuredData,
            passwords
          );
        }
      }

      resolve(out);
    });
  }

  /**
   * Encrypt data object with permissioned roles
   *
   * @param {ISecured} packet
   * @returns {Promise<{}>}
   */
  public encrypt(packet: ISecured): Promise<{}> {
    return new Promise(async (resolve, reject) => {
      // Hold Password data for targetted encryption to node
      let passwords: any = {};

      // Return object if no root ADAC (Activeledger Data Access Controller)
      if (!packet.$ADAC) {
        resolve(packet);
      }

      // Loop ADAC to create role passwords
      let i = packet.$ADAC.length;
      while (i--) {
        // Temp roles rewrite
        let tmpRoles: any = {};

        // Loop Roles
        let roles = packet.$ADAC[i].roles as string[];
        let ii = roles.length;
        while (ii--) {
          // Get Role
          let role = roles[ii];
          // Do we have a password for this roll
          if (!passwords[role]) {
            // Create Password
            passwords[role] = Secured.createPassword(Date.now().toString());

            // Assign
            tmpRoles[role] = passwords[role];
          }
        }

        // Temporary storage of public rsa key
        let pubRSA = "";

        // Now to secure these role passwords
        switch (packet.$ADAC[i].type) {
          case ADACType.Node:
            // Check self first (As Pem will be private)
            if (packet.$ADAC[i].ref === this.self.reference) {
              pubRSA = this.self.public;
            } else {
              // Look up other nodes
              if (this.neighbour[packet.$ADAC[i].ref]) {
                pubRSA = this.neighbour[packet.$ADAC[i].ref].identity.pem;
              } else {
                return reject("Unknown Neighbour : " + packet.$ADAC[i].ref);
              }
            }
            break;
          case ADACType.Stream:
            try {
              pubRSA = (await this.db.get(packet.$ADAC[i].ref + ":stream"))
                .public;
            } catch (e) {
              return reject("Unknown Stream : " + packet.$ADAC[i].ref);
            }
            break;
          case ADACType.PubKey:
            pubRSA = packet.$ADAC[i].ref;
            break;
          default:
            return reject("Unknown $ADAC type");
        }

        // Ovewrite Roles with encrypted
        packet.$ADAC[i].roles = new KeyPair("rsa", pubRSA).encrypt(tmpRoles);
      }

      // Encrypt the Data
      this.deepMapEncrypt(packet.data, passwords)
        .then(result => {
          packet.data = result;
          resolve(packet);
        })
        .catch(reject);
    });
  }

  /**
   * Decrypt data object with permissioned roles
   *
   * @param {ISecuredData} packet
   * @returns {Promise<{}>}
   */
  public decrypt(packet: ISecuredData): Promise<{}> {
    return new Promise((resolve, reject) => {
      // Hold Password data for targetted encryption to node
      let passwords: any = {};

      // Return object if no root ADAC (Activeledger Data Access Controller)
      if (packet.$ADAC) {
        // Loop ADAC to create role passwords
        let i = packet.$ADAC.length;
        while (i--) {
          let tmpP = "";

          // Fetch Passwords from roles
          switch (packet.$ADAC[i].type) {
            case ADACType.Node:
              // Can only decrypt self
              if (packet.$ADAC[i].ref === this.self.reference) {
                tmpP = new KeyPair("rsa", this.self.private).decrypt(
                  packet.$ADAC[i].roles
                );
              }
              break;
            case ADACType.Stream:
            case ADACType.PubKey:
              // Cannot Decrypt streams
              // Cannot Decrypt passed public
              break;
            default:
              return reject("Unknown $ADAC type");
          }

          if (tmpP) {
            // Remove base64 (Weirdly TS cannot see 2nd argument)
            tmpP = JSON.parse(Buffer.from(tmpP, "base64").toString("utf8"));

            // Loop Object with roles
            let roleKeys = Object.keys(tmpP);
            let ii = roleKeys.length;
            while (ii--) {
              if (!passwords[roleKeys[ii]]) {
                passwords[roleKeys[ii]] = tmpP[roleKeys[ii] as any];
              }
            }
          }
        }
      } else {
        resolve(packet);
      }

      // Encrypt the Data
      this.deepMapDecrypt(packet.data as ISecuredData, passwords)
        .then(result => {
          packet.data = result;
          resolve(packet);
        })
        .catch(reject);
    });
  }
}

/**
 * Data interface to be encrypted
 *
 * @export
 * @interface ISecured
 */
export interface ISecured {
  $ADAC: I$ADAC[];
  data: ISecuredData;
}

/**
 * Activeledger Data Access Controller
 *
 * @export
 * @interface I$ADAC
 */
export interface I$ADAC {
  ref: string;
  type: ADACType;
  roles: string[] | string;
}

/**
 * Returned encrypted data object
 *
 * @export
 * @interface ISecuredData
 */
export interface ISecuredData {
  $ADAC?: I$ADAC[];
  $ADAR?: string;
  $ADENC?: string;
  [reference: string]: unknown | ISecuredData;
}

/**
 * Encryption Reference Types
 *
 * @export
 * @enum {number}
 */
export enum ADACType {
  Node = "node",
  Stream = "stream",
  PubKey = "pubkey"
}
