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

const ENABLE_CACHE = true;

/**
 * LevelUP Wrapper for Activeledger with PouchDB legacy support
 *
 * @export
 * @class LevelMe
 */
export class LevelMe {
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

  private cache: ActiveCache;

  private openingPromise: Promise<void> | null = null;

  constructor(location: string, private name: string, provider: string) {
    this.driver = new LevelDBDriver(location + name, provider);
    if (ENABLE_CACHE) {
      this.cache = ActiveCacheManager.fetch(`streams:${this.name}`, 30000);
    }
  }


  /**
   * Attempts to fetch document, If fails returns default
   *
   * @private
   * @template T
   * @param {string} document
   * @param {T} defaultvalue
   * @returns
   */
  private async levelUpGet<T>(document: string, defaultvalue: T) {
    try {
      await this.open();
      return (await this.driver.get(document)) as unknown as T;
    } catch {
      return defaultvalue;
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
      this.driver
        .createValueStream()
        .on("data", async (data: any) => {
          writer.write(data.toString() + "\n");
        })
        .on("error", reject)
        .on("end", async () => {
          writer.end();
          try {
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
      createReadStream(filename)
        .pipe(newLineTransform())
        .on("data", async (data: Buffer) => {
          try {
            const doc = JSON.parse(data.toString());
            ActiveLogger.info(`Restoring ${doc._id}`);
            await this.bulkDocs(doc, { new_edits: true });
          } catch {
            ActiveLogger.warn(`Restoring FAILED`);
          }
        })
        .on("error", reject)
        .on("end", async () => {
          try {
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
            docPromises.push(
              ActiveClone.deserialize(data.value).then((doc: any) => {
                if (options.include_docs) {
                  return doc;
                } else {
                  return {
                    _id: doc._id, // Compatibility Trick
                    id: doc._id,
                    key: doc._id,
                  };
                }
              })
            );
          })
            .on("error", (err: unknown) => {
              stream.destroy();
              reject(err);
            })
            .on("end", async () => {
              // Await all promises in the original stream order
              const rows = await Promise.all(docPromises);
              resolve({
                total_rows: rows.length,
                offset,
                rows,
              });
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
    if (ENABLE_CACHE) {
      // raw and non-raw reads store different shapes for the same id, so
      // they need distinct cache keys or one mode poisons the other.
      const cacheKey = raw ? `raw:${key}` : key;
      if (!this.cache.has(cacheKey)) {
        await this.open();
        // Allow errors to bubble up?
        const doc = await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key)) as any;
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
      const doc = await ActiveClone.deserialize(await this.driver.get(LevelMe.DOC_PREFIX + key)) as any;
      if (raw) {
        return doc;
      } else {
        return await this.seqDocFromRoot(doc);
      }
    }
  }

  public async getMany(keys: string[]): Promise<any[]> {
    if (ENABLE_CACHE) {
      let tmpKeys = [];
      let cached = [];
      for (let i = keys.length; i--;) {
        if (!this.cache.has(keys[i])) {
          tmpKeys.push(LevelMe.DOC_PREFIX + keys[i]);
        } else {
          // No copy here, same as the cache-miss branch below (cached.push(data)
          // shares the object with cache.set() unconditionally) - this was an
          // inconsistent, incomplete defensive copy: a stream that's already
          // warm skipped mutation exposure, one that wasn't didn't. Contract
          // code itself never touches either one directly regardless -
          // Activity.getState() (contracts/stream.ts) always deep-clones
          // before handing state to a contract - so this copy wasn't
          // load-bearing for correctness, just an extra allocation on every
          // cache hit.
          cached.push(this.cache.get(keys[i], 30000));
        }
      }

      // Get uncached keys
      if (tmpKeys.length) {
        const result = await this.driver.getMany(tmpKeys);
        // Loop and cache
        for (let i = result.length; i--;) {
          const data = await ActiveClone.deserialize(result[i]) as any;
          this.cache.set(data._id, data);
          cached.push(data);
        }
      }
      return cached;
    } else {
      const tmpKeys = [];
      for (let i = keys.length; i--;) {
        tmpKeys.push(LevelMe.DOC_PREFIX + keys[i]);
      }

      // Get uncached keys
      const result = await this.driver.getMany(tmpKeys);

      // Loop and parse
      const parsed = await Promise.all(result.map(async (data) => {
          const doc = await ActiveClone.deserialize(data) as any;
          return doc;
      }));
      return parsed;
    }
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
      if (ENABLE_CACHE) {
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
      this.cache.clear();
      throw e;
    }

    // Emit outside the try/catch, same reasoning as bulkDocs() - a
    // listener's own bug should never be able to masquerade as this write
    // having failed. EventEmitter doesn't isolate a listener's own thrown
    // exception by default though, so this is its own try/catch too -
    // otherwise a listener throwing would propagate straight out and
    // reject this call, the same class of bug being fixed here.
    try {
      this.changeEmitter.emit("change", writer.changes);
    } catch (listenerError) {
      ActiveLogger.error(listenerError, "change listener threw");
    }

    return {
      ok: true,
      id: doc._id,
      rev: writer.rev,
    };
  }

  public async writeRaw(key: string, value: unknown) {
    await this.open();
    return this.driver.put(LevelMe.DOC_PREFIX + key, await ActiveClone.serialize(value, { enableCompression: true }));
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
    batch.del(LevelMe.DOC_PREFIX + key);

    if (ENABLE_CACHE) {
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
    // Now we could loop post, But then its not a single atomic write.
    let batch = await this.driver.batch();
    const changes = [];
    for (let i = docs.length; i--;) {
      const writer = await this.prepareForWrite(docs[i], batch, options);
      batch = writer.chain; // Do I need do do this, Reference kept?
      changes.push(writer.changes);
    }

    try {
      await batch.write();
      if (ENABLE_CACHE) {
        for (let i = changes.length; i--;) {
          // See post() - raw shape is safe to reuse directly, resolved
          // shape may need seqDocFromRoot so just drop it and let the next
          // non-raw get() recompute it.
          this.cache.set(`raw:${changes[i].id}`, changes[i].doc);
          this.cache.delete(changes[i].id);
        }
      }
    } catch (e) {
      return false;
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
    // a synchronous throw inside emit() propagates straight out to us, so
    // being outside the write's try/catch above isn't enough on its own to
    // fully protect the return value. Each emit is individually try/caught
    // here too, so one listener throwing can't stop the rest from being
    // notified, and can never turn into bulkDocs() itself rejecting.
    for (let i = changes.length; i--;) {
      try {
        this.changeEmitter.emit("change", changes[i]);
      } catch (listenerError) {
        ActiveLogger.error(listenerError, "change listener threw");
      }
    }
    return true;
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
    changes: {
      id: string;
      changes: { rev: string }[];
      doc: document;
    };
  }> {
    await this.open();

    // MD5 input to act as tree position
    // Use a copy to avoid mutating the original object
    //const docToWrite = { ...doc };
    //delete docToWrite._rev;
    //const incomingDoc = JSON.stringify(docToWrite);
    // Not backwards compatiable
    const md5 = createHash("md5").update(JSON.stringify({ ...doc, _rev: null })).digest("hex");
    let newRev = "";

    // Does Document eixst?
    try {
      // Document exists, handle update
      const currentDocRoot = await ActiveClone.deserialize(
        await this.driver.get(LevelMe.DOC_PREFIX + doc._id)
      ) as schema;

      if (doc._rev !== currentDocRoot._rev && !options.new_edits) {
        throw new Error(`Revision Mismatch: ${doc._id} @ ${doc._rev} !== ${currentDocRoot._rev}`);
      }

      if (options.force_rev) {
        newRev = options.force_rev;
      } else {

        const [p1, curmd5] = currentDocRoot._rev.split("-");
        //const pos = parseInt(p1) + 1;
        //newRev = `${pos}-${md5}`;

        // Md5s don't match we need to update rev, This will then get it written to disk
        if (md5 !== curmd5) {
          newRev = `${parseInt(p1) + 1}-${md5}`;
        }

      }

      if (newRev) {
        doc._rev = newRev;
        chain.put(LevelMe.DOC_PREFIX + doc._id, await ActiveClone.serialize(doc, { enableCompression: true }));
      }

    } catch (error) {
      // Document doesn't exist, handle creation
      if (error.notFound) {
        if (!options.new_edits && doc._rev) {
          newRev = doc._rev;
        } else {
          newRev = `1-${md5}`;
        }
        doc._rev = newRev;
        chain.put(LevelMe.DOC_PREFIX + doc._id, await ActiveClone.serialize(doc, { enableCompression: true }));
      } else {
        // Re-throw other errors (like revision mismatch)
        throw error;
      }
    }

    return {
      chain,
      rev: newRev,
      changes: {
        id: doc._id,
        changes: [{ rev: newRev }],
        doc,
      },
    };
  }


  /**
   * Provide real-time document insertion with starting point supported
   *
   * @param {string} options
   * @returns {*}
   */
  public changesFromSeq(options: changesOptions): Promise<{
    results: {
      id: string;
      changes: { rev: string }[];
      doc?: document;
      seq: number;
    }[];
    last_seq: number;
  }> {
    return new Promise((resolve, reject) => {
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
        .on("data", async (data: { key: string; value: Buffer }) => {
          const doc = await ActiveClone.deserialize(data.value) as any;
          // Get sequence from keyname
          const seq = parseInt(
            data.key.toString().replace(LevelMe.SEQ_PREFIX, "")
          );
          if (
            options.include_docs &&
            JSON.parse(options.include_docs.toString())
          ) {
            rows.push({
              id: doc._id,
              seq,
              changes: [
                {
                  rev: doc._rev,
                },
              ],
              doc,
            });
          } else {
            rows.push({
              id: doc._id,
              seq,
              changes: [
                {
                  rev: doc._rev,
                },
              ],
            });
          }
        })
        .on("error", (err: unknown) => {
          reject(err);
        })
        .on("close", () => { })
        .on("end", async () => {
          await Promise.all(promises);
          resolve({
            results: rows,
            last_seq: 0,
          });
        });
    });
  }
}


