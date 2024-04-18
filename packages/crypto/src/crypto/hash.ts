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

/**
 * Easy to use Hashing functions
 *
 * @export
 * @class Hash
 */
export class Hash {
  /**
   * Get a specific hash type of string data
   *
   * @static
   * @param {string} value
   * @param {string} [algorithm="sha256"]
   * @returns {string}
   */
  public static getHash(value: string, algorithm: string = "sha256"): string {
    let hash = crypto.createHash(algorithm);
    hash.update(value);
    return hash.digest("hex");
  }

  /**
   * Definition Proxy
   *
   * @param {string} value
   * @param {string} [algorithm="sha256"]
   * @returns {string}
   */
  public getHash(value: string, algorithm: string = "sha256"): string {
    return Hash.getHash(value, algorithm);
  }
}
