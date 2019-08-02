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
import { IActiveHttpIncoming } from "@activeledger/httpd";
import { ActiveledgerDatasource } from "./../datasource";

/**
 * Returns a list of recently changed Activity Streams
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function changes(incoming: IActiveHttpIncoming): Promise<object> {
  const changes = await ActiveledgerDatasource.getDb().changes({
    descending: true,
    include_docs:
      (incoming.query.include_docs || false) == "true" ? true : false,
    limit: (incoming.query.limit || 10) * 3
  });
  if (changes) {
    // Filter in only the stream data documents
    let dataDocs = [];
    let i = changes.results.length;
    while (i--) {
      if (
        changes.results[i].id.indexOf(":") === -1 &&
        changes.results[i].id.indexOf("_design") === -1
      ) {
        dataDocs.push(changes.results[i]);
      }
    }
    return {
      changes: dataDocs
    };
  } else {
    return changes;
  }
}

/**
 * Get an Activity Stream Volatile Data
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function getVolatile(
  incoming: IActiveHttpIncoming
): Promise<object> {
  const results = await ActiveledgerDatasource.getDb().get(
    incoming.url[2] + ":volatile"
  );
  if (results) {
    delete results._id, results._rev;
    return {
      stream: results
    };
  } else {
    return results;
  }
}

/**
 * Set an Activity Stream Volatile Data
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function setVolatile(
  incoming: IActiveHttpIncoming
): Promise<object> {
  // Get Latest Version
  let results = await ActiveledgerDatasource.getDb().get(
    incoming.url[2] + ":volatile"
  );
  if (results) {
    // Update _id and _rev
    incoming.body._id = results._id;
    incoming.body._rev = results._rev;

    // Commit changes
    try {
      results = await ActiveledgerDatasource.getDb().put(incoming.body);
    } catch (error) {
      console.log(error);
    }
    return {
      success: results.ok
    };
  } else {
    return results;
  }
}

/**
 * Get an Activity Stream Data State
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function getStream(
  incoming: IActiveHttpIncoming
): Promise<object> {
  const results = await ActiveledgerDatasource.getDb().get(incoming.url[2]);
  if (results) {
    delete results._id, results._rev;
    return {
      stream: results
    };
  } else {
    return results;
  }
}

/**
 * Get multiple Activity Streams Data States
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function getStreams(
  incoming: IActiveHttpIncoming
): Promise<object> {
  const results = await ActiveledgerDatasource.getDb().allDocs({
    include_docs: true,
    keys: incoming.body
  });
  if (results) {
    // Normalise the data from rows[].doc
    let i = results.rows.length;
    let streams = [];
    while (i--) {
      streams.push(results.rows[i].doc);
    }
    return {
      streams
    };
  } else {
    return results;
  }
}
