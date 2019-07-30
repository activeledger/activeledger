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

import { IVirtualMachine } from "./interfaces/vm.interface";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveDSConnect } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activecontracts";
import { EventEmitter } from "events";
import { ActiveCrypto } from "@activeledger/activecrypto";

/**
 * Holds methods shared between process, permissionsChecker, and streamUpdater
 *
 * @export
 * @class Shared
 */
export class Shared {
  /**
   * Maps streamId to their labels
   *
   * @private
   * @memberof Process
   */
  public ioLabelMap: any = { i: {}, o: {} };

  /**
   * Prioritise the error sent to the requestee
   *
   * @private
   * @memberof Process
   */
  private _errorOut: {
    code: number;
    reason: string | Error;
    priority: number;
  } = {
    code: 0,
    reason: "",
    priority: 0
  };

  constructor(
    private _storeSingleError: boolean,
    private entry: ActiveDefinitions.LedgerEntry,
    private dbe: ActiveDSConnect,
    private emitter: EventEmitter
  ) {}

  /**
   * Set the value of errorOut
   *
   * @memberof Shared
   */
  set errorOut(errorOut: {
    code: number;
    reason: string | Error;
    priority: number;
  }) {
    this._errorOut = errorOut;
  }

  /**
   * Set the store single error state
   *
   * @memberof Shared
   */
  set storeSingleError(state: boolean) {
    this._storeSingleError = state;
  }

  /**
   * Get the correct input for Label or key
   *
   * @private
   * @param {boolean} inputs
   * @param {string} streamId
   * @returns {string}
   * @memberof Process
   */
  public getLabelIOMap(inputs: boolean, streamId: string): string {
    // Get Correct Map
    let checkIOMap = inputs ? this.ioLabelMap.i : this.ioLabelMap.o;

    // If map empty default to key stream
    if (!Object.keys(checkIOMap).length) {
      return streamId;
    }
    return checkIOMap[streamId];
  }

  /**
   * Clears all Internode Communication if contract requests
   *
   * @private
   * @memberof Process
   */
  public clearAllComms(
    virtualMachine: IVirtualMachine
  ): ActiveDefinitions.LedgerEntry {
    if (virtualMachine.clearingInternodeCommsFromVM(this.entry.$umid)) {
      const nodes = Object.values(this.entry.$nodes);

      let i = nodes.length;
      while (i--) {
        nodes[i].incomms = null;
      }
    }

    return this.entry;
  }

  /**
   * Manage all errors from the Process & VM to put into the activerestore. So activerestore
   * can verify if it failed due to local coniditions or just a bad entry
   *
   * @private
   * @param {number} code
   * @param {Error} reason
   * @param {Boolean} [stop]
   * @memberof Process
   */
  public async raiseLedgerError(
    code: number,
    reason: Error,
    stop: Boolean = false,
    priority: number = 0
  ) {
    try {
      // Store in database for activerestore to review
      await this.storeError(code, reason, priority);

      if (!stop) {
        this.emitter.emit("failed", {
          status: this._errorOut.code,
          error: this._errorOut.reason
        });
      }
    } catch (error) {
      // Problem could be serious (Database down?)
      // However if this errors we need to just emit to let the ledger continue
      ActiveLogger.fatal(error, "Database Error Log Issues");

      // Emit failed event for execution
      if (!stop) {
        this.emitter.emit("failed", {
          status: code,
          error: error
        });
      }
    }
  }

  /**
   * Store Error into Database
   * TODO: Defer storing into the database until after execution or on crash
   *
   * @private
   * @param {number} code
   * @param {Error} reason
   * @param {number} priority
   * @returns {Promise<any>}
   * @memberof Process
   */
  public storeError(
    code: number,
    reason: Error,
    priority: number = 0
  ): Promise<any> {
    const getReason = () =>
      reason && reason.message ? reason.message : reason;

    if (priority >= this._errorOut.priority) {
      this._errorOut.code = code;

      this._errorOut.reason = getReason() as string;

      this._errorOut.priority = priority;
    }

    if (!this._storeSingleError && this.entry) {
      // Build document for database
      const doc = {
        code,
        processed: this._storeSingleError,
        umid: this.entry.$umid,
        transaction: this.entry,
        reason: getReason()
      };

      // Now if we store another error it won't be processed
      this._storeSingleError = true;

      return this.dbe.post(doc);
    } else {
      return Promise.resolve();
    }
  }

  /**
   * Validate signature for the transaction
   *
   * @private
   * @param {string} publicKey
   * @param {string} signature
   * @param {string} rsa
   * @returns {boolean}
   * @memberof Process
   */
  public signatureCheck(
    publicKey: string,
    signature: string,
    type: string = "rsa"
  ): boolean {
    try {
      // Get Key Object
      let key: ActiveCrypto.KeyPair = new ActiveCrypto.KeyPair(type, publicKey);

      // Return Valid or not
      return key.verify(this.entry.$tx, signature);
    } catch (error) {
      ActiveLogger.error(error, "Signature Check Error");
      return false;
    }
  }
}
