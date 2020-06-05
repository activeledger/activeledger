import RocksDB from "rocksdb";
import { LevelUp, default as levelup } from "levelup";
import { ActiveLogger } from "@activeledger/activelogger";
import { EventEmitter } from "events";

/**
 * Generic Data Document
 *
 * @interface document
 */
interface document {
  _id: string;
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
}

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
   * @memberof LevelMe
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
   * @memberof LevelMe
   */
  private static DOC_PREFIX = "ÿdocument-storeÿ";

  /**
   * PouchDb Legacy Support
   * Database value key
   *
   * ÿ is xff unicode, Character code 255
   *
   * @private
   * @static
   * @memberof LevelMe
   */
  private static SEQ_PREFIX = "ÿby-sequenceÿ";

  /**
   * Holds the local copy of LevelUp
   *
   * @private
   * @type {LevelUp}
   * @memberof LevelMe
   */
  private levelUp: LevelUp;

  /**
   * Real-time document count in the database
   *
   * @private
   * @memberof LevelMe
   */
  private docCount = 0;

  /**
   * Real-time document sequencing in the database
   *
   * @private
   * @memberof LevelMe
   */
  private docUpdateSeq = 0;

  constructor(location: string, private name: string) {
    this.levelUp = levelup(RocksDB(location + name));
  }

  /**
   * Opens the database and caches the metadata
   *
   * @private
   * @memberof LevelMe
   */
  private async open() {
    if (!this.levelUp.isOpen()) {
      await this.levelUp.open();

      // Cache Values
      this.docCount = (
        await this.levelUp.get(LevelMe.META_PREFIX + "_local_doc_count")
      ).readInt32BE();
      this.docUpdateSeq = (
        await this.levelUp.get(LevelMe.META_PREFIX + "_local_last_update_seq")
      ).readInt32BE();
    }
  }

  /**
   * Fetches information about the database or creates a new database
   *
   * @returns
   * @memberof LevelMe
   */
  public async info() {
    try {
      await this.open();
      return {
        doc_count: this.docCount,
        update_seq: this.docUpdateSeq,
        db_name: this.name,
        data_size: 0,
      };
    } catch (e) {
      // TODO Filter bad / unexpected creates such as favicon.ico
      await this.levelUp.put(LevelMe.META_PREFIX + "_local_doc_count", 0);
      await this.levelUp.put(LevelMe.META_PREFIX + "_local_last_update_seq", 0);
      return {
        doc_count: 0,
        update_seq: 0,
        db_name: this.name,
        data_size: 0,
      };
    }
  }

  /**
   * Close the underlying leveldb connction
   *
   * @memberof LevelMe
   */
  public close() {
    this.levelUp.close();
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   * @memberof LevelMe
   */
  public async createIndex(options: unknown) {
    ActiveLogger.fatal("createIndex is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   * @memberof LevelMe
   */
  public async deleteIndex(options: unknown) {
    ActiveLogger.fatal("deleteIndex is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   * @memberof LevelMe
   */
  public async explain(options: unknown) {
    ActiveLogger.fatal("explain is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   * @memberof LevelMe
   */
  public async find(options: unknown) {
    ActiveLogger.fatal("find is deprecated");
  }

  /**
   * @deprecated
   *
   * @param {unknown} options
   * @memberof LevelMe
   */
  public async getIndexes() {
    ActiveLogger.fatal("getIndexes is deprecated");
    return {
      indexes: [],
    };
  }

  /**
   * Returns all the data documents with filter options
   *
   * @param {allDocOptions} options
   * @returns {Promise<unknown>}
   * @memberof LevelMe
   */
  public allDocs(options: allDocOptions): Promise<unknown> {
    return new Promise(async (resolve, reject) => {
      await this.open();
      // No offset built in, Create one by skip + limit and counter on skip;
      let limit = options.limit || -1;
      if (options.skip && limit !== -1) {
        // Convert to int
        options.skip = parseInt((options.skip as unknown) as string);
        limit += options.skip;
      }

      // Cache rows to be returned
      const rows: any[] = [];

      // Read / Search the database as a stream
      this.levelUp
        .createReadStream({
          gte: LevelMe.DOC_PREFIX + (options.startkey || ""),
          lt: options.endkey
            ? LevelMe.DOC_PREFIX + options.endkey
            : LevelMe.META_PREFIX,
          limit,
        })
        .on("data", function (data) {
          // Filter out the "skipped" keys
          if (options.skip) {
            options.skip--;
            return;
          }
          const doc = JSON.parse(data.value.toString());
          // UI Viewer Compatible
          doc.id = doc._id;
          delete doc._id;
          rows.push(doc);
        })
        .on("error", function (err) {
          reject(err);
        })
        .on("close", function () {})
        .on("end", function () {
          resolve({
            total_rows: this.doc_count,
            offset: 0, // TODO match this up, May need more document to test, Or maybe not needed
            rows,
          });
        });
    });
  }

  /**
   * Get a specific data document
   *
   * @param {string} key
   * @returns
   * @memberof LevelMe
   */
  public async get(key: string) {
    await this.open();
    // Allow errors to bubble up?
    return await this.levelUp.get(LevelMe.DOC_PREFIX + key);
  }

  /**
   * Writes a data document (following sequences and revision information)
   *
   * @param {document} doc
   * @returns
   * @memberof LevelMe
   */
  public async post(doc: document) {
    await this.open();

    // increase sequence & count!

    // It is more complex than this, We need 2 documents metadata and "data" sequence doc
    await this.levelUp.put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(doc));

    return {
      ok: true,
      id: doc._id,
      rev: "TBD",
    };
  }

  /**
   * Alias for post, Legacy from PouchDb
   *
   * @param {(document | unknown)} doc
   * @returns
   * @memberof LevelMe
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
   * @memberof LevelMe
   */
  public async del(key: string) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }

  /**
   * Provide real-time document insertion with starting point supported
   *
   * @param {string} options
   * @returns {*}
   * @memberof LevelMe
   */
  public changes(options: string): any {
    // Promise<any> | EventEmittePromise<any> | EventEmitter {
    ActiveLogger.fatal("Not Implemented");
    return new EventEmitter();
  }

  /**
   * Bulk write documents (While acting like post)
   *
   * @param {unknown[]} docs
   * @param {unknown} options
   * @returns
   * @memberof LevelMe
   */
  public async bulkDocs(docs: unknown[], options: unknown) {
    ActiveLogger.fatal("Not Implemented");
    return {};
  }
}
