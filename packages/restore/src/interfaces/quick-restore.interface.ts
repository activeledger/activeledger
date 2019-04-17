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

import { ActiveNetwork } from "@activeledger/activenetwork";

export interface IRestoreStream {
  id: string;
  rev: string;
}

export interface IStreamInformation {
  reference: string;
  streams: IRestoreStream[];
}

export interface INetworkData {
  documents: any;
  volatile: any;
}

interface IReductionRevisionData {
  [revision: string]: number;
}

export interface IReductionData {
  [identity: string]: IReductionRevisionData;
}

export interface IKnockData {
  data: IRestoreStream[];
}

export interface IConsensusData {
  stream: string;
  revision: string;
}

export interface IBaseData {
  _id: string;
  error?: string | {};
  namespace?: string;
  contract?: [];
  compiled?: string[];
}

export interface INeighbourhood {
  [reference: string]: ActiveNetwork.Neighbour;
}
