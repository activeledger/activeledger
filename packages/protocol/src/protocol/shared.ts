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
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { Process } from "./process";

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
   */
  public ioLabelMap: any = { i: {}, o: {} };

  /**
   * Prioritise the error sent to the requestee
   *
   * @private
   */
  private _errorOut: {
    code: number;
    reason: string | Error;
    priority: number;
  } = {
    code: 0,
    reason: "",
    priority: 0,
  };

  constructor(
    private _storeSingleError: boolean,
    private entry: ActiveDefinitions.LedgerEntry,
    private dbe: ActiveDSConnect,
    private emitter: Process
  ) {}

  /**
   * Stores a copy of the single error to return
   *
   * @private
   * @type {*}
   */
  private _storedSingleErrorDoc: any = {
    id: "Default Error Id",
  };

  /**
   * Set the value of errorOut
   *
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
   */
  public getLabelIOMap(inputs: boolean, streamId: string): string {
    // Get Correct Map
    let checkIOMap = inputs ? this.ioLabelMap.i : this.ioLabelMap.o;

    // If map empty default to key stream
    if (!Object.keys(checkIOMap).length) {
      return this.filterMap[streamId] ? this.filterMap[streamId] : streamId;
    }
    return checkIOMap[this.filterMap[streamId]]
      ? checkIOMap[this.filterMap[streamId]]
      : checkIOMap[streamId];
  }

  /**
   * Maps virtual prefix to no prefix and no prefix to virtual
   *
   * @private
   * @type {{ [name: string]: string }}
   */
  private filterMap: { [name: string]: string } = {};

  /**
   * While the filter does everything, First one encountered we will assume as the standard
   *
   * @private
   * @type {string}
   */
  public assumedVirtualPrefix: string = "";

  /**
   * Filter out unknown prefixes (copied from selhost.ts)
   *
   * @private
   * @param {string} stream
   * @param {boolean} skipMap Do not use lookup calculate it again if needed
   * @returns {string}
   */
  public filterPrefix(stream: string, skipMap = false): string {
    if (!skipMap && this.filterMap[stream]) {
      return this.filterMap[stream];
    }

    // Remove any suffix like :volatile :stream :umid
    let [streamId, suffix] = stream.split(":");

    // If id length more than 64 trim the start
    if (streamId.length > 64) {
      if (!this.assumedVirtualPrefix) {
        this.assumedVirtualPrefix = streamId.slice(0, 2);
      }

      streamId = streamId.slice(-64);

      // Need 2 way mapping, Try to avoid circular calls!
      this.filterMap[streamId] = stream;
      this.filterMap[stream] = streamId;
    }

    // If suffix add it back to return
    if (suffix) {
      return streamId + ":" + suffix;
    }

    // Return just the id
    return streamId;
  }

  /**
   * Clears all Internode Communication if contract requests
   *
   * @param {IVirtualMachine} virtualMachine
   * @param {*} preserveComms
   * @returns {ActiveDefinitions.LedgerEntry}
   */
  public clearAllComms(
    virtualMachine: IVirtualMachine,
    preserveComms: any
  ): ActiveDefinitions.LedgerEntry {
    if (virtualMachine.clearingInternodeCommsFromVM(this.entry.$umid)) {
      const nodes = Object.values(this.entry.$nodes);

      let i = nodes.length;
      while (i--) {
        // Allow the clearning node to preserve a specific output
        if (nodes[i].incomms !== preserveComms) {
          nodes[i].incomms = null;
        }
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
   */
  public async raiseLedgerError(
    code: number,
    reason: Error,
    stop: Boolean = false,
    priority: number = 0,
    noWait = false
  ) {
    try {
      // CSVE - contract skip vote error db (restore engine slightly different)
      // try {
      //   if (reason && this.getGlobalReason(reason)?.indexOf("#CSVEDB") !== -1) {
          
      //     this.emitter.emitFailed(
      //       {
      //         status: code,
      //         error: this.getGlobalReason(reason) as string,
      //       },
      //       noWait
      //     );
      //     return;
      //   }
      // } catch (e) {
      //   ActiveLogger.error(reason, "Global Reason Empty");
      //   throw e;
      // }


      // Store in database for activerestore to review
      const dbDoc = (this._storedSingleErrorDoc = await this.storeError(
        code,
        reason,
        priority
      ));

      if (!stop) {
        // Append database error id for easier reference
        let error = this._errorOut.reason;
        if (dbDoc.id) {
          error += " - Error " + dbDoc.id;
        }
        this.emitter.emitFailed(
          {
            status: this._errorOut.code,
            error,
          },
          noWait
        );
      }
    } catch (error) {
      // Problem could be serious (Database down?)
      // However if this errors we need to just emit to let the ledger continue
      ActiveLogger.fatal(error, "Database Error Log Issues");

      // Emit failed event for execution
      if (!stop) {
        // Skip over delay send it right away
        this.emitter.emit(
          "failed",
          {
            status: code,
            error: error,
          },
          noWait
        );
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
   */
  public storeError(
    code: number,
    reason: Error,
    priority: number = 0
  ): Promise<any> {
    // const getReason = () =>
    //   reason && reason.message ? reason.message : reason;
    if (priority >= this._errorOut.priority) {
      this._errorOut.code = code;
      this._errorOut.reason = this.getGlobalReason(reason) as string;

      this._errorOut.priority = priority;
    }

    if (!this._storeSingleError && this.entry) {
      // Take a copy of entry, To manipulate the $nodes incomms
      // Reason for copy is this node maybe the one that errors and the incomms maybe useful elsewhere
      const tmpEntry = JSON.parse(
        JSON.stringify(this.entry)
      ) as ActiveDefinitions.LedgerEntry;
      const nodeErrors = Object.keys(tmpEntry.$nodes);
      for (let i = nodeErrors.length; i--; ) {
        tmpEntry.$nodes[nodeErrors[i]].incomms = null;
      }
      // Build document for database
      const doc = {
        code,
        processed: this._storeSingleError,
        umid: this.entry.$umid,
        transaction: tmpEntry, // Need to clear this.entry.$nodes["sss"].incomms
        reason: this.getGlobalReason(reason),
      };

      // Now if we store another error it won't be processed
      this._storeSingleError = true;

      return this.dbe.post(doc);
    } else {
      return Promise.resolve(this._storedSingleErrorDoc);
    }
  }

  /**
   * Get best string based error
   * TODO : resolve the any typing! Allowing here as it is trying to explore the object
   *
   * @private
   * @param {*} reason
   * @returns
   */
  private getGlobalReason(reason: any): string {
    if(reason) {
      if(reason.message) {
        return reason.message.toString();
      }
      if(reason.error) {
        return reason.error.toString();
      }
      return reason.toString();
    }else{
      return "Uncaught Error Reason"
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
