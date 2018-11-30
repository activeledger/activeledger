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
import { KeyPair } from "./keypair";

/**
 *
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
   * @memberof SecuredData
   */
  private static createPassword(seed: string, length = 32): string {
    let salt = crypto.randomBytes(32);
    return crypto
      .pbkdf2Sync(seed, salt, 10000, length, "sha256")
      .toString("hex");
  }

  private deepMapEncrypt(data: any, passwords: any): Promise<ISecuredData> {
    return new Promise(async (resolve, reject) => {
      // Out Object
      let out: any = {};

      // Loop all props
      let keys = Object.keys(data);
      let i = keys.length;

      while (i--) {
        // Is the value, not empty and an object
        if (data[keys[i]] !== null && typeof data[keys[i]] === "object") {
          // Process Nested Encryptions first
          let nestedData = await this.deepMapEncrypt(
            data[keys[i]] as ISecuredData,
            passwords
          );

          // Do we need to encrypt the result
          if (nestedData.$ADAR && passwords[nestedData.$ADAR]) {
            // Convert object to string for encryption
            let cipher = crypto.createCipheriv(
              "aes-256-gcm",
              nestedData.$ADAR,
              Date.now.toString()
            );
            let encrypted = "";

            //
            cipher.setEncoding("bas64");

            cipher.on("readable", () => {
              encrypted += cipher.read();
            });

            cipher.on("end", () => {
              cipher.removeAllListeners();

              // Assign to Output
              out[keys[i]] = {
                $ADENC: encrypted,
                $ADAR: nestedData.$ACLR
              };

              resolve(out);
            });
          }
        } else {
          // Assign to output
          out[keys[i]] = data[keys[i]];
        }
      }

      // Finished encryption loop
      resolve(out);
    });
  }

  public encrypt(packet: ISecured): Promise<{}> {
    return new Promise((resolve, reject) => {
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

        let pubRSA = "";

        // Now to secure these role passwords
        switch (packet.$ADAC[i].type) {
          case ADACType.Node:
            pubRSA = "d";
            break;
          case ADACType.Stream:
            pubRSA = "d";
            break;
          default:
            return reject("Unknown $ADAC type");
        }

        // Ovewrite Roles with encrypted
        packet.$ADAC[i].roles = new KeyPair("rsa", pubRSA).encrypt(
          packet.$ADAC[i].roles
        );
      }

      // Encrypt the Data
      this.deepMapEncrypt(packet.data, passwords);
    });
  }
}

export interface ISecured {
  $ADAC: I$ADAC[];
  data: ISecuredData;
}

export interface I$ADAC {
  ref: string;
  type: ADACType;
  roles: string[] | string;
}

export interface ISecuredData {
  $ADAR?: string;
  [reference: string]: unknown | ISecuredData;
}

export enum ADACType {
  Node,
  Stream
}
