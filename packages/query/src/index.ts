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

/**
 * Manages creating events in an activeledger transaction session
 *
 * @export
 * @class EventEngine
 */
export class EventEngine {
  /**
   * Contract Phase
   *
   * @private
   */
  private phase = "vote";

  /**
   * Prevent same date collisions
   *
   * @private
   */
  private counter = 0;

  /**
   * Creates an instance of EventEngine.
   * @param {ActiveDefinitions.IActiveDSConnect} db
   * @param {string} contract
   * @param {*} transaction
   */
  constructor(private db: any, private contract: string, private umid: string) {}

  /**
   * Emit the event to the database
   *
   * @param {string} name
   * @param {*} data
   * @returns {Promise<any>}
   */
  public emit(name: string, data: any): void {
    // Event object to store 
    let event: any = {
      _id: `event:${Date.now()}-${++this.counter},${this.umid}`,
      name: name,
      data: data,
      phase: this.phase,
      contract: this.contract,
    };

    // TODO: Instruct to write to the database instead of just doing it?
    // ie vote gets sent on commit, commit gets sent when confirmed etc.
    this.db
      .post(event)
      .then(() => {})
      .catch(() => {});
  }

  /**
   * Change Phase position
   *
   * @param {string} name
   */
  public setPhase(name: string) {
    this.phase = name;
  }
}
