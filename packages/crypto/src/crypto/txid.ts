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

import { Hash } from "./hash";

/**
 * The id ($umid) a node gives a transaction that has an $expire.
 *
 * The same signed transaction should get the same id however it is wrapped, so
 * that the node can tell it has already seen it. From BUILD the id is the hash
 * of `$tx`, the part the signatures cover. Before it, the id is the hash of
 * the whole entry as it arrived (less the fields only a node sets), which is
 * kept so a network that has not yet raised its build level agrees with itself.
 *
 * @export
 * @class TransactionId
 */
export class TransactionId {
  /**
   * Build level from which the id is the hash of `$tx` alone. Named after the
   * release that introduced it (5.11.3).
   */
  public static readonly BUILD = 51103;

  /**
   * Fields that only a node sets. They mean nothing coming from a client, so
   * they are removed from what a client sends and never count towards an id.
   */
  public static readonly NODE_FIELDS = [
    "$umid",
    "$origin",
    "$remoteAddr",
    "$nodes",
    "$revs",
    "$streams",
    "$spiRetry",
    "$replaces",
    "$chain",
    "$leaderOk",
    "$leaderFwd",
    "$relay",
  ] as const;

  /**
   * The id for an entry.
   *
   * @static
   * @param {{ $tx: unknown }} entry The entry, before the node stamps anything on it
   * @param {number} build The network's build level
   * @returns {string}
   */
  public static of(entry: { $tx: unknown }, build: number): string {
    if (build >= TransactionId.BUILD) {
      return Hash.getHash(JSON.stringify(entry.$tx));
    }
    const rest: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    for (const field of TransactionId.NODE_FIELDS) delete rest[field];
    return Hash.getHash(JSON.stringify(rest));
  }
}
