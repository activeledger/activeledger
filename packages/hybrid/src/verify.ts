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

import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";

type IFeedItem = ActiveDefinitions.IFeedItem;
type ICommitAttestation = ActiveDefinitions.ICommitAttestation;

/** A supernode's identity key as the setup stream lists it */
export interface NodeKey {
  type: string;
  public: string;
}

/** Node reference -> identity key */
export type NodeKeys = Map<string, NodeKey>;

/**
 * The supernodes' keys from the setup stream, by node reference.
 *
 * A reference is sha1(host + port + network), exactly as `Neighbour` builds
 * it, where `network` is the supernodes' `network` option. A
 * `neighbourhoodRemap` in the setup document replaces a reference the same
 * way the supernode's own option does.
 */
export function nodeKeys(setupDoc: any, network: string): NodeKeys {
  const keys: NodeKeys = new Map();
  const remap: { [ref: string]: string } =
    setupDoc && typeof setupDoc.neighbourhoodRemap === "object" && setupDoc.neighbourhoodRemap
      ? setupDoc.neighbourhoodRemap
      : {};
  for (const n of Array.isArray(setupDoc?.neighbourhood) ? setupDoc.neighbourhood : []) {
    if (!n || n.host === undefined || n.port === undefined) continue;
    if (!n.identity || typeof n.identity.public !== "string") continue;
    let ref = ActiveCrypto.Hash.getHash(n.host + n.port + network, "sha1");
    if (typeof remap[ref] === "string") ref = remap[ref];
    keys.set(ref, { type: n.identity.type || "rsa", public: n.identity.public });
  }
  return keys;
}

/** Setup-stream facts verification needs */
export interface VerifyContext {
  keys: NodeKeys;
  /** `consensus.reached`, a percent of the network */
  reachedPercent: number;
  /** The neighbourhood length */
  networkSize: number;
}

/** Build a `VerifyContext` from the setup stream document */
export function verifyContext(setupDoc: any, network: string): VerifyContext {
  return {
    keys: nodeKeys(setupDoc, network),
    reachedPercent: Number(setupDoc?.consensus?.reached),
    networkSize: Array.isArray(setupDoc?.neighbourhood) ? setupDoc.neighbourhood.length : 0,
  };
}

const keyId = (k: NodeKey) => `${k.type}:${k.public}`;

export interface VoteResult {
  /** Votes whose signature verifies, one per key */
  valid: { ref: string; vote: boolean }[];
  /** Signed votes from a known node whose signature does not verify */
  invalid: string[];
  /** Votes that do not count and are not evidence of forgery */
  ignored: { ref: string; reason: string }[];
}

/**
 * Check each `nodes[ref].sig` as the node's signature over
 * voteDigest(umid, vote, $revs). Unsigned votes, unknown references and a
 * second reference for a key already counted do not count. A signature that
 * does not verify (forged, wrong revs, replayed from another umid) is listed
 * in `invalid`.
 */
export function verifyVotes(item: IFeedItem, keys: NodeKeys): VoteResult {
  const result: VoteResult = { valid: [], invalid: [], ignored: [] };
  const seen = new Set<string>();
  const nodes = item && typeof item.nodes === "object" && item.nodes ? item.nodes : {};
  for (const ref of Object.keys(nodes).sort()) {
    const n = nodes[ref];
    const key = keys.get(ref);
    if (!key) {
      result.ignored.push({ ref, reason: "unknown node" });
      continue;
    }
    if (!n || typeof n.vote !== "boolean") {
      result.ignored.push({ ref, reason: "no vote" });
      continue;
    }
    if (typeof n.sig !== "string" || !n.sig) {
      result.ignored.push({ ref, reason: "unsigned" });
      continue;
    }
    const digest = ActiveCrypto.voteDigest(item.umid, n.vote, item.$revs);
    if (!ActiveCrypto.verifyDigest(key.public, key.type, digest, n.sig)) {
      result.invalid.push(ref);
      continue;
    }
    if (seen.has(keyId(key))) {
      result.ignored.push({ ref, reason: "duplicate key" });
      continue;
    }
    seen.add(keyId(key));
    result.valid.push({ ref, vote: n.vote });
  }
  return result;
}

/**
 * True when `yes` votes reach `reachedPercent` of the network, with the
 * supernodes' own formula (`Process.canCommit`): yes / size * 100 >= percent.
 * At least one yes is always needed.
 */
export function reaches(yes: number, reachedPercent: number, networkSize: number): boolean {
  if (!Number.isFinite(reachedPercent) || !(networkSize > 0) || yes < 1) return false;
  return (yes / networkSize) * 100 >= reachedPercent;
}

/** The tally of valid signed votes */
export function tally(
  item: IFeedItem,
  keys: NodeKeys,
  reachedPercent: number,
  networkSize: number
): { yes: number; no: number; reached: boolean } {
  const { valid } = verifyVotes(item, keys);
  const yes = valid.filter((v) => v.vote).length;
  const no = valid.length - yes;
  return { yes, no, reached: reaches(yes, reachedPercent, networkSize) };
}

/**
 * True when `att.sig` is `att.node`'s signature over
 * commitDigest(umid, outcome, $revs, revsOut, umidDocHash).
 */
export function verifyAttestation(
  att: ICommitAttestation | undefined,
  revs: unknown,
  keys: NodeKeys
): boolean {
  if (!att || typeof att !== "object") return false;
  if (typeof att.sig !== "string" || typeof att.node !== "string") return false;
  if (typeof att.umid !== "string" || typeof att.umidDocHash !== "string") return false;
  if (!att.revsOut || typeof att.revsOut !== "object") return false;
  const key = keys.get(att.node);
  if (!key) return false;
  const digest = ActiveCrypto.commitDigest(
    att.umid,
    att.outcome,
    revs,
    att.revsOut,
    att.umidDocHash
  );
  return ActiveCrypto.verifyDigest(key.public, key.type, digest, att.sig);
}

/** sha256 of the canonical JSON of a stored document, as attestations use */
export const docHash = (doc: unknown): string =>
  ActiveCrypto.Hash.getHash(ActiveCrypto.canonicalJson(doc));

/** True when the item's `:umid` doc hashes to its attestation's `umidDocHash` */
export function verifyUmidDoc(item: IFeedItem): boolean {
  if (!item?.umidDoc || !item.attestation) return false;
  return docHash(item.umidDoc) === item.attestation.umidDocHash;
}

const claim = (a: ICommitAttestation) =>
  ActiveCrypto.canonicalJson({
    umid: a.umid,
    outcome: a.outcome,
    revsOut: a.revsOut,
    umidDocHash: a.umidDocHash,
  });

export interface QuorumResult {
  reached: boolean;
  /** Distinct valid nodes behind the largest agreeing group */
  count: number;
  /** The attestations of that group, one per node */
  agreed: ICommitAttestation[];
}

/**
 * Attestations from distinct nodes (and distinct keys) that verify and claim
 * identical umid, outcome, revsOut and umidDocHash. The largest such group is
 * returned; it is a quorum when it reaches `reachedPercent` of the network.
 */
export function quorum(
  attestations: ICommitAttestation[],
  revs: unknown,
  keys: NodeKeys,
  reachedPercent: number,
  networkSize: number
): QuorumResult {
  const groups = new Map<string, ICommitAttestation[]>();
  const seenNodes = new Set<string>();
  const seenKeys = new Set<string>();
  for (const a of Array.isArray(attestations) ? attestations : []) {
    if (!verifyAttestation(a, revs, keys)) continue;
    const key = keys.get(a.node) as NodeKey;
    if (seenNodes.has(a.node) || seenKeys.has(keyId(key))) continue;
    seenNodes.add(a.node);
    seenKeys.add(keyId(key));
    const c = claim(a);
    groups.set(c, [...(groups.get(c) ?? []), a]);
  }
  let agreed: ICommitAttestation[] = [];
  for (const g of groups.values()) if (g.length > agreed.length) agreed = g;
  return {
    reached: reaches(agreed.length, reachedPercent, networkSize),
    count: agreed.length,
    agreed,
  };
}

export interface FeedItemCheck {
  ok: boolean;
  reasons: string[];
  yes: number;
  no: number;
  /** Committed: attestation signed by a known node, matching the item and its `:umid` doc */
  attestationOk: boolean;
}

/**
 * Step 1 of processing a feed item. Any signature present on a vote from a
 * known node must verify. A committed item also needs its valid yes votes to
 * reach consensus, and a valid attestation that matches the item and the
 * `:umid` doc. A failed item needs at least one valid signed vote.
 */
export function verifyFeedItem(item: IFeedItem, ctx: VerifyContext): FeedItemCheck {
  const reasons: string[] = [];
  const out = (attestationOk: boolean, yes = 0, no = 0): FeedItemCheck => ({
    ok: reasons.length === 0,
    reasons,
    yes,
    no,
    attestationOk,
  });

  if (!item || typeof item !== "object") {
    reasons.push("not an object");
    return out(false);
  }
  if (typeof item.umid !== "string" || !item.umid) reasons.push("missing umid");
  if (item.outcome !== "committed" && item.outcome !== "failed") {
    reasons.push(`unknown outcome ${JSON.stringify(item.outcome)}`);
  }
  if (!item.$revs || typeof item.$revs !== "object") reasons.push("missing $revs");
  if (!item.nodes || typeof item.nodes !== "object") reasons.push("missing nodes");
  if (reasons.length) return out(false);

  const votes = verifyVotes(item, ctx.keys);
  for (const ref of votes.invalid) reasons.push(`invalid vote signature from ${ref}`);
  const yes = votes.valid.filter((v) => v.vote).length;
  const no = votes.valid.length - yes;

  if (item.outcome === "failed") {
    if (!votes.valid.length) reasons.push("no valid signed vote");
    return out(false, yes, no);
  }

  if (!reaches(yes, ctx.reachedPercent, ctx.networkSize)) {
    reasons.push(
      `tally ${yes}/${ctx.networkSize} below consensus ${ctx.reachedPercent}%`
    );
  }

  const att = item.attestation;
  let attestationOk = false;
  if (!att) reasons.push("missing attestation");
  else if (att.umid !== item.umid) reasons.push("attestation is for another umid");
  else if (att.outcome !== "committed") reasons.push("attestation outcome is not committed");
  else if (
    item.revsOut !== undefined &&
    ActiveCrypto.canonicalJson(item.revsOut) !== ActiveCrypto.canonicalJson(att.revsOut)
  ) {
    reasons.push("revsOut differs from the attestation");
  } else if (!verifyAttestation(att, item.$revs, ctx.keys)) {
    reasons.push(`invalid attestation signature from ${att.node}`);
  } else if (!verifyUmidDoc(item)) {
    reasons.push("umid doc does not match the attestation's umidDocHash");
  } else if (
    ActiveCrypto.canonicalJson(item.umidDoc?.umid?.$revs) !==
    ActiveCrypto.canonicalJson(item.$revs)
  ) {
    reasons.push("umid doc $revs differ from the item's");
  } else {
    attestationOk = true;
  }
  return out(attestationOk, yes, no);
}
