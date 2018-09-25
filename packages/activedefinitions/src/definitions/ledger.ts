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
  $sigs: LedgerSignatures;
  $selfsign: boolean;
  $revs: LedgerRevs;
  $multi: boolean;
  $instant: boolean;
  $nodes: INodes;
  $streams: IStreams;
  $territoriality?: string;
}

export interface LedgerResponse {
  $umid: string;
  $summary: ISummary;
  $streams: IStreams;
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
export interface LedgerInputs extends LedgerIORputs{
  $nhpk?: string
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
  [reference: string]: string;
  $sig: string;
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
  volatile: IVolatile;
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
   * @param {*} object
   * @returns {object is LedgerEntry}
   * @memberof LedgerTypeChecks
   */
  public static isEntry(object: any): object is LedgerEntry {
    return "$tx" in object && "$sigs" in object;
  }

  /**
   * Is object of type LedgerTransaction
   *
   * @static
   * @param {*} object
   * @returns {object is LedgerTransaction}
   * @memberof LedgerTypeChecks
   */
  public static isTransaction(object: any): object is LedgerTransaction {
    return "$contract" in object;
  }

  /**
   * Is object of type LedgerIOputs
   *
   * @static
   * @param {*} object
   * @returns {object is LedgerIOputs}
   * @memberof LedgerTypeChecks
   */
  public static isIOputs(object: any): object is LedgerIORputs {
    return "$data" in object;
  }

  /**
   * Is object of type LedgerSignatures
   *
   * @static
   * @param {*} object
   * @returns {object is LedgerSignatures}
   * @memberof LedgerTypeChecks
   */
  public static isSignature(object: any): object is LedgerSignatures {
    return "$sig" in object;
  }
}
