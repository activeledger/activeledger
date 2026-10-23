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

import { ActiveLogger } from "@activeledger/activelogger";
import { bulkWriteFailed, revPosition } from "@activeledger/activesync";
import type { HybridStore, Sources, StreamLookup } from "./types";
import type { Upstream } from "./upstream";
import { docHash } from "./verify";

/** The store calls lookup needs (EmbeddedDSConnect or a fake) */
export type DocStore = Pick<HybridStore["data"], "get" | "bulkDocs">;

/** A stored document, or undefined when the store does not hold it */
export async function readDoc(db: Pick<DocStore, "get">, id: string): Promise<any | undefined> {
  try {
    const doc = await db.get(id);
    return doc && doc._id ? doc : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a document with the network's revision, choosing the write mode
 * from what is held, exactly as restore's quick-restore does:
 *
 * - absent: new_edits:false, the only mode that keeps the given revision on
 *   a create;
 * - present on another revision: new_edits:true + force_rev, the only
 *   combination LevelMe allows to overwrite a divergent document;
 * - present on the same revision: nothing to do.
 *
 * Resolves false when the store did not confirm the write.
 */
export async function writeAtRev(db: DocStore, doc: any): Promise<boolean> {
  if (!doc || typeof doc._id !== "string" || typeof doc._rev !== "string") return false;
  const local = await readDoc(db, doc._id);
  let r: any;
  try {
    if (!local || !local._rev) {
      r = await db.bulkDocs([doc], { new_edits: false });
    } else if (local._rev !== doc._rev) {
      r = await db.bulkDocs([doc], { new_edits: true, force_rev: doc._rev });
    } else {
      return true;
    }
  } catch (e) {
    ActiveLogger.error(e, `Write of ${doc._id}@${doc._rev} threw`);
    return false;
  }
  return !bulkWriteFailed(r);
}

/**
 * A `$revs` value is `<meta _rev>:<state _rev>` (permissionsChecker); a bare
 * value is a state revision.
 */
export function splitRev(rev?: string): { state?: string; meta?: string } {
  if (!rev) return {};
  const i = rev.indexOf(":");
  return i === -1 ? { state: rev } : { meta: rev.slice(0, i), state: rev.slice(i + 1) };
}

export interface SourceLookupOptions {
  store: Pick<HybridStore, "data">;
  /** Where to fetch from. A function, so a changing peer set is seen. */
  sources: Sources | (() => Sources);
}

interface Want {
  id: string;
  state?: string;
  meta?: string;
  sha256?: string;
  /** sha256 of the `:stream` meta, from the signed revsOut */
  metaSha256?: string;
}

/**
 * Gets streams into the local store from hybrid peers, then supernodes.
 * Every document is written byte-for-byte with the network's revision; a
 * state document whose sha256 does not match an expected one is never
 * written, and a source that fails is skipped for the next.
 */
export class SourceLookup implements StreamLookup {
  constructor(private readonly options: SourceLookupOptions) {}

  private get db(): DocStore {
    return this.options.store.data;
  }

  private sources(): Sources {
    const s = this.options.sources;
    return typeof s === "function" ? s() : s;
  }

  /** True when the local copy is already exactly what is wanted */
  private async held(w: Want): Promise<boolean> {
    const state = await readDoc(this.db, w.id);
    if (!state) return false;
    if (w.state && state._rev !== w.state) return false;
    if (w.sha256 && docHash(state) !== w.sha256) return false;
    if (w.meta) {
      const meta = await readDoc(this.db, `${w.id}:stream`);
      if (!meta || meta._rev !== w.meta) return false;
    }
    return true;
  }

  public async ensure(
    wanted: { id: string; rev?: string; sha256?: string; metaSha256?: string }[]
  ): Promise<{ missing: string[] }> {
    const need: Want[] = [];
    const seen = new Set<string>();
    for (const w of wanted) {
      if (!w || typeof w.id !== "string" || seen.has(w.id)) continue;
      seen.add(w.id);
      const want: Want = { id: w.id, ...splitRev(w.rev), sha256: w.sha256, metaSha256: w.metaSha256 };
      if (!(await this.held(want))) need.push(want);
    }
    if (!need.length) return { missing: [] };

    const { peers, supernodes } = this.sources();
    let remaining = need;
    for (const source of [...peers, ...supernodes]) {
      if (!remaining.length) break;
      remaining = await this.fetchFrom(source, remaining, peers.includes(source));
    }
    return { missing: remaining.map((w) => w.id) };
  }

  /**
   * Ask one source for the wanted streams at their revisions. Resolves with
   * those still not had.
   */
  private async fetchFrom(source: Upstream, wants: Want[], isPeer: boolean): Promise<Want[]> {
    // A peer is not trusted: it may only supply a stream whose state AND meta
    // can be checked against signed hashes. Anything else (inputs, which no
    // signed hash covers) comes from a supernode.
    if (isPeer) {
      const checkable = wants.filter((w) => w.sha256 && w.metaSha256);
      if (!checkable.length) return wants;
      const rest = wants.filter((w) => !(w.sha256 && w.metaSha256));
      return [...rest, ...(await this.fetchFrom0(source, checkable, true))];
    }
    return this.fetchFrom0(source, wants, false);
  }

  private async fetchFrom0(source: Upstream, wants: Want[], isPeer: boolean): Promise<Want[]> {
    let answer: { docs: any[] };
    try {
      answer = await source.streams(wants.map((w) => (w.state ? { id: w.id, rev: w.state } : { id: w.id })));
    } catch (e) {
      ActiveLogger.warn(`Lookup: ${source.id} could not answer: ${(e as Error)?.message || e}`);
      return wants;
    }
    const byId = new Map<string, any>();
    for (const d of Array.isArray(answer?.docs) ? answer.docs : []) {
      if (d && typeof d._id === "string") byId.set(d._id, d);
    }

    const left: Want[] = [];
    for (const w of wants) {
      const state = byId.get(w.id);
      const meta = byId.get(`${w.id}:stream`);
      const volatile = byId.get(`${w.id}:volatile`);
      const reason = !state
        ? "not served"
        : w.state && state._rev !== w.state
          ? `revision ${state._rev}, wanted ${w.state}`
          : w.sha256 && docHash(state) !== w.sha256
            ? "sha256 does not match"
            : w.meta && (!meta || meta._rev !== w.meta)
              ? `meta revision ${meta?._rev}, wanted ${w.meta}`
              : isPeer && (!meta || docHash(meta) !== w.metaSha256)
                ? "meta sha256 does not match"
                : "";
      if (reason) {
        if (state) ActiveLogger.warn(`Lookup: ${source.id} ${w.id}: ${reason}`);
        left.push(w);
        continue;
      }
      // Meta first: a reader that finds the state finds its meta too
      let ok = true;
      for (const doc of [meta, state]) {
        if (doc && !(await writeAtRev(this.db, doc))) ok = false;
      }
      // Volatile is per node and unsigned: only a supernode may supply it
      if (ok && volatile && !isPeer) await writeAtRev(this.db, volatile);
      if (!ok) left.push(w);
    }
    return left;
  }

  /**
   * Refresh to the upstream tip, from supernodes only: a tip has no signed
   * hash to check a peer's copy against. A tip behind the local copy never
   * replaces it.
   */
  public async refreshToTip(ids: string[]): Promise<{ missing: string[] }> {
    const { supernodes } = this.sources();
    let remaining = [...new Set(ids.filter((id) => typeof id === "string" && id))];
    for (const source of supernodes) {
      if (!remaining.length) break;
      let answer: { docs: any[] };
      try {
        answer = await source.streams(remaining.map((id) => ({ id })));
      } catch (e) {
        ActiveLogger.warn(`Refresh: ${source.id} could not answer: ${(e as Error)?.message || e}`);
        continue;
      }
      const byId = new Map<string, any>();
      for (const d of Array.isArray(answer?.docs) ? answer.docs : []) {
        if (d && typeof d._id === "string") byId.set(d._id, d);
      }
      const left: string[] = [];
      for (const id of remaining) {
        const state = byId.get(id);
        if (!state || typeof state._rev !== "string") {
          left.push(id);
          continue;
        }
        const local = await readDoc(this.db, id);
        if (local && revPosition(local._rev) > revPosition(state._rev)) continue;
        let ok = true;
        for (const doc of [byId.get(`${id}:stream`), state]) {
          if (doc && !(await writeAtRev(this.db, doc))) ok = false;
        }
        const volatile = byId.get(`${id}:volatile`);
        if (ok && volatile) await writeAtRev(this.db, volatile);
        if (!ok) left.push(id);
      }
      remaining = left;
    }
    return { missing: remaining };
  }
}
