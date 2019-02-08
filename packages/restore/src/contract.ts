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

import * as fs from "fs";
import * as ts from "typescript";

/**
 * Manages contract file caching
 *
 * @export
 * @class Contract
 */
export class Contract {
  /**
   * Rebuilds file cache from ledger entry
   *
   * @static
   * @param {*} contract
   * @memberof Contract
   */
  public static rebuild(contract: any): void {
    // Get keys of the contract
    let versions = Object.keys(contract.contract);

    // Loop Keys in order and build contract file
    for (let i = 0; i < versions.length; i++) {
      // TODO : Version checking, Array order isn't guaranteed
      const version = versions[i];
      const code = Contract.transpile(contract.contract[version]);

      // Make sure we have contract
      if (!fs.existsSync("contracts")) fs.mkdirSync("contracts");

      // Make sure we have namespace
      if (!fs.existsSync(`contracts/${contract.namespace}`)) fs.mkdirSync(`contracts/${contract.namespace}`);

      // Write Latest
      fs.writeFileSync(
        `contracts/${contract.namespace}/${contract._id}.js`,
        code
      );

      // Write Latest Version
      fs.writeFileSync(
        `contracts/${contract.namespace}/${contract._id}@${version}.js`,
        code
      );
    }
  }

  /**
   * Transpile Typescript to Javascript
   *
   * @private
   * @static
   * @param {string} code
   * @returns {string}
   * @memberof Contract
   */
  private static transpile(code: string): string {
    // Base64 Decode & Transpile to javascript
    return ts.transpileModule(Buffer.from(code, "base64").toString(), {
      compilerOptions: {
        alwaysStrict: true,
        strictNullChecks: true,
        noImplicitAny: true,
        removeComments: true,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Classic,
        target: ts.ScriptTarget.ES2017
      }
    }).outputText;
  }
}
