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

import Standard from "./standard";

/**
 * Allow for post processing of data after the commit phase. This can run outside of the ledger 
 * but will have access to the volatile stream.
 * 
 * @export
 * @abstract
 * @class PostProcess
 * @extends {Standard}
 */
export default abstract class PostProcess extends Standard {

  /**
   * Runs code after the commit phase, Territoriality confirms this node
   * reached its commit phase first. all other nodes will be false
   * 
   * @abstract
   * @param {boolean} territoriality 
   * @param {string} who 
   * @returns {Promise<any>} 
   * @memberof PostProcess
   */
  public abstract postProcess(territoriality: boolean, who: string): Promise<any>;
}
