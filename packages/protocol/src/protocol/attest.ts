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
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";

/**
 * Attestations: signed votes and commit attestations that let a hybrid
 * (or any observer) verify what the supernodes agreed.
 */
export class Attestation {
  /**
   * Build level from which supernodes sign. Gated like the other protocol
   * level changes, so a half-upgraded network never has nodes disagree about
   * what a `$nodes` entry contains.
   */
  public static readonly BUILD = 40300;

  /** This node's signing key. Set once by the processor at setup. */
  public static key?: ActiveCrypto.KeyPair;

  public static enabled(): boolean {
    return (
      !!Attestation.key &&
      ActiveOptions.get<number>("build", 0) >= Attestation.BUILD
    );
  }

  /**
   * Sign this node's vote into its `$nodes` entry: H(umid | vote | $revs).
   * A no vote is signed as well, because a hybrid needs the whole tally.
   */
  public static signVote(
    umid: string,
    revs: ActiveDefinitions.LedgerRevs,
    node: ActiveDefinitions.INodeResponse
  ): void {
    if (!Attestation.enabled() || !node) return;
    try {
      node.sig = ActiveCrypto.signDigest(
        Attestation.key as ActiveCrypto.KeyPair,
        ActiveCrypto.voteDigest(umid, !!node.vote, revs as any)
      );
    } catch (e) {
      // An unsigned vote is still a vote: the hybrid just cannot verify it
      ActiveLogger.error(e, `Vote attestation failed for ${umid}`);
    }
  }

  /**
   * Sign and keep this node's commit attestation, after its documents are
   * saved: H(umid | outcome | $revs | revsOut | umidDocHash).
   *
   * revsOut is read back from the store rather than taken from what was
   * sent, because LevelMe assigns the revision and the attestation must
   * describe the document a hybrid will actually fetch. The sha256 is taken
   * over the canonical JSON of that stored document.
   *
   * Never fails the commit: the transaction is already saved, and an
   * attestation that is missing here can be gathered from other supernodes.
   */
  public static async commit(
    db: { get(id: string): Promise<any> },
    events: { post(doc: any): Promise<any> },
    reference: string,
    entry: ActiveDefinitions.LedgerEntry,
    docs: { _id?: string }[]
  ): Promise<void> {
    if (!Attestation.enabled()) return;
    try {
      const sha = (doc: any) =>
        ActiveCrypto.Hash.getHash(ActiveCrypto.canonicalJson(doc));

      // Volatile never leaves the node, and the umid doc is hashed on its own
      const outputIds = docs
        .map((d) => d._id as string)
        .filter(
          (id) => id && !id.endsWith(":volatile") && !id.endsWith(":umid")
        );
      const revsOut: { [id: string]: ActiveDefinitions.IRevOut } = {};
      for (const id of outputIds) {
        const stored = await db.get(id);
        revsOut[id] = { rev: stored._rev, sha256: sha(stored) };
      }
      const umidDocHash = sha(await db.get(`${entry.$umid}:umid`));

      const digest = ActiveCrypto.commitDigest(
        entry.$umid,
        "committed",
        entry.$revs,
        revsOut,
        umidDocHash
      );
      const attestation: ActiveDefinitions.ICommitAttestation = {
        node: reference,
        umid: entry.$umid,
        outcome: "committed",
        revsOut,
        umidDocHash,
        sig: ActiveCrypto.signDigest(
          Attestation.key as ActiveCrypto.KeyPair,
          digest
        ),
      };

      // The signed votes, so a hybrid can count the tally from this node alone
      const nodes: { [ref: string]: ActiveDefinitions.IFeedNodeVote } = {};
      for (const ref of Object.keys(entry.$nodes || {})) {
        const n = entry.$nodes[ref];
        if (n && typeof n.vote === "boolean") {
          nodes[ref] = { vote: n.vote, ...(n.sig ? { sig: n.sig } : {}) };
        }
      }
      await events.post({ _id: `attest:${entry.$umid}`, ...attestation, nodes });
    } catch (e) {
      ActiveLogger.error(e, `Commit attestation failed for ${entry.$umid}`);
    }
  }
}
