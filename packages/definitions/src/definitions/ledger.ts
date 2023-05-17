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

import { IFullState, IMeta, IVolatile } from "./document";

/**
 * The main transaction entry interface. All V2 transactions
 * should look like this. Prefixed with $ to avoid collisions
 *
 * @export
 * @interface LedgerEntry
 */
export interface LedgerEntry {
  $origin: string;
  $datetime: Date;
  $umid: string;
  $tx: LedgerTransaction; // | LedgerTransaction[];
  $sigs: LedgerSignatures; // | LedgerSignatures[];
  $selfsign: boolean;
  $revs: LedgerRevs;
  $multi: boolean;
  $instant: boolean;
  $nodes: INodes;
  $streams: IStreams;
  $remoteAddr: string;
  $broadcast?: boolean;
  $territoriality?: string;
  $encrypt?: boolean;
}

export interface LedgerResponse {
  $umid: string;
  $summary: ISummary;
  $streams: IStreams;
  $responses?: unknown[];
  $territoriality?: string;
  $debug?: LedgerEntry;
}

export interface ISummary {
  total: number;
  vote: number;
  commit: number;
  errors?: string[];
}

export interface IStreams {
  new: IStream[];
  updated: IStream[];
}

export interface IStream {
  id: string;
  name: string;
}

export interface INodes {
  [reference: string]: INodeResponse;
}

export interface INodeResponse {
  vote: boolean;
  commit: boolean;
  post?: any;
  incomms?: any;
  datetime?: Date;
  error?: string;
  return?: unknown;
}

export interface ICommunications {
  [reference: string]: Object;
}

/**
 * Granual detail of the transaction object
 *
 * @export
 * @interface LedgerTransaction
 */
export interface LedgerTransaction {
  $namespace: string;
  $contract: string;
  $entry?: string;
  $i: LedgerInputs;
  $o: LedgerIORputs;
  $r?: LedgerIORputs;
}

/**
 * Input & Output value of the transaction
 *
 * @export
 * @interface LedgerIOputs
 */
export interface LedgerIORputs {
  [reference: string]: any;
}

/**
 * If hardenedKeys security enabled inputs will need a new key
 * nhpk = New Hardened Public Key
 *
 * @export
 * @interface LedgerInputs
 * @extends {LedgerIOputs}
 */
export interface LedgerInputs extends LedgerIORputs {
  $nhpk?: string;
}

/**
 * Revision value of the transaction
 *
 * @export
 * @interface LedgerRevs
 */
export interface LedgerRevs {
  $i: LedgerRevIO;
  $o: LedgerRevIO;
}

/**
 * Revision Input / Output value of the transaction
 *
 * @export
 * @interface LedgerRevs
 */
export interface LedgerRevIO {
  [reference: string]: string;
}

/**
 * Input Signature Object
 *
 * @export
 * @interface LedgerSignatures
 */
export interface LedgerSignatures {
  [reference: string]: string | LedgerAuthSignatures;
  $sig: string;
}

/**
 * Nested Signatures for multi signature consensus on a single stream
 *
 * @export
 * @interface LedgerAuthSignatures
 */
export interface LedgerAuthSignatures {
  [reference: string]: string;
}

/**
 * The data structure of an activity stream within the ledger
 *
 * @export
 * @interface LedgerStream
 */
export interface LedgerStream {
  meta: IMeta;
  state: IFullState;
  volatile?: IVolatile;
}

/**
 * Authority Structure over an Activity Stream
 *
 * @export
 * @interface ILedgerAuthority
 */
export interface ILedgerAuthority {
  public: string;
  type: string;
  stake: number;
  hash?: string;
  label?: string;
  metadata?: any;
}

/**
 * Type Checking Methods for validation
 * TODO : Cascade down the object
 *
 * @export
 * @class LedgerTypeChecks
 */
export class LedgerTypeChecks {
  /**
   * Is object of type LedgerEntry
   *
   * @static
   * @param {*} tx
   * @returns {object is LedgerEntry}
   * @memberof LedgerTypeChecks
   */
  public static isEntry(tx: LedgerEntry): tx is LedgerEntry {
    if (
      tx.$tx &&
      ((tx.$tx.$i && tx.$sigs) ||
        (tx.$tx.$namespace && tx.$tx.$contract))
    ) {
      return true;
    }
    return false;
  }

  /**
   * Is object of type LedgerAuthSignatures
   *
   * @static
   * @param {*} object
   * @returns {object is LedgerAuthSignatures}
   * @memberof LedgerTypeChecks
   */
  public static isLedgerAuthSignatures(
    object: any
  ): object is LedgerAuthSignatures {
    return typeof object === "object";
  }
}
