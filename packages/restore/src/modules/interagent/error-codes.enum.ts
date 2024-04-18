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

/**
 * Everything else: Might be ahead so check for incorrect stream position
 * If broadcast can't rely on the data
 */
export enum ErrorCodes {
  /** Stream not found */ 
  StreamNotFound = 950,
  /** State not found */
  StateNotFound = 960,
  /** Vote failed (Similar to 1505, but has a different report time) */
  VoteFailed = 1000,
  /**
   * Vote failed however the network did reach consensus without us (Non broadcast method)
   * If vote failed might not have node responses
   */
  VoteFailedNetworkOk = 1001,
  /** Stream position incorrect */
  StreamPositionIncorrect = 1200,
  /** Read only stream not found */
  ReadOnlyStreamNotFound = 1210,
  /** This node voted no, possibly incorrectly (Similar to 1000, but has a different report time) */
  NodeFinalReject = 1505,
  /**
   * Failed to save, this might have been the only node to vote
   * If failed to save can't rely on data in the body
   */
  FailedToSave = 1510,
  /** If votes did not, transaction was voted incorrect by majority, we can safely ignore it */
  Unknown = 1600,
  /** Failed to get a response back in a rebroadcast while the transaction was in memory */
  FailedToGetResponse = 1610
}
