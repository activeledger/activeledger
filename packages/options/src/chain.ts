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

/**
 * Chain identity.
 *
 * Every node is configured with the id of the chain it belongs to
 * (`"chain": { "id": 1 }`). The id is a positive integer fixed when the
 * network is created. 1 means "not for production" (localhost, testing);
 * a production chain uses any other number. That is a convention only,
 * nothing enforces it beyond a startup warning.
 *
 * A stream whose meta carries no `chain` belongs to the node's own chain.
 * That is how everything written before the field existed stays valid, with
 * no migration. A stream pulled from another chain (see the hybrid follower
 * design) always carries its chain explicitly, so absent can never be
 * mistaken for foreign.
 */
export class ActiveChain {
  /** The id used by test and local networks */
  public static readonly TEST = 1;

  /** Largest id accepted (keeps it a safe integer and a short number) */
  public static readonly MAX = 2147483647;

  /**
   * Reads and checks the chain id from a configuration object
   *
   * @throws Error with a message fit to print as the only output
   */
  public static fromConfig(config: any): number {
    const id = config?.chain?.id;
    if (id === undefined || id === null) {
      throw new Error(
        'chain.id is required. Add "chain": { "id": 1 } to config.json ' +
          "(1 means a test or local network; use another number for a production chain)."
      );
    }
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id < 1 ||
      id > ActiveChain.MAX
    ) {
      throw new Error(
        `chain.id must be a whole number from 1 to ${ActiveChain.MAX}, got ${JSON.stringify(id)}.`
      );
    }
    return id;
  }

  /**
   * The chain a stream belongs to. A meta without one is the local chain.
   */
  public static of(meta: { chain?: number } | null | undefined, local: number): number {
    const chain = meta?.chain;
    return typeof chain === "number" ? chain : local;
  }

  /** The configured id, or undefined when absent or invalid (never throws) */
  public static idOf(chain: any): number | undefined {
    try {
      return ActiveChain.fromConfig({ chain });
    } catch {
      return undefined;
    }
  }

  /** The request header lines that tell a neighbour which chain this node is on */
  public static idHeader(chain: any): string[] {
    const id = ActiveChain.idOf(chain);
    return id === undefined ? [] : ["X-Activeledger-Chain:" + id];
  }

  /**
   * The peer's chain id when it differs from ours, otherwise undefined.
   * No header (an older node) or an unreadable one is not a mismatch.
   */
  public static mismatch(own: number | undefined, header: string | undefined): number | undefined {
    if (own === undefined || header === undefined || header === null || header === "") return undefined;
    const peer = Number(header);
    if (!Number.isInteger(peer) || peer < 1) return undefined;
    return peer === own ? undefined : peer;
  }

  /**
   * Remembers the chain id beside the node's other state and refuses to run
   * if it is later changed. A typo or an edited config would otherwise stamp
   * streams under the wrong chain and go unnoticed.
   *
   * @param file Marker path (next to the node's identity file)
   * @throws Error when the recorded id differs from the configured one
   */
  public static pin(file: string, id: number): void {
    let recorded: number | undefined;
    try {
      recorded = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    } catch {
      recorded = undefined;
    }
    if (recorded === undefined || Number.isNaN(recorded)) {
      fs.writeFileSync(file, String(id) + "\n");
      return;
    }
    if (recorded !== id) {
      throw new Error(
        `chain.id is ${id} but this node was started as chain ${recorded} (recorded in ${file}). ` +
          "A node cannot change chain by editing its configuration. Restore the old id, " +
          "or remove the file only if this node's data has been reset."
      );
    }
  }

  /**
   * A test chain id (1) alongside peers that are not on this machine
   * deserves a word, since it is almost certainly a missing production id.
   *
   * @returns the warning, or undefined when nothing looks wrong
   */
  public static warning(id: number, peers: Array<{ host?: string }>): string | undefined {
    if (id !== ActiveChain.TEST) return undefined;
    const remote = (peers || []).filter((peer) => {
      const host = String(peer?.host || "")
        .replace(/:\d+$/, "")
        .toLowerCase();
      return (
        host !== "" &&
        host !== "localhost" &&
        host !== "::1" &&
        host !== "[::1]" &&
        !/^127\./.test(host)
      );
    });
    return remote.length
      ? "chain.id is 1 (test chain) but this node has peers outside this machine. " +
          "If this is a production network, set its own chain.id."
      : undefined;
  }
}
