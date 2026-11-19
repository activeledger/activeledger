import { createHash } from "crypto";
import * as fs from "fs";
import {
  createWriteStream,
  createReadStream,
} from "fs";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";
import { newLineTransform } from "./newlinestream";
import { ActiveCacheManager, ActiveCache } from "@activeledger/activeoptions";
import { ActiveClone } from "@activeledger/activeutilities";
import { IStorageDriver } from "./driver";
import { LevelDBDriver } from "./drivers/leveldb";
import { DEFAULT_PAGE_LIMIT, PAGE_BUDGET_MS, PrunePage, PruneRequest, RESENT_ID, idRange, idTime } from "./prune";
import { LevelUpChain } from "levelup";

/**
 * Generic Data Document
 *
 * @interface document
 */
interface document {
  _id: string;
  _rev?: string | null;
  [key: string]: any;
}

/**
 * All Doc searching options
 *
 * @interface allDocOptions
 */
interface allDocOptions {
  startkey?: string;
  endkey?: string;
  limit?: number;
  skip?: number;
  keys?: string[];
  include_docs?: boolean;
}

/**
 * change doc options
 *
 * @interface changesOptions
 */
interface changesOptions {
  since?: number | "now";
  live?: boolean;
  limit?: number;
  descending?: boolean;
  include_docs?: boolean;
}

/**
 * Root document schema for tracking changes
 *
 * @interface schema
 * @extends {document}
 */
interface schema extends document {
  _rev: string;
}

/**
 * LevelUP Wrapper for Activeledger with PouchDB legacy support
 *
 * @export
 * @class LevelMe
 */
export class LevelMe {
  /**
   * Documents are gzipped on write only above this size. The :umid document
   * carries the whole transaction and its signatures, so a couple of KB is
   * ordinary, and gzipping each on the libuv threadpool (shared with LevelDB
   * itself) on write and again on read cost more than the disk it saved: the
   * database compresses its blocks anyway. Reads see a flag byte, so old and
   * new documents mix freely.
   */
  private static readonly COMPRESS_ABOVE = 16 * 1024;

  /**
   * PouchDb Legacy Support
   * Database metadata key
   *
   * ÿ is xff unicode, Character code 255
   *
   * @private
   * @static
   */
  private static META_PREFIX = "ÿmeta-storeÿ"; // \xff charcode 255

  /**
   * PouchDb Legacy Support
   * Document metadata key
   *
   * ÿ is xff unicode, Character code 255
   *
   * @private
   * @static
   */
  private static DOC_PREFIX = "ÿdocument-storeÿ";

  /**
   * Field of a stored state record that carries the stream's `:stream` meta
   * document with it (db.selfhost.merge). One key, one read and one write
   * serve both; every read still hands back two documents.
   */
  private static MERGED = "ÿm";
  private static STREAM_SUFFIX = ":stream";

  /**
   * PouchDb Legacy Support
   * Database value key
   *
   * ÿ is xff unicode, Character code 255
   *
   * ÿby-sequenceÿ0000000000000110
   *
   * @private
   * @static
   */
  private static SEQ_PREFIX = "ÿby-sequenceÿ";

  /**
   * Warning: Not backwards compatible
   * Different way to store sequence documents. Its like an index but without needing the indexers.
   * While upgrading the change log will "start from here" there is no evidence that this will cause an issue as
   * it was never really an exposed feature of Activeledger just "per node specific" write data.
   *
   * ÿ is xff unicode, Character code 255
   *
   * @private
   * @static
   */
  //private static SEQ_META_PREFIX = "ÿsequence-storeÿ";

  /**
   * Live changes emitter
   *
   * @private
   * @static
   */
  private changeEmitter = new EventEmitter();

  private driver: IStorageDriver;

  /**
   * Read cache. Only present when this database was opened with the cache
   * switched on (db.selfhost.cache); every use below is guarded by it, so a
   * store without one behaves exactly as if each read went to disk.
   */
  private cache?: ActiveCache;

  private openingPromise: Promise<void> | null = null;

  /** State and `:stream` meta held as one record (the ledger database only) */
  private merge = false;

  /**
   * @param location Data directory prefix
   * @param name Database name
   * @param provider Storage driver
   * @param cache Keep a 30 s read cache for this database. Off by default:
   * the cache measured a ~0.5% hit rate on a busy node and held hundreds of
   * MB of documents and timers, and a database that is never read by key
   * (events, errors) should never be given one.
   */
  constructor(
    location: string,
    private name: string,
    provider: string,
    cache = false
  ) {
    this.driver = new LevelDBDriver(location + name, provider, /(event|error)/i.test(name));
    this.merge = process.env.ACTIVE_STORAGE_MERGE === "1" && !/(event|error)/i.test(name);
    if (cache) {
      this.cache = ActiveCacheManager.fetch(`streams:${this.name}`, 30000);
    }
  }


  /**
   * Jump straight to the cached wining branch end
   *
   * @private
   * @param {schema} doc
   * @returns {string}
   */
  private findCachedBranchEnd(doc: schema): string {
    return doc.rev_map[doc.winningRev].toString().padStart(16, "0");
  }

  /**
   * Gets the latest sequence data document, resolving old rev-tree-format
   * root documents (winningRev/rev_map/rev_tree/seq) down to their actual
   * data document. New-format documents are already the data document, so
   * this is a no-op for them - kept for backwards compatibility with data
   * written before the rev-tree model was dropped.
   *
   * @private
   * @param {schema} doc
   * @returns {Promise<document>}
   */
  private async seqDocFromRoot(doc: schema): Promise<document> {
    if (doc.winningRev && doc.rev_map && doc.rev_tree && doc.seq) {
      const twig = this.findCachedBranchEnd(doc);
      try {
        await this.open();
        return (await ActiveClone.deserialize(
          await this.driver.get(LevelMe.SEQ_PREFIX + twig)
        )) as document;
      } catch {
        return {} as document;
      }
    } else {
      return doc as document;
    }
  }

  /**
   * Opens the database and caches the metadata
   *
   * @private
   */
  private async open(): Promise<void> {
    if (this.openingPromise) {
      return this.openingPromise;
    }

    if (!this.driver.isOpen()) {
      this.openingPromise = (async () => {
        try {
          await this.driver.open();
        } catch (e) {
          throw e;
        } finally {
          this.openingPromise = null;
        }
      })();
      return this.openingPromise;
    }
  }

  /**
   * Fetches information about the database or creates a new database
   *
   * @returns
   */
  public async info() {
    try {
      await this.open();
      return {
        doc_count: "----",
        update_seq: 0,
        db_name: this.name,
        data_size: 0,
      };
    } catch (e) {
      // TODO Filter bad / unexpected creates such as favicon.ico
      return {
        doc_count: "----",
        update_seq: 0,
        db_name: this.name,
        data_size: 0,
      };
    }
  }

  /**
   * Close the underlying leveldb connction
   *
   */
  public async close() {
    // A database nothing ever opened has nothing to close
    if (!this.driver.isOpen()) {
      return;
    }
    await this.driver.close();
  }

  /**
   * Backup this database
   *
   * @param {string} [filename]
   */
  public async backup(filename?: string) {
    if (!filename) {
      filename = `${Date.now()}.alb`;
    }
    await fs.promises.writeFile(`${filename}.status`, filename);
    const writer = createWriteStream(filename);

    return new Promise((resolve, reject) => {
      // Values are stored serialised (binary), not as text, so each one is
      // written as the JSON of its document, one per line - what restore()
      // reads back. Kept in stream order.
      let queue: Promise<void> = Promise.resolve();
      writer.on("error", reject);
      this.driver
        .createValueStream()
        .on("data", (data: any) => {
          queue = queue.then(async () => {
            const doc = await ActiveClone.deserialize(data);
            writer.write(JSON.stringify(doc) + "\n");
          });
          // Reported by the end handler
          queue.catch(() => { });
        })
        .on("error", reject)
        .on("end", async () => {
          try {
            await queue;
            // Resolve only once the file is fully written
            await new Promise<void>((done, fail) => {
              writer.on("error", fail);
              writer.end(done);
            });
            await fs.promises.unlink(`${filename}.status`);
            resolve(undefined);
          } catch (err) {
            reject(err);
          }
        });
    });
  }

  /**
   * Restore (overwriting) to this database
   *
   * @param {string} filename
   */
  public async restore(filename: string) {
    await fs.promises.writeFile(`${filename}.status`, "running");

    return new Promise((resolve, reject) => {
      // Writes run one after another so the restore has finished when this
      // resolves, not merely when the file has been read
      let queue: Promise<void> = Promise.resolve();
      const reader = createReadStream(filename);
      // pipe() does not forward a source's errors (a missing file)
      reader.on("error", reject);
      reader
        .pipe(newLineTransform())
        .on("data", (data: Buffer) => {
          queue = queue.then(async () => {
            try {
              const doc = JSON.parse(data.toString());
              ActiveLogger.info(`Restoring ${doc._id}`);
              if (!(await this.bulkDocs([doc], { new_edits: true }))) {
                throw new Error("write failed");
              }
            } catch {
              ActiveLogger.warn(`Restoring FAILED`);
            }
          });
        })
        .on("error", reject)
        .on("end", async () => {
          try {
            await queue;
            await fs.promises.unlink(`${filename}.status`);
            resolve(undefined);
          } catch (err) {
            reject(err);
          }
        });
    });
  }

  // public async restore() {
  //   await this.open();
  //   this.driver
  //     .createReadStream()
  //     .pipe(JSONStream.stringify("", "", ""))
  //     .pipe(createWriteStream("./backup.txt"));

  //   createReadStream("backup.txt")
  //     .pipe(JSONStream.parse())
  //     .pipe(this.driver.createKeyStream);
  // }

  /**
   * Returns all the data documents with filter options
   *
   * @param {allDocOptions} options
   * @returns {Promise<unknown>}
   */
  public allDocs(options: allDocOptions): Promise<unknown> {
    return new Promise(async (resolve, reject) => {
      try {
        const offset = parseInt(options.skip?.toString() || "0");
        await this.open();

        // Cache rows to be returned
        let rows: any[] = [];

        if (options.keys) {
          const docs = await this.getMany(options.keys);
          rows = docs.map(doc => ({ doc }));
          return resolve({
            total_rows: docs.length,
            offset,
            rows,
          });
        } else {
          // No offset built in, Create one by skip + limit and counter on skip;
          let limit = options.limit || -1;
          if (options.skip && limit !== -1) {
            // Convert to int
            options.skip = parseInt(options.skip as unknown as string);
            limit += options.skip;
          }

          // Read / Search the database as a stream
          const stream = this.driver.createReadStream({
            gte: LevelMe.DOC_PREFIX + (options.startkey || ""),
            lt: options.endkey
              ? LevelMe.DOC_PREFIX + options.endkey
              : LevelMe.META_PREFIX,
            limit,
          });

          // Track pending deserialization promises in stream order
          const docPromises: Promise<any>[] = [];

          stream.on("data", (data: { key: string; value: Buffer }) => {
            // Filter out the "skipped" keys
            if (options.skip) {
              options.skip--;
              return;
            }

            // Push the promise into the array to maintain order
            const row = (doc: any) => {
              if (options.include_docs) {
                return doc;
              } else {
                return {
                  _id: doc._id, // Compatibility Trick
                  id: doc._id,
                  key: doc._id,
                  // CouchDB's row shape, which /a/all (and so activerestore)
                  // reads the revision from
                  value: { rev: doc._rev },
                };
              }
            };
            const pending = ActiveClone.deserialize(data.value).then((doc: any) => {
              // A record holding state and meta is two rows
              if (this.merge && doc && doc[LevelMe.MERGED] !== undefined) {
                const { state, meta } = LevelMe.split(doc);
                return [row(state), row(meta)];
              }
              return row(doc);
            });
            // The end handler reports a failure; this only stops a rejection
            // that lands before the stream ends counting as unhandled
            pending.catch(() => { });
            docPromises.push(pending);
          })
            .on("error", (err: unknown) => {
              stream.destroy();
              reject(err);
            })
            .on("end", async () => {
              // Await all promises in the original stream order. A damaged
              // value rejects here, which must reach the caller - this is an
              // event handler, so nothing else would ever catch it.
              try {
                const rows = (await Promise.all(docPromises)).flat();
                resolve({
                  total_rows: rows.length,
                  offset,
                  rows,
                });
              } catch (e) {
                reject(e);
              }
            });        }
      } catch (e) {
        reject(e);
      }
    });
  }
  /**
   * Get a specific data document
   *
   * @param {string} key
   * @returns
   */
  public async get(key: string, raw = false) {
    if (this.cache) {
      // raw and non-raw reads store different shapes for the same id, so
      // they need distinct cache keys or one mode poisons the other.
      const cacheKey = raw ? `raw:${key}` : key;
      if (!this.cache.has(cacheKey)) {
        await this.open();
        // Allow errors to bubble up?
        const doc = (this.merge ? await this.getLogical(key) : await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key))) as any;
        if (raw) {
          this.cache.set(cacheKey, doc);
        } else {
          this.cache.set(cacheKey, await this.seqDocFromRoot(doc));
        }
      }
      return this.cache.get(cacheKey, 30000);
    } else {
      await this.open();
      // Allow errors to bubble up?
      const doc = (this.merge ? await this.getLogical(key) : await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key))) as any;
      if (raw) {
        return doc;
      } else {
        return await this.seqDocFromRoot(doc);
      }
    }
  }


  /**
   * Splits a stored record into the two documents it holds.
   */
  private static split(rec: any): { state: any; meta?: any } {
    if (rec && rec[LevelMe.MERGED] !== undefined) {
      const { [LevelMe.MERGED]: meta, ...state } = rec;
      return { state, meta };
    }
    return { state: rec };
  }

  /**
   * One document as callers see it, from a store that may hold the state and
   * meta together. A meta not found inside its state's record is looked for
   * under its own key, which is where data from before the merge lives.
   */
  private async getLogical(key: string): Promise<any> {
    if (key.endsWith(LevelMe.STREAM_SUFFIX)) {
      const base = key.slice(0, -LevelMe.STREAM_SUFFIX.length);
      const raw = await this.driver.getOrUndefined!(LevelMe.DOC_PREFIX + base);
      if (raw !== undefined) {
        const { meta } = LevelMe.split(await ActiveClone.deserialize(raw));
        if (meta) return meta;
      }
    }
    return LevelMe.split(await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key))).state;
  }

  /**
   * getMany() for a store holding state and meta together: reads each state
   * record once for the pair.
   */
  private async getManyMerged(keys: string[]): Promise<any[]> {
    const source = (key: string) => key.endsWith(LevelMe.STREAM_SUFFIX) ? key.slice(0, -LevelMe.STREAM_SUFFIX.length) : key;
    const ids = [...new Set(keys.map(source))];
    const result = await this.driver.getMany(ids.map((id) => LevelMe.DOC_PREFIX + id));
    const recs = new Map<string, any>();
    const decoded = await Promise.all(result.map((raw: any) => raw === undefined || raw === null ? undefined : (ActiveClone.deserialize(raw) as Promise<any>)));
    ids.forEach((id, i) => { if (decoded[i]) recs.set(id, decoded[i]); });

    // A meta the record does not carry may still sit under its own key
    const legacy: string[] = [];
    for (const key of keys) {
      if (key.endsWith(LevelMe.STREAM_SUFFIX) && !recs.get(source(key))?.[LevelMe.MERGED]) legacy.push(key);
    }
    const old = new Map<string, any>();
    if (legacy.length) {
      const got = await this.driver.getMany(legacy.map((id) => LevelMe.DOC_PREFIX + id));
      const dec = await Promise.all(got.map((raw: any) => raw === undefined || raw === null ? undefined : (ActiveClone.deserialize(raw) as Promise<any>)));
      legacy.forEach((id, i) => { if (dec[i]) old.set(id, dec[i]); });
    }

    const docs: any[] = [];
    for (const key of keys) {
      const rec = recs.get(source(key));
      let doc: any;
      if (key.endsWith(LevelMe.STREAM_SUFFIX)) doc = rec?.[LevelMe.MERGED] ?? old.get(key);
      else doc = rec ? LevelMe.split(rec).state : undefined;
      if (!doc || !doc._id) continue;
      if (this.cache) this.cache.set(doc._id, doc);
      docs.push(doc);
    }
    return docs;
  }

  public async getMany(keys: string[]): Promise<any[]> {
    // All from cache, or all from disk - never a mixture.
    //
    // This used to serve whichever keys happened to be warm from the cache
    // and fetch the rest from the driver. For one key that is just a cache;
    // across several it silently breaks the one property a multi-key read
    // is worth having, because the two halves are read at different times.
    // The cache probe is synchronous but the driver read is awaited, so a
    // batch write can land in between - and a caller asking for a stream
    // and its :stream meta together could get the cached state from before
    // that write paired with the meta from after it. A commit writes both
    // in ONE batch precisely so no reader sees half of it; mixing sources
    // hands back exactly the torn pair the batch existed to prevent, and a
    // mismatched meta._rev:state._rev is not repairable afterwards.
    //
    // So: if every key is warm, answer from the cache - consistent, because
    // nothing can mutate it between synchronous reads. Otherwise read the
    // whole set from the driver in a single getMany, which cannot straddle
    // a batch. The cost is re-reading a warm key when a sibling is cold,
    // which is one extra key in an existing call.
    //
    // With the cache off (the default) there is no cache to probe and every
    // call takes the single driver read below - the same consistency, with
    // nothing warm to be torn against.
    const cache = this.cache;
    if (cache && keys.every((key) => cache.has(key))) {
      // No defensive copy, matching the driver path below and the previous
      // behaviour - Activity.getState() (contracts/stream.ts) deep-clones
      // before any contract sees state, so this was never load-bearing.
      return keys.map((key) => cache.get(key, 30000));
    }

    if (this.merge) {
      return this.getManyMerged(keys);
    }

    const prefixed = keys.map((key) => LevelMe.DOC_PREFIX + key);
    const result = await this.driver.getMany(prefixed);

    // Ungzip/decode the documents together (a gzipped one is a threadpool
    // hop), then keep the order of the keys as before.
    const decoded = await Promise.all(
      result.map((raw: any) =>
        // A key this node does not hold comes back undefined. Deserializing
        // that threw, so a single absent stream failed the whole read - and
        // SPI asks about streams a node may legitimately not have.
        raw === undefined || raw === null
          ? undefined
          : (ActiveClone.deserialize(raw) as Promise<any>)
      )
    );
    const docs: any[] = [];
    for (const data of decoded) {
      if (!data || !data._id) {
        continue;
      }
      if (this.cache) {
        this.cache.set(data._id, data);
      }
      docs.push(data);
    }
    return docs;
  }

  /**
   * Get a specific sequence document
   *
   * @param {string} seq
   * @returns
   */
  public async getSeq(seq: string) {
    return this.driver.get(LevelMe.SEQ_PREFIX + seq);
  }

  /**
   * Compact the database to reduce storage space
   *
   * Will keep compact for now, Will later update to compact direct written files no more sequence
   *
   * @returns
   */
  public compact(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // No definition as of yet, So lets check it exists
      //@ts-ignore
      if (this.driver.compactRange) {
        // We could range everything with null, null but only the sequence files create the mass storage
        // so as a performance trade off we will only compact across that range

        //@ts-ignore
        this.driver.compactRange(
          `${LevelMe.SEQ_PREFIX}0000000000000000`,
          `${LevelMe.SEQ_PREFIX}9999999999999999`
        ).then(resolve).catch(reject);
      } else {
        reject("Compact Range not found");
      }
    });
  }

  /**
   * Writes a data document (following sequences and revision information)
   *
   * @param {document} doc
   * @returns
   */
  public async post(doc: document) {
    const writer = await this.prepareForWrite(doc, await this.driver.batch());
    try {
      await writer.chain.write();
      if (this.cache) {
        // Raw root doc shares its cache key with get(key, true) - the write
        // just committed exactly this shape, safe to reuse directly.
        this.cache.set(`raw:${writer.changes.id}`, writer.changes.doc);
        // The resolved (non-raw) shape may need seqDocFromRoot (old-format
        // backward-compat data) - don't assume raw === resolved, just drop
        // the stale entry so the next non-raw get() recomputes it.
        this.cache.delete(writer.changes.id);
      }
    } catch (e) {
      // Real write failure - every caller up the stack (streamUpdater.ts,
      // shared.ts's storeError(), selfhost.ts's own POST handler) already
      // has a try/catch written expecting post() to reject on failure; it
      // was just unreachable dead code because this used to always resolve
      // { ok: true } regardless. May contain multiple documents, Easier &
      // safer to clear the cache.
      this.cache?.clear();
      throw e;
    }

    // Emit outside the try/catch, same reasoning as bulkDocs() - a
    // listener's own bug should never be able to masquerade as this write
    // having failed. EventEmitter doesn't isolate a listener's own thrown
    // exception by default though, so this is its own try/catch too -
    // otherwise a listener throwing would propagate straight out and
    // reject this call, the same class of bug being fixed here.
    this.emitChange(writer.changes);

    return {
      ok: true,
      id: doc._id,
      rev: writer.rev,
    };
  }

  public async writeRaw(key: string, value: unknown) {
    await this.open();
    const result = await this.driver.put(LevelMe.DOC_PREFIX + key, await ActiveClone.serialize(value, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
    if (this.cache) {
      // Whatever was cached for this key is not what is on disk any more
      this.cache.delete(key);
      this.cache.delete(`raw:${key}`);
    }
    return result;
  }

  /**
   * Alias for post, Legacy from PouchDb
   *
   * @param {(document | unknown)} doc
   * @returns
   */
  public async put(doc: document | unknown) {
    return await this.post(doc as document);
  }

  /**
   * Deletes a data / sequence / meta document
   * Warning: Shouldn't be so easy to call this
   *
   * @param {string} key
   * @returns
   */
  public async del(key: string): Promise<void> {
    await this.open();
    const batch = await this.driver.batch();

    // For now just delete the document key (not sequence)
    // _local_doc_count need to reduce count
    if (this.merge && key.endsWith(LevelMe.STREAM_SUFFIX)) {
      // The meta may be inside its state's record: write the record back without it
      const base = LevelMe.DOC_PREFIX + key.slice(0, -LevelMe.STREAM_SUFFIX.length);
      const raw = await this.driver.getOrUndefined!(base);
      if (raw !== undefined) {
        const { state, meta } = LevelMe.split(await ActiveClone.deserialize(raw));
        if (meta) batch.put(base, await ActiveClone.serialize(state, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
      }
    }
    batch.del(LevelMe.DOC_PREFIX + key);

    if (this.cache) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      }
      const rawKey = `raw:${key}`;
      if (this.cache.has(rawKey)) {
        this.cache.delete(rawKey);
      }
    }

    await batch.write();
  }

  /**
   * One page of removing rows older than a time (see prune.ts for what is
   * recognised and how age is read). A page stops at `limit` removals, at
   * the time budget, or when everything has been looked at, and says where
   * the next page starts, so a caller pages through a store of any size in
   * requests that each finish quickly.
   *
   * Only the document key is removed: a document written by this class has no
   * other row (nothing writes by-sequence rows any more; only data from before
   * that has them, and those are not touched).
   *
   * @param {PruneRequest} request
   * @returns {Promise<PrunePage>}
   */
  public async prune(request: PruneRequest): Promise<PrunePage> {
    await this.open();
    const { kind, before } = request;
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
    const dryRun = request.dryRun === true;
    const requireProcessed = request.requireProcessed !== false;
    const range = idRange(kind);

    // Errors need the document to see if it is processed, and a resent record to see when its
    // transaction expires; the others are decided by the id alone
    const options: any = { lt: LevelMe.DOC_PREFIX + range.lt, values: kind === "error" || kind === "resent" };
    if (request.after !== undefined) options.gt = LevelMe.DOC_PREFIX + request.after;
    else options.gte = LevelMe.DOC_PREFIX + range.gte;

    const started = Date.now();
    const doomed: string[] = [];
    let scanned = 0;
    let kept = 0;
    let last: string | undefined;
    let done = true;

    const stream = this.driver.createReadStream(options);
    try {
      for await (const entry of stream as AsyncIterable<{ key: Buffer | string; value?: Buffer }>) {
        const id = entry.key.toString().slice(LevelMe.DOC_PREFIX.length);
        scanned++;
        last = id;
        if (kind === "resent") {
          // Removed once the transaction it guards has expired: `before` is a time its $expire must
          // have passed, so a record still doing its job is never taken
          const doc: any = RESENT_ID.test(id) ? await ActiveClone.deserialize(entry.value as Buffer).catch(() => undefined) : undefined;
          if (doc && Number.isFinite(Number(doc.until)) && Number(doc.until) < before) doomed.push(id);
          else kept++;
          if (doomed.length >= limit || Date.now() - started > PAGE_BUDGET_MS) {
            done = false;
            break;
          }
          continue;
        }
        const time = idTime(kind, id);
        if (time === undefined) {
          kept++;
        } else if (time >= before) {
          kept++;
          // Rows of a time keyed kind are in time order, so nothing after this is old enough
          if (range.ordered) break;
        } else if (kind === "error" && requireProcessed) {
          const doc: any = await ActiveClone.deserialize(entry.value as Buffer).catch(() => undefined);
          if (doc && doc.processed === true) doomed.push(id);
          else kept++;
        } else {
          doomed.push(id);
        }
        if (doomed.length >= limit || Date.now() - started > PAGE_BUDGET_MS) {
          done = false;
          break;
        }
      }
    } finally {
      stream.destroy?.();
    }

    if (!dryRun && doomed.length) {
      const batch = await this.driver.batch();
      for (const id of doomed) batch.del(LevelMe.DOC_PREFIX + id);
      await batch.write();
      if (this.cache) {
        for (const id of doomed) {
          this.cache.delete(id);
          this.cache.delete(`raw:${id}`);
        }
      }
    }

    return { removed: doomed.length, scanned, kept, next: done ? undefined : last, done };
  }

  /**
   * Deletes sequences as a batch
   *
   * @param {string[]} keys
   * @returns {Promise<void>}
   */
  public async delSeq(keys: string[]): Promise<void> {
    await this.open();
    const batch = await this.driver.batch();

    for (let i = keys.length; i--;) {
      batch.del(LevelMe.SEQ_PREFIX + keys[i]);
    }

    await batch.write();
  }

  /**
   * Provide real-time document insertion with starting point supported
   *
   * @param {string} options
   * @returns {*}
   */
  public changes(): EventEmitter {
    return this.changeEmitter;
  }

  /**
   * Bulk write documents (While acting like post)
   *
   * @param {unknown[]} docs
   * @param {unknown} options
   * @returns
   */
  public async bulkDocs(
    docs: document[],
    options: { new_edits: boolean; force_rev?: string }
  ): Promise<boolean> {
    return (await this.bulkDocsRevs(docs, options)).ok;
  }

  /**
   * bulkDocs() that also answers with the revision each document now holds
   * (the one a read of it returns), so a caller that needs them does not have
   * to read every document back.
   */
  public async bulkDocsRevs(
    docs: document[],
    options: { new_edits: boolean; force_rev?: string }
  ): Promise<{ ok: boolean; revs: { [id: string]: string } }> {
    // Now we could loop post, But then its not a single atomic write.
    let batch = await this.driver.batch();
    const changes: any[] = [];
    const revs: { [id: string]: string } = {};
    const collect = (writer: { unchanged?: boolean; rev: string; changes: any }) => {
      revs[writer.changes.id] = writer.rev;
      // A resend of a write that already landed changed nothing, so it is
      // neither cached nor announced a second time
      if (!writer.unchanged) {
        changes.push(writer.changes);
      }
    };
    const distinct = new Set(docs.map((d) => d._id)).size === docs.length;
    if (this.merge && distinct) {
      // A state and its meta in one batch are one record: weigh them up together
      await this.open();
      const byId = new Map(docs.map((d) => [d._id, d]));
      const groups: Array<[document | undefined, document | undefined]> = [];
      for (const d of docs) {
        if (d._id.endsWith(LevelMe.STREAM_SUFFIX)) {
          if (!byId.has(d._id.slice(0, -LevelMe.STREAM_SUFFIX.length))) groups.push([undefined, d]);
        } else {
          groups.push([d, byId.get(d._id + LevelMe.STREAM_SUFFIX)]);
        }
      }
      const settled = await Promise.allSettled(
        groups.map(([state, meta]) => this.prepareGroup(state, meta, batch, options))
      );
      for (const result of settled) {
        if (result.status === "rejected") throw result.reason;
      }
      for (const result of settled) {
        for (const writer of (result as PromiseFulfilledResult<any[]>).value) collect(writer);
      }
    } else if (distinct && docs.length > 1) {
      // Each document's read of its current state is independent of the
      // others, so do them together instead of one threadpool round trip
      // after another. The puts go into the same batch (the writer chain is
      // the batch itself), and the changes keep their original order.
      const settled = await Promise.allSettled(
        docs.map((doc) => this.prepareForWrite(doc, batch, options))
      );
      // The serial loop below went from the last document to the first and
      // stopped at the first failure; report the same one, not whichever read
      // happened to finish first.
      for (let i = settled.length; i--;) {
        const result = settled[i];
        if (result.status === "rejected") {
          throw result.reason;
        }
        batch = result.value.chain;
        collect(result.value);
      }
    } else {
      for (let i = docs.length; i--;) {
        const writer = await this.prepareForWrite(docs[i], batch, options);
        batch = writer.chain; // Do I need do do this, Reference kept?
        collect(writer);
      }
    }

    try {
      await batch.write();
      if (this.cache) {
        for (let i = changes.length; i--;) {
          // See post() - raw shape is safe to reuse directly, resolved
          // shape may need seqDocFromRoot so just drop it and let the next
          // non-raw get() recompute it.
          this.cache.set(`raw:${changes[i].id}`, changes[i].doc);
          this.cache.delete(changes[i].id);
        }
      }
    } catch (e) {
      // The caller only sees false (streamUpdater raises 1510 from it), so
      // this is the one place the store's own reason survives
      ActiveLogger.error(
        { error: e, ids: docs.map((doc) => doc._id) },
        "Bulk write failed"
      );
      return { ok: false, revs: {} };
    }

    // Emit Changed Docs - one event per document, matching post()'s shape
    // (a flat object, not an array), so a "change" listener never has to
    // handle two different shapes depending on which write path triggered
    // it. This used to emit a single event carrying the whole array, which
    // crashed any listener written for post()'s single-object shape -
    // selfhost.ts's /events SSE handler is exactly one such listener
    // (change.id.startsWith(...) threw on an array, since arrays don't
    // have an .id). Emitting outside the try/catch above (rather than
    // inside it, as before) means a listener's own bug can no longer be
    // misattributed as this write having failed - that's what let a
    // thrown listener exception get silently caught here and turn into
    // bulkDocs() returning false even though batch.write() had already
    // succeeded, which streamUpdater.ts's commit path took as a genuine
    // disk failure (error 1510) on every transaction, for as long as any
    // /events client stayed connected.
    //
    // EventEmitter doesn't isolate a listener's own exception by default -
    // a synchronous throw inside emit() propagates straight out and stops
    // the later listeners. emitChange() calls each listener in its own
    // try/catch, so one throwing can't stop the rest from being notified,
    // and can never turn into bulkDocs() itself rejecting.
    for (let i = changes.length; i--;) {
      this.emitChange(changes[i]);
    }
    return { ok: true, revs };
  }

  /**
   * Notifies every "change" listener, each in its own try/catch so one that
   * throws cannot stop the ones registered after it. emit() alone stops at
   * the first throw. rawListeners() keeps registration order and the once()
   * wrappers, which remove themselves when called.
   *
   * @private
   * @param {*} change
   */
  private emitChange(change: any): void {
    for (const listener of this.changeEmitter.rawListeners("change")) {
      try {
        listener.call(this.changeEmitter, change);
      } catch (listenerError) {
        ActiveLogger.error(listenerError, "change listener threw");
      }
    }
  }

  /**
   * Prepare batch written of all meta documents
   *
   * @private
   * @param {document} doc
   * @param {LevelUpChain<any, any>} chain
   * @returns {Promise<{ chain: LevelUpChain<any, any>; rev: string }>}
   */
  private async prepareForWrite(
    doc: document,
    chain: LevelUpChain<any, any>,
    options: { new_edits: boolean; force_rev?: string } = { new_edits: true }
  ): Promise<{
    chain: LevelUpChain<any, any>;
    rev: string;
    unchanged?: boolean;
    changes: {
      id: string;
      changes: { rev: string }[];
      doc: document;
      seq: number;
    };
  }> {
    await this.open();

    // A state record may carry its meta: both documents are weighed up
    // together and written back as one record
    if (this.merge) {
      const out = await this.prepareGroup(
        doc._id.endsWith(LevelMe.STREAM_SUFFIX) ? undefined : doc,
        doc._id.endsWith(LevelMe.STREAM_SUFFIX) ? doc : undefined,
        chain,
        options
      );
      return out[0];
    }

    // Does Document exist? A driver that can answer "no" without throwing does
    // (every new document and every event row is a miss, and a thrown Error
    // costs a stack capture just to be caught here).
    let currentDocRoot: schema | undefined;
    try {
      const key = LevelMe.DOC_PREFIX + doc._id;
      const raw = this.driver.getOrUndefined
        ? await this.driver.getOrUndefined(key)
        : await this.driver.get(key);
      if (raw !== undefined) {
        currentDocRoot = (await ActiveClone.deserialize(raw)) as schema;
      }
    } catch (error) {
      // A driver that throws for a missing key marks it notFound
      if (!error.notFound) {
        throw error;
      }
    }

    const verdict = this.evaluate(doc, currentDocRoot, options);
    if (verdict.write) {
      chain.put(LevelMe.DOC_PREFIX + doc._id, await ActiveClone.serialize(doc, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
    }
    return { chain, ...verdict.result };
  }

  /**
   * Reads one stored record and weighs up the writes of the state and meta it
   * holds. At most one put results, carrying both. A write of only one of the
   * two keeps the other as stored; a meta with no state record to ride on is
   * stored under its own key, as it always was.
   */
  private async prepareGroup(
    state: document | undefined,
    meta: document | undefined,
    chain: LevelUpChain<any, any>,
    options: { new_edits: boolean; force_rev?: string }
  ): Promise<any[]> {
    const baseId = state ? state._id : meta!._id.slice(0, -LevelMe.STREAM_SUFFIX.length);
    const key = LevelMe.DOC_PREFIX + baseId;
    const metaKey = LevelMe.DOC_PREFIX + baseId + LevelMe.STREAM_SUFFIX;

    const raw = await this.driver.getOrUndefined!(key);
    let curState: any;
    let curMeta: any;
    if (raw !== undefined) {
      ({ state: curState, meta: curMeta } = LevelMe.split(await ActiveClone.deserialize(raw)));
    }

    // Data from before the merge keeps its meta under its own key
    let legacyMeta = false;
    if (meta && curState && !curMeta) {
      const old = await this.driver.getOrUndefined!(metaKey);
      if (old !== undefined) {
        curMeta = await ActiveClone.deserialize(old);
        legacyMeta = true;
      }
    }

    const results: any[] = [];
    let stateWrite = false;
    let metaWrite = false;
    if (state) {
      const v = this.evaluate(state, curState, options);
      stateWrite = v.write;
      results.push({ chain, ...v.result });
    }
    if (meta) {
      const v = this.evaluate(meta, curMeta, options);
      metaWrite = v.write;
      results.push({ chain, ...v.result });
    }

    if (meta && !state && !curState) {
      // Nothing to ride on: its own key
      if (metaWrite) {
        chain.put(metaKey, await ActiveClone.serialize(meta, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
      }
      return results;
    }

    if (stateWrite || metaWrite || (legacyMeta && meta)) {
      const outState = state && stateWrite ? state : curState;
      const outMeta = meta && metaWrite ? meta : curMeta;
      const record: any = { ...outState };
      if (outMeta) record[LevelMe.MERGED] = outMeta;
      chain.put(key, await ActiveClone.serialize(record, { enableCompression: true, compressionThreshold: LevelMe.COMPRESS_ABOVE }));
      if (legacyMeta) chain.del(metaKey);
    }
    return results;
  }

  /**
   * Decides what writing a document does against what is stored for it:
   * its new revision, whether anything has to be written, or why it cannot.
   */
  private evaluate(
    doc: document,
    currentDocRoot: schema | undefined,
    options: { new_edits: boolean; force_rev?: string }
  ): {
    write: boolean;
    result: {
      rev: string;
      unchanged?: boolean;
      changes: { id: string; changes: { rev: string }[]; doc: document; seq: number };
    };
  } {
    // MD5 input to act as tree position
    const md5 = createHash("md5").update(JSON.stringify({ ...doc, _rev: null })).digest("hex");
    let newRev = "";
    let write = false;

    if (currentDocRoot) {
      // Document exists, handle update

      if (doc._rev !== currentDocRoot._rev && !options.new_edits) {
        // Already holding exactly this content means this write already
        // landed - a resend after its answer was lost (streamUpdater
        // retries a save it could not confirm). Writing it again would
        // change nothing, so it is not a conflict. Different content at a
        // stale revision still is.
        //
        // Only from the revision that write started at, one position
        // behind the stored one (or none, for a document it created), so a
        // second transaction working from the same older revision is still
        // refused even when it happens to produce the same content.
        const [storedPos, storedMd5] = currentDocRoot._rev.split("-");
        const fromPos = doc._rev ? parseInt(doc._rev.split("-")[0]) : 0;
        if (storedMd5 === md5 && parseInt(storedPos) === fromPos + 1) {
          return {
            write: false,
            result: {
              rev: currentDocRoot._rev,
              unchanged: true,
              changes: {
                id: doc._id,
                changes: [{ rev: currentDocRoot._rev }],
                doc: currentDocRoot as document,
                seq: Date.now(),
              },
            },
          };
        }
        throw new Error(`Revision Mismatch: ${doc._id} @ ${doc._rev} !== ${currentDocRoot._rev}`);
      }

      if (options.force_rev) {
        newRev = options.force_rev;
      } else {
        const [p1, curmd5] = currentDocRoot._rev.split("-");
        // Md5s don't match we need to update rev, This will then get it written to disk
        if (md5 !== curmd5) {
          newRev = `${parseInt(p1) + 1}-${md5}`;
        }
      }

      if (newRev) {
        doc._rev = newRev;
        write = true;
      }
    } else {
      // Document doesn't exist, handle creation
      if (!options.new_edits && doc._rev) {
        newRev = doc._rev;
      } else {
        newRev = `1-${md5}`;
      }
      doc._rev = newRev;
      write = true;
    }

    // Content the store already held writes nothing and keeps its revision
    newRev = newRev || currentDocRoot?._rev || "";
    return {
      write,
      result: {
        rev: newRev,
        changes: {
          id: doc._id,
          changes: [{ rev: newRev }],
          doc,
          // Date.now() is monotonic enough for the one purpose it serves:
          // the live change event's last_seq. It is NOT a substitute for
          // real backfill/replay support (none exists in this class).
          seq: Date.now(),
        },
      },
    };
  }

  /**
   * Provide real-time document insertion with starting point supported
   *
   * @param {string} options
   * @returns {*}
   */
  public async changesFromSeq(options: changesOptions): Promise<{
    results: {
      id: string;
      changes: { rev: string }[];
      doc?: document;
      seq: number;
    }[];
    last_seq: number;
  }> {
    // since="now" needs no data, so it must not open (create) a database
    if (options.since !== "now") {
      await this.open();
    }
    return new Promise((resolve, reject) => {
      // since="now" (nano-gateway's ChangesWatcher default for a fresh
      // subscription with no Last-Event-ID to resume from -
      // packages/nano-gateway/src/changesWatcher.ts) means "nothing is
      // pending as of this instant" - resolve that directly rather than
      // falling through to the numeric-seq path below, which used to do
      // "now".padStart(16, "0") = "0000000000000now" as a LevelDB range
      // key. That's not a valid padded-numeric sequence key, and the
      // underlying driver's createReadStream() throws on it - which,
      // since selfhost.ts's _changes handler has no .catch() on this
      // promise, surfaced as an opaque 500 with an empty {} body all the
      // way up through nano-gateway's own client (live-confirmed: this is
      // exactly what broke nano-gateway's very first subscribe attempt
      // once the two other _changes bugs - unfinalised response, and the
      // separate garbage-header-bytes bug - were fixed and this code path
      // was reached for the first time).
      if (options.since === "now") {
        resolve({ results: [], last_seq: 0 });
        return;
      }

      // get all sequenced documents with emitter, sequence "maybe up to date"
      // Cache rows to be returned
      const rows: any[] = [];

      // For checking on end
      const promises: Promise<document>[] = [];

      // Filter for sequences metadata
      const filter = {
        gt: LevelMe.SEQ_PREFIX,
        lt: LevelMe.DOC_PREFIX,
        limit: parseInt((options.limit || 5).toString()),
        reverse:
          options.descending && options.descending.toString() === "true"
            ? true
            : false, // (array reverse maybe faster, but wont work with filter)
      };

      if (options.since) {
        filter.gt =
          LevelMe.SEQ_PREFIX + options.since.toString().padStart(16, "0");
      }

      // Read / Search the database as a stream
      this.driver
        .createReadStream(filter)
        .on("data", (data: { key: string; value: Buffer }) => {
          // Deserialising is asynchronous (compressed values), so track it:
          // the stream's end must wait for every row, and a damaged value
          // must reach the caller. Rows are kept in stream order.
          const index = promises.length;
          const pending = ActiveClone.deserialize(data.value).then(
            (doc: any) => {
              // Get sequence from keyname
              const seq = parseInt(
                data.key.toString().replace(LevelMe.SEQ_PREFIX, "")
              );
              const row: any = {
                id: doc._id,
                seq,
                changes: [
                  {
                    rev: doc._rev,
                  },
                ],
              };
              if (
                options.include_docs &&
                JSON.parse(options.include_docs.toString())
              ) {
                row.doc = doc;
              }
              rows[index] = row;
              return doc as document;
            }
          );
          // The end handler is what reports a failure; without this a
          // rejection landing before the stream ends is reported as unhandled
          pending.catch(() => { });
          promises.push(pending);
        })
        .on("error", (err: unknown) => {
          reject(err);
        })
        .on("close", () => { })
        .on("end", async () => {
          try {
            await Promise.all(promises);
            resolve({
              results: rows,
              last_seq: 0,
            });
          } catch (e) {
            reject(e);
          }
        });
    });
  }
}


