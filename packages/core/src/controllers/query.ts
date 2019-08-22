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
 * Query Activeledger Datastore via sql / mango
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function search(incoming: IActiveHttpIncoming): Promise<object> {
  let results;

  // POST
  if (incoming.body) {
    if (incoming.body.sql && incoming.body.sql.length > 15) {
      results = await ActiveledgerDatasource.getQuery().sql(incoming.body.sql);
    }

    if (incoming.body.mango && Object.keys(incoming.body.mango).length > 0) {
      results = await ActiveledgerDatasource.getQuery().mango(
        incoming.body.mango
      );
    }
  } else {
    // Query
    results = await ActiveledgerDatasource.getQuery().sql(incoming.query.sql);
  }

  if (results) {
    let warning = ActiveledgerDatasource.getQuery().getLastWarning();
    if (warning) {
      return {
        streams: results,
        warning: warning
      };
    } else {
      return {
        streams: results
      };
    }
  } else {
    return {
      streams: [],
      warning: {
        query: "N/A",
        message: "No SQL or Mango query found"
      }
    };
  }
}