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
import type { Upstream } from "./upstream";
import type { VerifyContext } from "./verify";

/**
 * Contracts between the hybrid's modules. Each module is written against
 * these, so they can be built and tested on their own.
 */

/** The embedded databases (packages/storage `openEmbeddedStorage`) */
export interface HybridStore {
  data: import("@activeledger/activestorage").EmbeddedDSConnect;
  events: import("@activeledger/activestorage").EmbeddedDSConnect;
  errors: import("@activeledger/activestorage").EmbeddedDSConnect;
  close(): Promise<void>;
}

/** Why a hybrid is not ready */
export type NotReadyReason = "starting" | "outdated";

/**
 * The node's live state. One object, owned by the orchestrator, read by the
 * API (`/health`) and updated by bootstrap, the feed and the head poll.
 */
export interface NodeState {
  version: string;
  ready: boolean;
  reason?: NotReadyReason;
  /** On-ledger `hybrid.minVersion`, once known */
  minVersion?: string;
  /** Last feed cursor applied (or skipped as settled) */
  cursor: string;
  /** Last time a head poll or heartbeat confirmed we were at the upstream head */
  headConfirmedAt: number;
  upstreams: { host: string; ok: boolean }[];
  /** Verification context from the setup stream; undefined before bootstrap */
  verify?: VerifyContext;
}

/** Where documents can be fetched from, best first */
export interface Sources {
  /** Supernodes, in preference order */
  supernodes: Upstream[];
  /** Hybrid peers, asked first for streams (cheaper, same verification) */
  peers: Upstream[];
}

export type LocalVote = "yes" | "no" | "conditional";

/**
 * What applying one feed item did.
 *  - saved:     executed locally, matched the attested outputs, saved
 *  - adopted:   supernode-dependent mismatch, outputs adopted after checks
 *  - repaired:  mismatch, repaired by SPI (a divergence was recorded)
 *  - settled:   already applied (duplicate), nothing done
 *  - dropped:   failed verification, or could not be applied
 *  - recorded:  a failed item; divergence recorded if it passed locally
 */
export type ApplyAction =
  | "saved"
  | "adopted"
  | "repaired"
  | "settled"
  | "dropped"
  | "recorded";

export interface ApplyOutcome {
  umid: string;
  action: ApplyAction;
  /** This hybrid's own vote; a hybrid relays only after a yes */
  vote: LocalVote;
  /** Set when a divergence record was written */
  divergence?: ActiveDefinitions.IDivergenceRecord;
  /** Warnings worth an event, e.g. `adopt.undeclared` */
  warnings: string[];
  reasons: string[];
}

/** Applies feed items. Items that share streams must be applied in `$revs` order. */
export interface ItemProcessor {
  apply(item: ActiveDefinitions.IFeedItem, from: Upstream): Promise<ApplyOutcome>;
}

/** The result of `POST /` on the hybrid, see "Outcomes of POST /" in the spec */
export type HybridOutcome = "refused" | "denied" | "unavailable" | "unanswered";

/** An event the hybrid raises locally (contract events and its own) */
export interface HybridEvent {
  type: string;
  contract?: string;
  payload?: Record<string, unknown>;
  umid?: string;
}

/** Receives events as the node raises them. Implemented by the event log (events.ts). */
export interface EventSink {
  emit(event: HybridEvent): Promise<void>;
}

/**
 * Gets streams into the local store. Implemented by lookup.ts; used by the
 * processor (exact revisions from a feed item) and by `POST /` (tips).
 */
export interface StreamLookup {
  /**
   * Make every id present locally at exactly `rev` (when given), fetching
   * from peers then supernodes and checking sha256 against `revsOut` where
   * it is known. Resolves with the ids that could not be had.
   */
  ensure(
    wanted: { id: string; rev?: string; sha256?: string }[]
  ): Promise<{ missing: string[] }>;
  /** Refresh these streams (and their :stream meta) to the upstream tip */
  refreshToTip(ids: string[]): Promise<{ missing: string[] }>;
}
