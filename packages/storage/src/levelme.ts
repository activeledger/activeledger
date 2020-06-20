import { createHash } from "crypto";
import RocksDB from "rocksdb";
import { LevelUp, default as levelup, LevelUpChain } from "levelup";
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
 * Status of branch availibility. Typically "available"
 *
 * @interface branchStatus
 */
interface branchStatus {
  status: string;
}

/**
 * Tuple of a branch
 *
 * @tuple tree
 */
type branch = [[string, branchStatus, branch]] | [];

/**
 * Tuple of a branch trunk (not initially nested array )
 *
 * @tuple tree
 */
type branchTrunk = [string, branchStatus, branch];

/**
 * Root of data tree
 *
 * @interface tree
 */
interface tree {
  pos: number;
  ids: branchTrunk;
}

/**
 * Root document schema for tracking changes
 *
 * @interface schema
 * @extends {document}
 */
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
   * ÿby-sequenceÿ0000000000000110
   *
   * @private
   * @static
   * @memberof LevelMe
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
   * @memberof LevelMe
   */
  //private static SEQ_META_PREFIX = "ÿsequence-storeÿ";

  /**
   * Live changes emitter
   *
   * @private
   * @static
   * @memberof LevelMe
   */
  private changeEmitter = new EventEmitter();

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
      this.docCount = parseInt(
        (
          await this.levelUp.get(LevelMe.META_PREFIX + "_local_doc_count")
        ).toString()
      );
      this.docUpdateSeq = parseInt(
        (
          await this.levelUp.get(LevelMe.META_PREFIX + "_local_last_update_seq")
        ).toString()
      );
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
    branch: branchTrunk | branch,
    pos: number = 0
  ): { branch: branchTrunk; pos: number } {
    let branchTrunk: branchTrunk;

    // Find legacy branchTrunk (sometimes in 0 nested array)
    if (Array.isArray(branch[0])) {
      branchTrunk = branch[0] as branchTrunk;
    } else {
      branchTrunk = branch as branchTrunk;
    }

    // Need to search deeper?
    if (branchTrunk[2].length) {
      // Move further along the branch
      return this.findBranchEnd(branchTrunk[2], ++pos);
    } else {
      // We are at the tip! Return this branch
      return {
        branch: branchTrunk,
        pos: ++pos,
      };
    }
  }

  /**
   * Jump straight to the cached wining branch end
   *
   * @private
   * @param {schema} doc
   * @returns {{ key: string; pos: number }}
   * @memberof LevelMe
   */
  private findCachedBranchEnd(doc: schema): string {
    return doc.rev_map[doc.winningRev].toString().padStart(16, "0");
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
    const twig = this.findCachedBranchEnd(doc);

    // Get the actual data document
    return JSON.parse(
      (await this.levelUp.get(LevelMe.SEQ_PREFIX + twig)).toString()
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

      // Cache rows to be returned
      const rows: any[] = [];

      // For checking on end
      const promises: Promise<document>[] = [];

      if (options.keys) {
        for (let i = options.keys.length; i--; ) {
          rows.push({ doc: await this.get(options.keys[i]) });
        }

        // Don't think much perfomance gain by a single await vs multi
        //await Promise.all(promises);
        return resolve({
          total_rows: rows.length,
          offset: 0, // TODO match this up, May need more document to test, Or maybe not needed
          rows,
        });
      } else {
        // No offset built in, Create one by skip + limit and counter on skip;
        let limit = options.limit || -1;
        if (options.skip && limit !== -1) {
          // Convert to int
          options.skip = parseInt((options.skip as unknown) as string);
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

            // Don't realy need this but the quickest switch for needing "id" for database viewer
            // Only viewer should call, So want the doc
            //if (options.include_docs) {
            // Get the actual data document
            const promise = this.seqDocFromRoot(doc);
            promises.push(promise);
            rows.push(await promise);
            // } else {
            //   doc.id = doc._id;
            //   rows.push(doc);
            // }
          })
          .on("error", (err: unknown) => {
            reject(err);
          })
          .on("close", () => {})
          .on("end", async () => {
            await Promise.all(promises);
            resolve({
              total_rows: this.docCount,
              offset: 0, // TODO match this up, May need more document to test, Or maybe not needed
              rows,
            });
          });
      }
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
      return JSON.parse(doc);
    } else {
      doc = JSON.parse(doc) as schema;
      return await this.seqDocFromRoot(doc);
    }
  }

  /**
   * Get a specific sequence document
   *
   * @param {string} seq
   * @returns
   * @memberof LevelMe
   */
  public async getSeq(seq: string) {
    return this.levelUp.get(LevelMe.SEQ_PREFIX + seq);
  }

  /**
   * Writes a data document (following sequences and revision information)
   *
   * @param {document} doc
   * @returns
   * @memberof LevelMe
   */
  public async post(doc: document) {
    const writer = await this.prepareForWrite(doc, this.levelUp.batch());
    try {
      await writer.chain.write();
      // Emit Changed Doc
      this.changeEmitter.emit("change", writer.changes);
    } catch (e) {
      // Unwinde the counter increases, Incorrect count should be ok as long as it overeads
      this.docCount--;
      // Actually the sequence cannot be unwound because while awaiting another document maybe pending
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
  public async del(key: string): Promise<void> {
    await this.open();
    await this.levelUp.del(key);
    return;
  }

  /**
   * Provide real-time document insertion with starting point supported
   *
   * @param {string} options
   * @returns {*}
   * @memberof LevelMe
   */
  public changesFromSeq(
    options: changesOptions
  ): Promise<{
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
          console.log(data.key.toString());
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
        .on("close", () => {})
        .on("end", async () => {
          await Promise.all(promises);
          resolve({
            results: rows,
            last_seq: this.docUpdateSeq,
          });
        });
    });
  }

  /**
   * Provide real-time document insertion with starting point supported
   *
   * @param {string} options
   * @returns {*}
   * @memberof LevelMe
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
   * @memberof LevelMe
   */
  public async bulkDocs(docs: document[]): Promise<boolean> {
    // Now we could loop post, But then its not a single atomic write.
    let batch = await this.levelUp.batch();
    const changes = [];
    for (let i = docs.length; i--; ) {
      const writer = await this.prepareForWrite(docs[i], batch);
      batch = writer.chain; // Do I need do do this, Reference kept?
      changes.push(writer.changes);
    }

    try {
      await batch.write();
      // Emit Changed Docs
      this.changeEmitter.emit("change", changes);
    } catch (e) {
      // Unwinde the counter increases, Incorrect count should be ok as long as it overeads
      this.docCount = this.docCount - docs.length;
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
   * @memberof LevelMe
   */
  private async prepareForWrite(
    doc: document,
    chain: LevelUpChain<any, any>
  ): Promise<{
    chain: LevelUpChain<any, any>;
    rev: string;
    changes: {
      id: string;
      changes: { rev: string }[];
      doc: document;
      seq: number;
    };
  }> {
    await this.open();

    // Convert doc to string
    const incomingDoc = JSON.stringify(doc);

    // Changes that will be written
    const changes = {};

    // MD5 input to act as tree position
    const md5 = createHash("md5").update(incomingDoc).digest("hex");

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
      //if (doc._rev !== `${twig.pos}-${twig.branch[0]}`) {

      // Replace with winning rev instead of branch crawling
      if (doc._rev !== currentDocRoot.winningRev) {
        throw { msg: "Revision Mismatch", throw: 1 };
      }

      // Get more relilable position value (crawler incorrect on auto archive)
      const pos = parseInt(currentDocRoot.winningRev.split("-")[0]) + 1;

      // Update rev_* and doc
      newRev = `${pos}-${md5}`;
      twig.branch[2] = [[md5, { status: "available" }, []]];
      currentDocRoot.winningRev = doc._rev = newRev;
      currentDocRoot.seq = currentDocRoot.rev_map[newRev] = ++this.docUpdateSeq;
    } catch (e) {
      if (e?.throw) {
        throw new Error(e.msg);
      }

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
            ids: [md5, { status: "available" }, []],
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

    // submit as bulk
    // 1. sequence data file
    // 2. root file
    // 3. LevelMe.META_PREFIX + "_local_last_update_seq"
    // 4. LevelMe.META_PREFIX + "_local_doc_count"
    chain
      //.put(LevelMe.SEQ_PREFIX + md5, JSON.stringify(doc))
      .put(
        LevelMe.SEQ_PREFIX + this.docUpdateSeq.toString().padStart(16, "0"),
        JSON.stringify(doc)
      )
      .put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(currentDocRoot))
      .put(LevelMe.META_PREFIX + "_local_last_update_seq", this.docUpdateSeq);

    // Include only data streams
    // We skip this if not stream document, about 3 less writes per stream
    // if (doc._id.indexOf(":") === -1) {
    //   chain.put(
    //     LevelMe.SEQ_META_PREFIX +
    //       this.docUpdateSeq.toString().padStart(30, "0"),
    //     `{"_id": "${doc._id}" ,"_rev": "${doc._rev}"}`
    //   );
    // }

    if (newDoc) {
      chain.put(LevelMe.META_PREFIX + "_local_doc_count", ++this.docCount);
    }

    return {
      chain,
      rev: newRev,
      changes: {
        id: doc._id,
        changes: [
          {
            rev: newRev,
          },
        ],
        doc,
        seq: this.docUpdateSeq,
      },
    };
  }
}
