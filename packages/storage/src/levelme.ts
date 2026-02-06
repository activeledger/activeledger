import { createHash } from "crypto";
import {
  createWriteStream,
  createReadStream,
  writeFileSync,
  unlinkSync,
} from "fs";
import RocksDB from "rocksdb";
import { LevelUp, default as levelup, LevelUpChain } from "levelup";
import LevelDOWN from "leveldown";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";
import { newLineTransform } from "./newlinestream";
import { ActiveCacheManager, ActiveCache } from "@activeledger/activeoptions";

/**
 * Generic Data Document
 *
 * @interface document
 */
interface document {
  _id: string;
  _rev?: string;
  [index: string]: unknown;
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

  private levelUp: LevelUp;

  private cache: ActiveCache;

  constructor(location: string, private name: string, provider: string) {
    if (provider === "rocks") {
      this.levelUp = levelup(RocksDB(location + name));
    } else {
      this.levelUp = levelup(LevelDOWN(location + name));
    }
    if (ENABLE_CACHE) {
      this.cache = ActiveCacheManager.fetch("streams", 30000);
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
      return (await this.levelUp.get(document)) as T;
    } catch {
      return defaultvalue;
    }
  }

  /**
   * Opens the database and caches the metadata
   *
   * @private
   */
  private async open() {
    if (!this.levelUp.isOpen()) {
      await this.levelUp.open();
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
  public close() {
    this.levelUp.close();
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   */
  public async createIndex(options: unknown) {
    ActiveLogger.fatal("createIndex is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   */
  public async deleteIndex(options: unknown) {
    ActiveLogger.fatal("deleteIndex is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   */
  public async explain(options: unknown) {
    ActiveLogger.fatal("explain is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   */
  public async find(options: unknown) {
    ActiveLogger.fatal("find is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   */
  public async getIndexes() {
    ActiveLogger.fatal("getIndexes is deprecated");
    return {
      indexes: [],
    };
  }

  /**
   * Backup this database
   *
   * @param {string} [filename]
   */
  public backup(filename?: string) {
    if (!filename) {
      filename = `${Date.now()}.alb`;
    }
    writeFileSync(`${filename}.status`, filename);
    const writer = createWriteStream(filename);

    this.levelUp
      .createValueStream()
      .on("data", async (data: any) => {
        writer.write(data.toString() + "\n");
      })
      .on("error", () => { })
      .on("close", () => { })
      .on("end", () => {
        writer.end();
        unlinkSync(`${filename}.status`);
      });
  }

  /**
   * Restore (overwriting) to this database
   *
   * @param {string} filename
   */
  public restore(filename: string) {
    writeFileSync(`${filename}.status`, "running");

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
      .on("error", () => { })
      .on("end", () => {
        unlinkSync(`${filename}.status`);
      });
  }

  // public async restore() {
  //   await this.open();
  //   this.levelUp
  //     .createReadStream()
  //     .pipe(JSONStream.stringify("", "", ""))
  //     .pipe(createWriteStream("./backup.txt"));

  //   createReadStream("backup.txt")
  //     .pipe(JSONStream.parse())
  //     .pipe(this.levelUp.createKeyStream);
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
          this.levelUp
            .createReadStream({
              gte: LevelMe.DOC_PREFIX + (options.startkey || ""),
              lt: options.endkey
                ? LevelMe.DOC_PREFIX + options.endkey
                : LevelMe.META_PREFIX,
              limit,
            })
            .on("data", async (data: { key: string; value: any }) => {
              // Filter out the "skipped" keys
              if (options.skip) {
                options.skip--;
                return;
              }
              const doc = JSON.parse(data.value.toString());

              if (options.include_docs) {
                rows.push(doc);
              } else {
                rows.push({
                  _id: doc._id, // Compatibility Trick
                  id: doc._id,
                  key: doc._id,
                });
              }
            })
            .on("error", (err: unknown) => {
              reject(err);
            })
            .on("close", () => { })
            .on("end", async () => {
              if (options.include_docs) {
                // The rows are already the full documents
              }
              resolve({
                total_rows: rows.length,
                offset,
                rows,
              });
            });
        }
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
      if (!this.cache.has(key)) {
        await this.open();
        // Allow errors to bubble up?
        const doc = JSON.parse(await this.levelUp.get(LevelMe.DOC_PREFIX + key));
        this.cache.set(key, doc);
      }
      return this.cache.get(key, 30000);
    } else {
      await this.open();
      // Allow errors to bubble up?
      let doc = JSON.parse(await this.levelUp.get(LevelMe.DOC_PREFIX + key));
      if (raw) {
        return doc
      }
      return doc;
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
          //cached.push({ doc: this.cache.get(keys[i], 30000) });
          cached.push({ ...this.cache.get(keys[i], 30000) });
        }
      }

      // Get uncached keys
      if (tmpKeys.length) {
        const result = await this.levelUp.getMany(tmpKeys);
        // Loop and cache
        for (let i = result.length; i--;) {
          const data = JSON.parse(result[i]);
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
      const result = await this.levelUp.getMany(tmpKeys);

      // Loop and parse
      return result.map(data => JSON.parse(data));
    }
  }

  /**
   * Get a specific sequence document
   *
   * @param {string} seq
   * @returns
   */
  public async getSeq(seq: string) {
    return this.levelUp.get(LevelMe.SEQ_PREFIX + seq);
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
      if (this.levelUp.compactRange) {
        // We could range everything with null, null but only the sequence files create the mass storage
        // so as a performance trade off we will only compact across that range

        //@ts-ignore
        this.levelUp.compactRange(
          `${LevelMe.SEQ_PREFIX}0000000000000000`,
          `${LevelMe.SEQ_PREFIX}9999999999999999`,
          (args: unknown) => {
            resolve(args);
          }
        );
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
    const writer = await this.prepareForWrite(doc, this.levelUp.batch());
    try {
      await writer.chain.write();
      if (ENABLE_CACHE) {
        this.cache.set(writer.changes.id, writer.changes.doc);
      }
      this.changeEmitter.emit("change", writer.changes);
    } catch (e) {
      // May contain multiple documents, Easier & safer to clear the cache
      this.cache.clear();
    }
    return {
      ok: true,
      id: doc._id,
      rev: writer.rev,
    };
  }

  public async writeRaw(key: string, value: unknown) {
    await this.open();
    return this.levelUp.put(LevelMe.DOC_PREFIX + key, value);
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
    const batch = await this.levelUp.batch();

    // For now just delete the document key (not sequence)
    // _local_doc_count need to reduce count
    batch.del(LevelMe.DOC_PREFIX + key);

    if (ENABLE_CACHE && this.cache.has(key)) {
      this.cache.delete(key);
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
    const batch = await this.levelUp.batch();

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
    let batch = await this.levelUp.batch();
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
          this.cache.set(changes[i].id, changes[i].doc);
        }
      }
      // Emit Changed Docs
      this.changeEmitter.emit("change", changes);
    } catch (e) {
      return false;
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
    const docToWrite = { ...doc };
    delete docToWrite._rev;
    const incomingDoc = JSON.stringify(docToWrite);
    const md5 = createHash("md5").update(incomingDoc).digest("hex");
    let newRev: string;

    // Does Document eixst?
    try {
      // Document exists, handle update
      const currentDocRoot = JSON.parse(
        await this.levelUp.get(LevelMe.DOC_PREFIX + doc._id)
      ) as schema;

      if (doc._rev !== currentDocRoot._rev && !options.new_edits) {
        throw new Error(`Revision Mismatch: ${doc._id} @ ${doc._rev} !== ${currentDocRoot._rev}`);
      }

      if (options.force_rev) {
        newRev = options.force_rev;
      } else {

        const [p1, curmd5] = currentDocRoot._rev.split("-");
        if (md5 === curmd5) {
          // No change in document content, but we might be forced to write a new revision
          // For now, we can just return the existing state if no forced revision.
          // This part of logic can be tricky depending on desired semantics.
          // Let's assume for now we always write if called.
        }
        const pos = parseInt(p1) + 1;
        newRev = `${pos}-${md5}`;
      }
      doc._rev = newRev;
      chain.put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(doc));

    } catch (error) {
      // Document doesn't exist, handle creation
      if (error.notFound) {
        if (!options.new_edits && doc._rev) {
          newRev = doc._rev;
        } else {
          newRev = `1-${md5}`;
        }
        doc._rev = newRev;
        chain.put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(doc));
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
      this.levelUp
        .createReadStream(filter)
        .on("data", async (data: { key: string; value: any }) => {
          const doc = JSON.parse(data.value.toString());
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


