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

import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Stream } from "./stream";

/**
 * Provides the standard contract layout for Active developers to extend
 * so they can concentrate on their code. This is the first of a list of approved "base" classes.
 *
 * @export
 * @abstract
 * @class Standard
 */
 export default abstract class Standard extends Stream {
  /**
   * Developer required to create a verify command for their contract.
   * Verify is to deterimine if this contract can understand this transaction
   *
   * @abstract
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Standard
   */
  public abstract verify(signatureless: boolean): Promise<boolean>;

  /**
   * Developer required to create a vote command for their contract.
   * Vote is to determine will the code be happy to execute
   * (Such has do they have the right permissions or data to transfer)
   *
   * @abstract
   * @returns {Promise<boolean>}
   * @memberof Standard
   */
  public abstract vote(): Promise<boolean>;

  /**
   * Developer required to create commit phase for their contract.
   * Commit phase is when objects are actually updated by the developer for saving into the ledger
   *
   * @abstract
   * @param {boolean} [possibleTerritoriality]
   * @returns {Promise<any>}
   * @memberof Standard
   */
  public abstract commit(possibleTerritoriality?: boolean): Promise<any>;
}
