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

import { readFileSync } from "fs";
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

  /** This node's identity key (RSA). Set once by the processor at setup. */
  public static key?: ActiveCrypto.KeyPair;

  /**
   * An optional Ed25519 key for attestations, and its public PEM. Signing
   * with it costs a fraction of RSA, and the signature is a quarter of the
   * size. Set once by the processor at setup, when the node has one.
   */
  public static attestKey?: ActiveCrypto.KeyPair;
  public static attestPublic?: string;

  private static listedFor?: { list: unknown; listed: boolean };

  /**
   * The key to sign with. The Ed25519 key is used only while the network's
   * neighbourhood (setup stream, mirrored in the config) lists its public
   * key for a node: verifiers read what a node signs with from there, so a
   * key the neighbourhood does not list would produce signatures nobody can
   * check. Otherwise the identity key signs, exactly as before.
   */
  public static signer(): ActiveCrypto.KeyPair | undefined {
    const ed = Attestation.attestKey;
    if (!ed || !Attestation.attestPublic) return Attestation.key;
    const list = ActiveOptions.get<any>("neighbourhood", undefined);
    let cached = Attestation.listedFor;
    if (!cached || cached.list !== list) {
      const mine = Attestation.attestPublic.trim();
      cached = Attestation.listedFor = {
        list,
        listed:
          Array.isArray(list) &&
          list.some(
            (n: any) =>
              n?.attest?.type === "ed25519" &&
              typeof n.attest.public === "string" &&
              n.attest.public.trim() === mine
          ),
      };
    }
    return cached.listed ? ed : Attestation.key;
  }

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
        Attestation.signer() as ActiveCrypto.KeyPair,
        ActiveCrypto.voteDigest(umid, !!node.vote, revs as any)
      );
    } catch (e) {
      // An unsigned vote is still a vote: the hybrid just cannot verify it
      ActiveLogger.error(e, `Vote attestation failed for ${umid}`);
    }
  }

  /**
   * What a commit attestation is made from, read the moment the documents
   * are saved: H(umid | outcome | $revs | revsOut | umidDocHash) is signed
   * later, when a hybrid asks (see `attestation`), so a network with no
   * hybrids never signs a commit.
   *
   * The store assigns each revision in its own process and answers a write
   * with them, so `revs` (that answer) is trusted as it is: it is the
   * revision used everywhere. The sha256 is taken over the canonical JSON of
   * the document as the store holds it, which is what was sent, as JSON, with
   * that revision. Without `revs` each document is read back instead.
   *
   * It must be read here and not when asked: a stream moves on with the next
   * transaction, and an attestation built from a newer document would no
   * longer describe this commit, nor match what the other supernodes sign.
   * The signed votes are the snapshot at commit, for the same reason.
   *
   * Never fails the commit: the transaction is already saved, and an
   * attestation that is missing here can be gathered from other supernodes.
   * Undefined when attestations are off or a read fails.
   */
  public static async facts(
    db: { get(id: string): Promise<any> },
    entry: ActiveDefinitions.LedgerEntry,
    docs: { _id?: string }[],
    revs?: { [id: string]: string }
  ): Promise<ActiveDefinitions.IAttestFacts | undefined> {
    if (!Attestation.enabled()) return undefined;
    try {
      const sha = (doc: any) =>
        ActiveCrypto.Hash.getHash(ActiveCrypto.canonicalJson(doc));

      // Volatile never leaves the node, and the umid doc is hashed on its own
      const outputIds = docs
        .map((d) => d._id as string)
        .filter(
          (id) => id && !id.endsWith(":volatile") && !id.endsWith(":umid")
        );
      // As the store holds it: sent as JSON, with the revision it answered
      const held = (id: string): Promise<any> | any => {
        const sent = revs && revs[id] ? docs.find((d) => d._id === id) : undefined;
        return sent
          ? { ...JSON.parse(JSON.stringify(sent)), _rev: (revs as any)[id] }
          : db.get(id);
      };
      const revsOut: { [id: string]: ActiveDefinitions.IRevOut } = {};
      for (const id of outputIds) {
        const stored = await held(id);
        revsOut[id] = { rev: stored._rev, sha256: sha(stored) };
      }
      const umidDocHash = sha(await held(`${entry.$umid}:umid`));

      // The signed votes, so a hybrid can count the tally from this node alone
      const nodes: { [ref: string]: ActiveDefinitions.IFeedNodeVote } = {};
      for (const ref of Object.keys(entry.$nodes || {})) {
        const n = entry.$nodes[ref];
        if (n && typeof n.vote === "boolean") {
          nodes[ref] = { vote: n.vote, ...(n.sig ? { sig: n.sig } : {}) };
        }
      }
      return { revsOut, umidDocHash, nodes };
    } catch (e) {
      ActiveLogger.error(e, `Commit attestation facts failed for ${entry.$umid}`);
      return undefined;
    }
  }

  /**
   * Sign this node's commit attestation from the facts kept at commit.
   * Deterministic for the same facts, so it can be made again whenever it is
   * wanted. Undefined when this node cannot sign.
   */
  public static attestation(
    reference: string,
    umid: string,
    revs: ActiveDefinitions.LedgerRevs,
    facts: ActiveDefinitions.IAttestFacts
  ): ActiveDefinitions.ICommitAttestation | undefined {
    const signer = Attestation.signer();
    if (!signer) return undefined;
    try {
      return {
        node: reference,
        umid,
        outcome: "committed",
        revsOut: facts.revsOut,
        umidDocHash: facts.umidDocHash,
        sig: ActiveCrypto.signDigest(
          signer,
          ActiveCrypto.commitDigest(umid, "committed", revs, facts.revsOut, facts.umidDocHash)
        ),
      };
    } catch (e) {
      ActiveLogger.error(e, `Commit attestation failed for ${umid}`);
      return undefined;
    }
  }

  /**
   * Load the optional Ed25519 attestation key kept beside the identity.
   * Without a readable identity file, or one that has none, the identity key
   * signs.
   */
  public static useIdentityFile(file: string): void {
    try {
      const id = JSON.parse(readFileSync(file, "utf8"));
      if (id?.attest?.prv?.pkcs8pem && id.attest.pub?.pkcs8pem) {
        Attestation.attestKey = new ActiveCrypto.KeyPair("ed25519", id.attest.prv.pkcs8pem);
        Attestation.attestPublic = id.attest.pub.pkcs8pem;
      }
    } catch {
      // No readable identity file here: sign with the identity key
    }
  }
}
