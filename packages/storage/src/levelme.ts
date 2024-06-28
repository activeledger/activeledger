import { createHash } from "crypto";
import RocksDB from "rocksdb";
import { LevelUp, default as levelup, LevelUpChain } from "levelup";
import LevelDOWN from "leveldown";
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

const REMOVE_CACHE_TIMER = 0.5 * 60 * 1000;

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

  /**
   * Holds the local copy of LevelUp
   *
   * @private
   * @type {LevelUp}
   */
  private levelUp: LevelUp;

  /**
   * Real-time document count in the database
   *
   * @private
   */
  //private docCount = 0;

  /**
   * Real-time document sequencing in the database
   *
   * @private
   */
  //private docUpdateSeq = 0;

  constructor(location: string, private name: string, provider: string) {
    if (provider === "rocks") {
      this.levelUp = levelup(RocksDB(location + name));
    } else {
      this.levelUp = levelup(LevelDOWN(location + name));
    }
    this.timerUnCache();
  }

  /**
   * Clears Cache
   *
   * @private
   */
  private timerUnCache() {
    setTimeout(() => {
      const memory = Object.keys(this.memory);
      const nowMinus = new Date(Date.now() - REMOVE_CACHE_TIMER);
      for (let i = memory.length; i--; ) {
        if (this.memory[memory[i]].data < nowMinus) {
          // 30 seconds has passed without accessing it so lets clear
          delete this.memory[memory[i]];
        }
      }
      this.timerUnCache();
    }, REMOVE_CACHE_TIMER * 2);
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

      // Cache Values
      // this.docCount = parseInt(
      //   (
      //     await this.levelUpGet(LevelMe.META_PREFIX + "_local_doc_count", 0)
      //   ).toString()
      // );
      // this.docUpdateSeq = parseInt(
      //   (
      //     await this.levelUpGet(
      //       LevelMe.META_PREFIX + "_local_last_update_seq",
      //       0
      //     )
      //   ).toString()
      // );
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
   */
  // private findBranchEnd(
  //   branch: branchTrunk | branch,
  //   pos: number = 0
  // ): { branch: branchTrunk; pos: number } {
  //   let branchTrunk: branchTrunk;

  //   // Find legacy branchTrunk (sometimes in 0 nested array)
  //   if (Array.isArray(branch[0])) {
  //     branchTrunk = branch[0] as branchTrunk;
  //   } else {
  //     branchTrunk = branch as branchTrunk;
  //   }

  //   // Need to search deeper?
  //   if (branchTrunk[2].length) {
  //     // Move further along the branch
  //     return this.findBranchEnd(branchTrunk[2], ++pos);
  //   } else {
  //     // We are at the tip! Return this branch
  //     return {
  //       branch: branchTrunk,
  //       pos: ++pos,
  //     };
  //   }
  // }

  /**
   * Jump straight to the cached wining branch end
   *
   * @private
   * @param {schema} doc
   * @returns {{ key: string; pos: number }}
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
   */
  private async seqDocFromRoot(doc: schema): Promise<document> {
    // Backwards Compatible Check
    // If winningRev, rev_map, rev_tree, seq exist we know its the old system
    if (doc.winningRev && doc.rev_map && doc.rev_tree && doc.seq) {
      // Fetch data document from twig (Performance boost could be found here)
      const twig = this.findCachedBranchEnd(doc);

      // Get the actual data document
      return JSON.parse(
        (await this.levelUpGet(LevelMe.SEQ_PREFIX + twig, "{}")).toString()
      );
    } else {
      // Now it is just the raw document which we build up on from umid and txs
      return doc as document;
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
      //await this.levelUp.put(LevelMe.META_PREFIX + "_local_doc_count", 0);
      //await this.levelUp.put(LevelMe.META_PREFIX + "_local_last_update_seq", 0);
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

        // For checking on end
        const promises: Promise<document>[] = [];

        if (options.keys) {
          // for (let i = options.keys.length; i--;) {
          //   rows.push({ doc: await this.get(options.keys[i]) });
          // }

          rows = await this.getMany(options.keys);
          // Don't think much perfomance gain by a single await vs multi
          //await Promise.all(promises);
          return resolve({
            total_rows: rows.length,
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

              // Don't realy need this but the quickest switch for needing "id" for database viewer
              // Only viewer should call, So want the doc
              if (options.include_docs) {
                // Get the actual data document
                const promise = this.seqDocFromRoot(doc);
                promises.push(promise);
                rows.push(await promise);
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
            .on("close", () => {})
            .on("end", async () => {
              await Promise.all(promises);
              resolve({
                total_rows: rows.length, //this.docCount, This will return as a global offset
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

  private memory: {
    [index: string]: {
      data: any;
      create: Date;
    };
  } = {};

  /**
   * Get a specific data document
   *
   * @param {string} key
   * @returns
   */
  public async get(key: string, raw = false) {
    if (!this.memory[key]) {
      await this.open();
      // Allow errors to bubble up?
      let doc = JSON.parse(await this.levelUp.get(LevelMe.DOC_PREFIX + key));
      if (raw) {
        //return doc;
        this.memory[key] = {
          data: doc,
          create: new Date(),
        };
        //return JSON.parse(doc);
      } else {
        //return await this.seqDocFromRoot(doc);
        doc = JSON.parse(doc) as schema;
        this.memory[key] = {
          data: await this.seqDocFromRoot(doc),
          create: new Date(),
        };
      }
    }
    return this.memory[key].data;
  }

  public async getMany(keys: string[]): Promise<any[]> {
    // for (let i = keys.length; i--;) {
    //   keys[i] = LevelMe.DOC_PREFIX + keys[i];
    // }

    //return await this.levelUp.getMany(keys);

    let tmpKeys = [];
    let cached = [];
    const now = new Date();
    for (let i = keys.length; i--; ) {
      if (!this.memory[keys[i]]) {
        tmpKeys.push(LevelMe.DOC_PREFIX + keys[i]);
      } else {
        cached.push({ doc: this.memory[keys[i]].data });
        this.memory[keys[i]].create = now;
      }
    }

    // Get uncached keys
    //if (tmpKeys.length) {
    const result = await this.levelUp.getMany(tmpKeys);

    // Loop and cache
    for (let i = result.length; i--; ) {
      const data = JSON.parse(result[i]);

      this.memory[data._id] = {
        data: data,
        create: new Date(),
      };
      cached.push({ doc: data });
    }
    //}
    return cached;
    //Faster Concat? maybe push(...)?
    //return [...cached, ...await this.levelUp.getMany(tmpKeys)];
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
      // Emit Changed Doc
      this.changeEmitter.emit("change", writer.changes);
    } catch (e) {
      // Unwinde the counter increases, Incorrect count should be ok as long as it overeads
      //this.docCount--;
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
    batch
      // .put(
      //   LevelMe.META_PREFIX + "_local_doc_count",
      //   this.docCount > 0 ? --this.docCount : (this.docCount = 0)
      // )
      .del(LevelMe.DOC_PREFIX + key);

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

    for (let i = keys.length; i--; ) {
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
        .on("close", () => {})
        .on("end", async () => {
          await Promise.all(promises);
          resolve({
            results: rows,
            last_seq: 0,
          });
        });
    });
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
    options: { new_edits: boolean }
  ): Promise<boolean> {
    // Now we could loop post, But then its not a single atomic write.
    let batch = await this.levelUp.batch();
    const changes = [];
    for (let i = docs.length; i--; ) {
      // Deleted? This is dangerous as you could set _deleted in your stream! Disable multi delete from viewer safer
      //if (docs[i]._deleted) {
      //  await this.del(docs[i]._id);
      //} else {
      const writer = await this.prepareForWrite(docs[i], batch, options);
      batch = writer.chain; // Do I need do do this, Reference kept?
      changes.push(writer.changes);
      //}
    }

    try {
      await batch.write();
      // Emit Changed Docs
      this.changeEmitter.emit("change", changes);
    } catch (e) {
      // Unwinde the counter increases, Incorrect count should be ok as long as it overeads
      //this.docCount = this.docCount - docs.length;
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
    options: { new_edits: boolean } = { new_edits: true }
  ): Promise<{
    chain: LevelUpChain<any, any>;
    rev: string;
    changes: {
      id: string;
      changes: { rev: string }[];
      doc: document;
      //seq: number;
    };
  }> {
    await this.open();

    // Convert doc to string
    const incomingDoc = JSON.stringify(doc);

    // Changes that will be written
    //const changes = {};

    // MD5 input to act as tree position
    const md5 = createHash("md5").update(incomingDoc).digest("hex");

    // Current Document root schema
    let currentDocRoot: document;

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
      //const twig = this.findBranchEnd(currentDocRoot.rev_tree[0].ids);

      // Check incoming doc has the same revision
      //if (doc._rev !== `${twig.pos}-${twig.branch[0]}`) {

      // We need to pull out the right revision
      const currentRev =
        currentDocRoot._rev || (currentDocRoot.winningRev as string);

      // Replace with winning rev instead of branch crawling
      if (currentRev) {
        if (doc._rev !== currentRev) {
          throw { msg: "Revision Mismatch", throw: 1 };
        }

        // Get more relilable position value (crawler incorrect on auto archive)
        const pos = parseInt(currentRev.split("-")[0]) + 1;

        // Update rev_* and doc
        newRev = `${pos}-${md5}`;
        //twig.branch[2] = [[md5, { status: "available" }, []]];
        //currentDocRoot.winningRev = doc._rev = newRev;
        doc._rev = newRev;
        //currentDocRoot.seq = currentDocRoot.rev_map[newRev] = ++this
        //  .docUpdateSeq;
      } else {
        throw { msg: "Revision Mismatch Type 2", throw: 1 };
      }
    } catch (e) {
      if (e?.throw) {
        throw new Error(e.msg);
      }

      newDoc = true;
      // Sequence cache after increase
      //const seq = ++this.docUpdateSeq;

      if (!options.new_edits && doc._rev) {
        newRev = doc._rev;
      } else {
        newRev = doc._rev = `1-${md5}`;
      }

      // New Doc
      // currentDocRoot = {
      //   _id: doc._id,
      //   rev_tree: [
      //     {
      //       pos: 1,
      //       ids: [md5, { status: "available" }, []],
      //     },
      //   ],
      //   rev_map: {
      //     [newRev]: seq,
      //   },
      //   winningRev: newRev,
      //   deleted: false,
      //   seq,
      // };
    }

    // submit as bulk
    // 1. sequence data file
    // 2. root file
    // 3. LevelMe.META_PREFIX + "_local_last_update_seq"
    // 4. LevelMe.META_PREFIX + "_local_doc_count"
    chain
      //.put(LevelMe.SEQ_PREFIX + md5, JSON.stringify(doc))
      //.put(
      //  LevelMe.SEQ_PREFIX + this.docUpdateSeq.toString().padStart(16, "0"),
      //  JSON.stringify(doc)
      //)
      //.put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(currentDocRoot));
      .put(LevelMe.DOC_PREFIX + doc._id, JSON.stringify(doc));
    //.put(LevelMe.META_PREFIX + "_local_last_update_seq", this.docUpdateSeq);

    // Include only data streams
    // We skip this if not stream document, about 3 less writes per stream
    // if (doc._id.indexOf(":") === -1) {
    //   chain.put(
    //     LevelMe.SEQ_META_PREFIX +
    //       this.docUpdateSeq.toString().padStart(30, "0"),
    //     `{"_id": "${doc._id}" ,"_rev": "${doc._rev}"}`
    //   );
    // }

    // if (newDoc) {
    //   chain.put(LevelMe.META_PREFIX + "_local_doc_count", ++this.docCount);
    // }

    // Should be able to assume,  maybe not what if restarted, So set object!
    // Maybe only store data and :stream? Or just store everything and delete when older than X?
    this.memory[doc._id] = {
      data: doc,
      create: new Date()
    };

    // Safer for now?
    //delete this.memory[doc._id];

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
        //seq: this.docUpdateSeq,
      },
    };
  }
}
