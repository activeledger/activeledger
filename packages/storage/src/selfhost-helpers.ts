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
import { randomUUID } from "crypto";
import { promises as fsPromises } from "fs";

/*
 * Request preparation shared by the storage process's HTTP handlers
 * (selfhost.ts) and the in-process adapter (embedded.ts). Kept in one place
 * so the two paths cannot drift apart.
 */

/**
 * Database names the store will open. Every distinct name opens (and
 * creates) its own LevelDB directory, so an unchecked name lets a caller
 * create databases on disk without limit.
 */
export const isValidDbName = (name: string): boolean =>
  /^activeledger[A-Za-z0-9_-]{0,64}$/.test(name);

/**
 * Checks for the existant of _id if not ads it and returns
 *
 * @param {*} doc
 * @returns {*}
 */
export const checkDoc = (doc: any): any => {
  if (!doc._id) doc._id = randomUUID();
  return doc;
};

/**
 * C/Pouch conversion utility tool for _all_docs
 *
 * @param {*} options
 * @returns
 */
export const prepareAllDocs = (options: any) => {
  // Convert Limit
  if (options.limit) {
    options.limit = parseInt(options.limit) || null;
  }

  // Convert startkey to remove "
  if (options.startkey) {
    options.startkey = options.startkey.replace(/"/g, "");
  }

  // Convert endkey to remove " and keep unicode search
  if (options.endkey) {
    options.endkey = options.endkey.replace(/"/g, "");
    options.endkey = options.endkey.slice(0, -1) + "香";
  }

  // Filter prefixes
  // Leaving this in even though filtering in permissionsChecker as well
  if (options.keys) {
    options.keys = options.keys.map((id: string) => filterPrefix(id));
  }
  return options;
};

// Filters any prefix (so they're virtual) (: reserved character) to real stream id
export const filterPrefix = (stream: string, db?: string): string => {

  // Only need to filter activeledger, making optional just in case not passed
  if (db && db !== 'activeledger') {
    return stream;
  } else {
    // Remove any suffix like :volatile :stream :umid
    let [streamId, suffix] = stream.split(":");

    // If id length more than 64 trim the start
    if (streamId.length > 64 && !streamId.startsWith("0x")) {
      streamId = streamId.slice(-64);
    }

    // If suffix add it back to return
    if (suffix) {
      return streamId + ":" + suffix;
    }

    // Return just the id
    return streamId;
  }
};

/**
 * Whether a file in a database directory holds data: the tables (.ldb, or
 * .sst under RocksDB), the write-ahead log (a numbered .log, which keeps the
 * latest writes until they are flushed into a table) and the manifest. The
 * text logs (LOG, LOG.old), CURRENT and LOCK hold none; the text logs grow
 * with every compaction on a long-running node.
 *
 * @param {string} name
 * @returns {boolean}
 */
export const isDataFile = (name: string): boolean =>
  /\.(ldb|sst)$/.test(name) || /^\d+\.log$/.test(name) || /^MANIFEST-\d+$/.test(name);

/**
 * Bytes the database keeps its data in on disk. A file a compaction removes
 * between the listing and the stat is not counted, instead of failing the
 * call.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
export const dataSize = async (dir: string): Promise<number> => {
  const files = (await fsPromises.readdir(dir)).filter(isDataFile);
  const stats = await Promise.all(
    files.map((file) => fsPromises.stat(dir + "/" + file).catch(() => undefined))
  );
  return stats.reduce((total, stat) => total + (stat?.size ?? 0), 0);
};
