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
  _id: string | null;
  _rev: string | null;
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
  name?: string;  
  public?: string;
  hash?: string;
  contractlock?: Array<string>;
  acl?: { [reference: string]: string };
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