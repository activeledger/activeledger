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

export interface IChange {
  doc: IChangeDocument;
}

export interface IChangeDocument {
  _id: string;
  _rev?: string;
  processed: boolean;
  processedAt: Date;
  code: number;
  transaction: IChangeDocumentTransaction;
  umid: string;
  error: Error;
  status: number;
  message: string;
  docId: string;
  $activeledger: {};
}

interface IRevisionData {
  $i: {};
  $o: {};
}

interface ITransactionInputData {
  context?: {
    $stream: string;
  }
}

interface ITransactionData {
  contract: string;
  $r: {};
  $i: ITransactionInputData;
}

interface IChangeDocumentTransaction {
  $nodes: INodesData;
  $broadcast: boolean;
  $revs: IRevisionData;
  $tx: ITransactionData;
  $origin: string;
}

interface INodesData {
  [node: string]: INodeData;
}

interface INodeData {
  vote: boolean;
  commit: boolean;
  error: string
}

interface IResponseStreamData {
  new: string[];
  updated: string[];
}

export interface IResponse {
  error: Error;
  streams: IResponseStreamData;
}
