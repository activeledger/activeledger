/*
 * MIT License (MIT)
 * Copyright (c) 2019 Activeledger
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

import { ActiveLogger } from "@activeledger/activelogger";
import {
  ContractFiles,
  ContractSource,
} from "@activeledger/activecontracts/lib/source";
import { Provider } from "../provider/provider";
import { Helper } from "../helper/helper";

/**
 * Manages contract file caching
 *
 * @export
 * @class Contract
 */
export class Contract {
  /**
   * Rebuilds file cache from ledger entry. A version that cannot be
   * recovered (hash-only, or its deploy transaction not held) is reported
   * and skipped rather than stopping the restore.
   *
   * @static
   * @param {*} contract
   */
  public static async rebuild(contract: any): Promise<void> {
    const files = new ContractFiles("contracts");
    const fetchUmid = (umid: string) =>
      Provider.database.get(`${umid}:umid`).catch(() => undefined);

    for (const version of Object.keys(contract.contract)) {
      try {
        const source = await ContractSource.resolve(
          contract,
          version,
          fetchUmid
        );
        files.write(
          contract.namespace,
          contract._id,
          version,
          ContractSource.transpile(source.base64, source.target)
        );
      } catch (e: any) {
        ActiveLogger.warn(
          `Cannot rebuild ${contract._id}@${version}, its file is missing: ${e.message}`
        );
      }
    }

    // Locks are files, so they come back from what the stream recorded
    const locks = contract.locks;
    if (locks) {
      const held: string[] = [
        ...(locks.all ? [""] : []),
        ...(locks.versions || []).map((v: string) => "@" + v),
      ];
      for (const version of held) {
        try {
          files.lock(contract.namespace, contract._id, version);
        } catch (e: any) {
          ActiveLogger.warn(
            `Cannot restore the lock on ${contract._id}${version}: ${e.message}`
          );
        }
      }
    }
  }
}
