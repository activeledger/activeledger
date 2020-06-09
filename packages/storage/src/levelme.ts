import { createHash, Hash } from "crypto";
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
}

interface branchStatus {
  status: string;
}
type branch = [[string, branchStatus, branch | []]];

interface tree {
  pos: number;
  ids: branch;
}

interface schema extends document {
  rev_tree: tree[];
  rev_map: {
    [index: string]: number;
  };
  winningRev: string;
  deleted: boolean;
  seq: number;
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

  /**
   * Store hash digster
   *
   * @private
   * @type {Hash}
   * @memberof LevelMe
   */
  private revHasher: Hash;

  constructor(location: string, private name: string) {
    this.levelUp = levelup(RocksDB(location + name));
    this.revHasher = createHash("md5");
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
   * Navigate to the end of the branch
   *
   * We can possibly ignore the winningRev as this isn't a concern for us at this point
   *
   * @private
   * @param {branch} branch
   * @param {number} [pos=0]
   * @returns {{branch: branch, pos: number}}
   * @memberof LevelMe
   */
  private findBranchEnd(
    branch: branch,
    pos: number = 0
  ): { branch: branch; pos: number } {
    if (branch[0][2].length) {
      // Move further along the branch
      return this.findBranchEnd(branch[0][2], ++pos);
    } else {
      // We are at the tip! Return this branch
      return {
        branch,
        pos: ++pos,
      };
    }
  }

  /**
   * Gets the latest sequence data document
   *
   * @private
   * @param {schema} doc
   * @returns {Promise<document>}
   * @memberof LevelMe
   */
  private async seqDocFromRoot(doc: schema): Promise<document> {
    // Fetch data document from twig (Performance boost could be found here)
    const twig = this.findBranchEnd(doc.rev_tree[0].ids);

    // Get the actual data document
    return JSON.parse(
      (
        await this.levelUp.get(LevelMe.SEQ_PREFIX + twig.branch[0][0])
      ).toString()
    );
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

      // For checking on end
      const promises: Promise<document>[] = [];

      // Read / Search the database as a stream
      this.levelUp
        .createReadStream({
          gte: LevelMe.DOC_PREFIX + (options.startkey || ""),
          lt: options.endkey
            ? LevelMe.DOC_PREFIX + options.endkey
            : LevelMe.META_PREFIX,
          limit,
        })
        .on("data", async (data) => {
          // Filter out the "skipped" keys
          if (options.skip) {
            options.skip--;
            return;
          }
          const doc = JSON.parse(data.value.toString());

          // Get the actual data document
          const promise = this.seqDocFromRoot(doc);
          promises.push(promise);
          const dataDoc = await promise;

          // UI Viewer Compatible
          //dataDoc._id = data.key.slice(18).toString();
          console.log(dataDoc._id);

          //delete doc._id;
          rows.push(dataDoc);
        })
        .on("error", (err) => {
          reject(err);
        })
        .on("close", () => {})
        .on("end", async () => {
          await Promise.all(promises);
          console.log(rows);
          resolve({
            total_rows: this.docCount,
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
  public async get(key: string, raw = false) {
    await this.open();
    // Allow errors to bubble up?
    let doc = await this.levelUp.get(LevelMe.DOC_PREFIX + key);
    if (raw) {
      return doc;
    } else {
      doc = JSON.parse(doc) as schema;
      return await this.seqDocFromRoot(doc);
    }
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

    // Convert doc to string
    const incomingDoc = JSON.stringify(doc);

    // MD5 input to act as tree position
    const md5 = this.revHasher.update(incomingDoc).digest("hex");

    // Current Document root schema
    let currentDocRoot: schema;

    // Current head revision with position
    let newRev: string;

    // Flag for doc counter
    let newDoc = false;

    // Does Document eixst?
    try {
      currentDocRoot = JSON.parse(
        await this.levelUp.get(LevelMe.DOC_PREFIX + doc._id)
      ) as schema;
      // Revision / Tree Checks?
      // Activeledger does this anyway so can we gain performance not doing it here

      // find the end of the branch
      // will only have 1 branch which will be first
      const twig = this.findBranchEnd(currentDocRoot.rev_tree[0].ids);

      // Check incoming doc has the same revision
      if (doc._rev !== `${++twig.pos}-${twig.branch[0][0]}`) {
        throw "Revision Mismatch";
      }

      // Update rev_* and doc
      newRev = `${++twig.pos}-${md5}`;
      twig.branch[0][2] = [[md5, { status: "available" }, []]];
      currentDocRoot.winningRev = newRev;
      currentDocRoot.seq = currentDocRoot.rev_map[newRev] = ++this.docUpdateSeq;
      doc._rev = newRev;
    } catch (e) {
      newDoc = true;
      // Sequence cache after increase
      const seq = ++this.docUpdateSeq;
      newRev = doc._rev = `1-${md5}`;
      // New Doc
      currentDocRoot = {
        _id: doc._id,
        rev_tree: [
          {
            pos: 1,
            ids: [[md5, { status: "available" }, []]],
          },
        ],
        rev_map: {
          [newRev]: seq,
        },
        winningRev: newRev,
        deleted: false,
        seq,
      };
    }

    // increase sequence & count!

    // It is more complex than this, We need 2 documents metadata and "data" sequence doc
    //await this.levelUp.put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(doc));

    // submit as bulk
    // 1. sequence data file
    // 2. root file
    // 3. LevelMe.META_PREFIX + "_local_last_update_seq"
    // 4. LevelMe.META_PREFIX + "_local_doc_count"
    try {
      console.log("1");
      const batch = this.levelUp
        .batch()
        .put(LevelMe.SEQ_PREFIX + md5, JSON.stringify(doc))
        .put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(currentDocRoot))
        .put(LevelMe.META_PREFIX + "_local_last_update_seq", this.docUpdateSeq);

      if (newDoc) {
        console.log("2");
        await batch
          .put(LevelMe.META_PREFIX + "_local_doc_count", ++this.docCount)
          .write();
      } else {
        await batch.write();
      }
    } catch (e) {
      console.log(e);
      // Unwinde the counter increases, Incorrect count should be ok as long as it overeads
      // Actually the sequence cannot be unwound because while awaiting another document maybe pending
    }

    console.log("3");
    return {
      ok: true,
      id: doc._id,
      rev: newRev,
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
