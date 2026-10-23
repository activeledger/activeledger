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
