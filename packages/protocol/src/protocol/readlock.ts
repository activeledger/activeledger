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
import { ActiveOptions } from "@activeledger/activeoptions";

/**
 * Read locks on activity streams: which namespaces may read a part of a
 * stream from contract code (`$r`, getAnyStreamReadOnly, getVolatile).
 *
 * The caller's namespace is the transaction's, which the engine ties to the
 * contract that runs (Process.NAMESPACE_BINDING_BUILD), so this needs that
 * build level too.
 */
export class ReadLock {
  /** Build level from which read locks are enforced */
  public static readonly BUILD = 50600;

  /** The meta fields that lock a stream. Fixed when the stream is created */
  public static readonly FIELDS = [
    "ns",
    "readLock",
    "contractlock",
    "namespaceLock",
  ] as const;

  /**
   * Which lock fields differ between the meta a stream was loaded with and
   * the meta about to be written. Only fields the stream had or has.
   *
   * @param {ActiveDefinitions.IMeta | undefined} loaded
   * @param {ActiveDefinitions.IMeta | undefined} written
   * @returns {string[]}
   */
  public static changed(
    loaded: ActiveDefinitions.IMeta | undefined,
    written: ActiveDefinitions.IMeta | undefined
  ): string[] {
    return ReadLock.FIELDS.filter(
      (field) =>
        JSON.stringify((loaded as any)?.[field]) !==
        JSON.stringify((written as any)?.[field])
    );
  }

  public static enabled(): boolean {
    return ActiveOptions.get<number>("build", 0) >= ReadLock.BUILD;
  }

  /**
   * Split a document id into its stream and the part of it being read
   *
   * @param {string} id
   */
  public static split(id: string): {
    stream: string;
    part: "state" | "stream" | "volatile";
  } {
    const at = id.indexOf(":");
    if (at === -1) return { stream: id, part: "state" };
    const suffix = id.substring(at + 1);
    return {
      stream: id.substring(0, at),
      part:
        suffix === "volatile" ? "volatile" : suffix === "stream" ? "stream" : "state",
    };
  }

  /**
   * May this namespace read this part of the stream?
   *
   * @param {ActiveDefinitions.IMeta | undefined} meta The stream's `:stream` document
   * @param {"state" | "stream" | "volatile"} part
   * @param {string} namespace The namespace of the contract that reads
   */
  public static allowed(
    meta: ActiveDefinitions.IMeta | undefined,
    part: "state" | "stream" | "volatile",
    namespace: string | undefined
  ): boolean {
    const lock = meta?.readLock;
    // No lock: as it always was
    if (!lock) return true;
    // The node's own contracts, and the namespace that made the stream
    if (namespace === "default" || (namespace && namespace === meta?.ns)) {
      return true;
    }
    const who = lock[part];
    if (who === undefined) return part !== "volatile";
    if (who === "*") return true;
    return !!namespace && Array.isArray(who) && who.indexOf(namespace) !== -1;
  }

  /**
   * A private copy of the lock fields (ReadLock.FIELDS) of the streams a transaction
   * has loaded (`$i` / `$o`), taken before the contract runs. The contract is
   * handed the very meta objects it was loaded from, so a lookup over those
   * would trust whatever the contract has since written into them. A read of
   * one of these streams costs no extra read of its meta.
   *
   * @param {ActiveDefinitions.LedgerStream[][]} loaded
   */
  public static snapshot(
    ...loaded: Array<ActiveDefinitions.LedgerStream[] | undefined>
  ): (stream: string) => ActiveDefinitions.IMeta | undefined {
    const locks = new Map<string, ActiveDefinitions.IMeta>();
    for (const list of loaded) {
      for (const item of list || []) {
        const id = item?.state?._id;
        if (typeof id !== "string" || !item.meta) continue;
        const meta: any = item.meta;
        const copy: any = {};
        for (const field of ReadLock.FIELDS) {
          if (meta[field] !== undefined) copy[field] = structuredClone(meta[field]);
        }
        locks.set(id, copy as ActiveDefinitions.IMeta);
      }
    }
    return (stream: string) => locks.get(stream);
  }

  /**
   * A read made by contract code. Refuses it when the stream's read lock does
   * not allow the namespace, and otherwise returns the document, as db.get
   * would. The lock lives in the stream's `:stream` document, so the meta is
   * fetched with the document in one call, taken from the transaction's own
   * `$i` / `$o` when it is already there, or is the document itself. Nothing
   * is checked below the build level or for the default namespace.
   *
   * @param {{ get(id: string): Promise<any>; allDocs?(options: any): Promise<any> }} db
   * @param {string} id The document the contract asked for
   * @param {string | undefined} namespace The transaction's namespace
   * @param {(stream: string) => ActiveDefinitions.IMeta | undefined} [known]
   */
  public static async read(
    db: {
      get(id: string): Promise<any>;
      allDocs?(options: any): Promise<any>;
    },
    id: string,
    namespace: string | undefined,
    known?: (stream: string) => ActiveDefinitions.IMeta | undefined
  ): Promise<any> {
    if (!ReadLock.enabled() || namespace === "default") return db.get(id);

    const { stream, part } = ReadLock.split(id);
    const metaId = `${stream}:stream`;
    const refuse = () => {
      throw new Error("Stream read locked");
    };

    // Already loaded for this transaction
    const loaded = known?.(stream);
    if (loaded) {
      if (!ReadLock.allowed(loaded, part, namespace)) refuse();
      return db.get(id);
    }

    // The meta is what was asked for
    if (id === metaId) {
      const doc = await db.get(id);
      if (!ReadLock.allowed(doc, "stream", namespace)) refuse();
      return doc;
    }

    // Both in one call (one round trip to storage)
    let doc: any;
    let meta: ActiveDefinitions.IMeta | undefined;
    let paired = false;
    if (db.allDocs) {
      try {
        const rows = (await db.allDocs({ keys: [id, metaId], include_docs: true }))
          ?.rows;
        if (Array.isArray(rows)) {
          paired = true;
          for (const row of rows) {
            if (row?.doc?._id === id) doc = row.doc;
            else if (row?.doc?._id === metaId) meta = row.doc;
          }
        }
      } catch {
        // Fall back to separate reads
      }
    }
    if (!paired) {
      meta = await db.get(metaId).catch(() => undefined);
    }
    // No stream document, nothing to lock (a miss is reported by the read)
    if (meta && !ReadLock.allowed(meta, part, namespace)) refuse();
    return doc || db.get(id);
  }
}
