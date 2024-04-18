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
import { Provider } from "../provider/provider";

/**
 * Helper class providing useful functions used by all restoration class files
 *
 * @export
 * @class Helper
 */
export class Helper {
  public static verbose: boolean = false;

  /**
   * Output function that outputs when verbose is set to true
   *
   * @static
   * @param {string} message
   * @param {*} [other]
   */
  public static output(message: string, other?: any): void {
    if (Helper.verbose) {
      other ? ActiveLogger.info(other, message) : ActiveLogger.info(message);
    }
  }

  /**
   * Returns the number of nodes in the network (neighbours in neighbourhood)
   *
   * @static
   * @returns boolean
   */
  public static getNeighbourCount = (dontIncludeSelf: boolean) =>
    dontIncludeSelf ? Provider.neighbourCount - 1 : Provider.neighbourCount;

  /**
   * Returns the state of consensus based on the votes provided.
   *
   * @static
   * @returns boolean
   */
  public static metConsensus = (
    votes: number,
    dontIncludeSelf: boolean = false
  ) =>
    (votes / Helper.getNeighbourCount(dontIncludeSelf)) * 100 >=
    Provider.consensusReachedAmount;
}
