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

/** What `GET /h/bootstrap` returns (`HybridApi.bootstrap`) */
export interface IBootstrap {
  /** The setup stream document, undefined if the supernode has none */
  setup: any;
  /** The on-ledger `hybrid.required` list */
  required: ActiveDefinitions.IHybridLedgerConfig["required"];
  window?: { days: number };
  minVersion?: string;
  /** Contract stream ids */
  contracts: string[];
  /** The newest feed cursor, "" on an empty ledger */
  cursor: string;
}

/**
 * One supernode (or, later, hybrid peer) the hybrid reads from. Transport
 * free: HTTP and P2P implement the same calls.
 */
export interface Upstream {
  readonly id: string;
  bootstrap(): Promise<IBootstrap>;
  head(): Promise<{ cursor: string; time: number }>;
  /**
   * Stream feed items after `cursor`. `onItem` is awaited before the next
   * item is read. Resolves when the upstream ends the stream or `signal`
   * aborts; rejects on any failure. Reconnecting is the caller's choice.
   */
  feed(
    cursor: string,
    onItem: (cursor: string, item: ActiveDefinitions.IFeedItem) => Promise<void>,
    signal: AbortSignal,
    onHeartbeat?: (head: string, time: number) => void
  ): Promise<void>;
  streams(
    reqs: { id: string; rev?: string }[]
  ): Promise<{ docs: any[]; missing: { id: string; rev?: string }[] }>;
  /** The `:umid` doc, undefined when the upstream has none */
  umid(umid: string): Promise<any | undefined>;
  /** The upstream's commit attestation, undefined when it has none */
  attest(umid: string): Promise<ActiveDefinitions.ICommitAttestation | undefined>;
  peers(): Promise<any[]>;
  /** Submit a transaction; resolves with the supernode's response body */
  submit(tx: any): Promise<any>;
}
