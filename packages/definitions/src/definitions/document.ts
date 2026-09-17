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
import { ILedgerRemovedAuthority } from "./ledger";

/**
 * Contains the data state of the ledger entry created by the contract
 * 
 * @export
 * @interface IState
 */
export interface IState {
  [reference: string]: any
}

/**
 * Contains the data state of the ledger entry created by the contract
 * 
 * @export
 * @interface IFullState
 * @extends {IState}
 */
export interface IFullState extends IState {
  [reference: string]: any
  _id?: string | null;
  _rev?: string | null;
}

/**
 * Contains the meta data state (aka stream state) of the data created by Activeledger
 * 
 * @export
 * @interface IMeta
 * @extends {IFullState}
 */
export interface IMeta extends IFullState {
  $stream?: boolean;
  $constructor?: boolean;
  umid?: string;
  /** The transaction that originally created this stream - set once, never overwritten. `umid` itself now tracks the *latest* transaction that touched this stream instead (see stream.ts's setState()/streamUpdater.ts's buildReferenceStreams()). */
  origin?: string;
  /** This stream's id was derived from a caller-supplied seed rather than from the transaction - `newActivityStream(name, deterministic)`. Set so streamUpdater can reject a collision with a stream that already exists; it used to infer this from `umid` holding the seed, which is no longer true because `umid` and `origin` must be real transactions. */
  deterministic?: boolean;
  name?: string;
  public?: string;
  hash?: string;
  contractlock?: Array<string>;
  acl?: { [reference: string]: string };
  removedAuthorities?: Array<ILedgerRemovedAuthority>;
} 

/**
 * Contains the state of any volatile information (Not Network Safe!)
 * 
 * @export
 * @interface IVolatile
 * @extends {IFullState}
 */
export interface IVolatile extends IState {
  
} 
/**
 * One version's entry in a contract stream's `state.contract` map.
 *
 * Versions deployed before contract streams stopped carrying their own
 * source are a base64 string of the TypeScript, until an update
 * normalises them. Versions deployed after are a reference to the
 * transaction that carried the source, plus a hash of the decoded bytes
 * so a node can prove what it recovered is what was deployed.
 *
 * `umid` is optional because a version deployed before this change has
 * one, but the contract cannot learn it - that would need a database read
 * the contract must not do. Such an entry keeps its identity and loses
 * its recoverability.
 */
export interface IContractRef {
  /** sha256 of the decoded source bytes, before transpile. Always present. */
  hash: string;
  /** The transaction whose $tx.$i[<identity>].contract holds the source. */
  umid?: string;
}

export type TContractEntry = string | IContractRef;

/**
 * Discriminates a reference from legacy inline source.
 *
 * Deliberately stricter than `typeof entry === "object"`: an object
 * without a hash would pass that and then be verified against undefined,
 * which compares equal to nothing and fails closed - correct, but with a
 * message blaming the hash rather than the malformed entry.
 */
export function isContractRef(entry: unknown): entry is IContractRef {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const ref = entry as IContractRef;
  if (typeof ref.hash !== "string") return false;
  return ref.umid === undefined || typeof ref.umid === "string";
}
