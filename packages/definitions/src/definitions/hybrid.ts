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

import { LedgerRevs } from "./ledger";

/**
 * Hybrid node types (v5.1). The hybrid is a lean, non-voting node that
 * re-runs contracts locally and commits only what the supernodes agreed.
 */

export type HybridTransport = "p2p" | "http";

export interface IHybridEndpoint {
  transport: HybridTransport;
  host: string;
  port: number;
  /** Use https for the http transport. Recommended: /h requests are only signed, not encrypted. */
  tls?: boolean;
}

/** What the `default/hybrid` registry contract stores, one stream per key */
export interface IHybridRegistryEntry {
  key: string;
  /** Key type, as KeyPair takes it ("rsa", "secp256k1", ...) */
  keyType: string;
  endpoints: IHybridEndpoint[];
  label?: string;
  retired?: boolean;
}

/** `$relay`: a hybrid vouching for a transaction it forwarded. `sig` is over `$umid`. */
export interface IRelay {
  key: string;
  sig: string;
}

/** `revsOut[streamId]`: the revision written and the sha256 of the stored document */
export interface IRevOut {
  rev: string;
  sha256: string;
}

export type TFeedOutcome = "committed" | "failed";

/** A supernode's vote and its signature over H(umid | vote | $revs) */
export interface IFeedNodeVote {
  vote: boolean;
  sig?: string;
}

/** Signed by a supernode after commit over H(umid | outcome | $revs | revsOut | umidDocHash) */
export interface ICommitAttestation {
  /** Node reference (hash of the node's public key) */
  node: string;
  umid: string;
  outcome: TFeedOutcome;
  revsOut: { [streamId: string]: IRevOut };
  umidDocHash: string;
  sig: string;
}

/** One item on `/h/feed` */
export interface IFeedItem {
  umid: string;
  outcome: TFeedOutcome;
  /** The `:umid` doc exactly as stored. Present when committed. */
  umidDoc?: any;
  /** The transaction. Present when failed, because nothing was stored for it. */
  tx?: any;
  $revs: LedgerRevs;
  revsOut?: { [streamId: string]: IRevOut };
  streams?: { new: any[]; updated: any[] };
  nodes: { [nodeRef: string]: IFeedNodeVote };
  attestation?: ICommitAttestation;
  /** Commit attestations a relaying hybrid gathered, so a peer can adopt without going back */
  attestations?: ICommitAttestation[];
}

export type TDivergenceKind =
  | "output-mismatch"
  | "umid-doc-mismatch"
  | "failed-but-passed"
  | "execution-error"
  | "adopt-rejected";

/** Written locally when a hybrid's result differs from the supernodes' */
export interface IDivergenceRecord {
  umid: string;
  kind: TDivergenceKind;
  supernodeTally: { yes: number; no: number };
  localResult: unknown;
  $revs: LedgerRevs;
  revsOut?: { [streamId: string]: IRevOut };
  localRevs?: LedgerRevs;
  at: string;
}

/** The `hybrid` section asserted on-ledger in the setup stream */
export interface IHybridLedgerConfig {
  admission: "open" | { allowlist: string[] };
  required: (string | { id: string; volatile?: boolean })[];
  window: { days: number };
  minVersion: string;
}

/** The hybrid's own flat config file (`hybrid.json`) */
export interface IHybridConfig {
  upstreams: IHybridEndpoint[];
  peers: IHybridEndpoint[];
  bind: string;
  port: number;
  token?: string;
  window: { days: number };
  maxLagSeconds: number | null;
  refuseOnboard: boolean;
  events?: { contracts?: string[]; where?: { [field: string]: string } };
  submit?: { contracts?: string[] };
  /**
   * Out-of-band trust anchor. The node keys a hybrid verifies votes against
   * come from the upstream it is pointed at, so a man in the middle could
   * hand it keys of their own. With `neighbourhoodSha256` set, bootstrap
   * refuses a setup stream whose neighbourhood, consensus threshold and
   * `security` section do not hash to it (`activehybrid` can print it).
   */
  pin?: { neighbourhoodSha256: string };
}
