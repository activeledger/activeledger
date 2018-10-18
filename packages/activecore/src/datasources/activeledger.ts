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

import {ActiveLogger} from '@activeledger/activelogger';
import {QueryEngine} from '@activeledger/activequery';
import {ActiveOptions} from '@activeledger/activeoptions';
// @ts-ignore
import * as PouchDB from 'pouchdb';
// @ts-ignore
import * as PouchDBFind from 'pouchdb-find';
// Add Find Plugin
PouchDB.plugin(PouchDBFind);

export class ActiveledgerDatasource {
  /**
   * PouchDB Connection
   *
   * @private
   * @static
   * @type {*}
   * @memberof ActiveledgerDatasource
   */
  private static db: any;

  /**
   * DB Query Engine
   *
   * @private
   * @static
   * @type {QueryEngine}
   * @memberof ActiveledgerDatasource
   */
  private static query: QueryEngine;

  /**
   * Get Database Connection
   *
   * @static
   * @returns
   * @memberof ActiveledgerDatasource
   */
  public static getDb() {
    if (!this.db) {
      // Self Hosted?
      if (ActiveOptions.get<any>('db', {}).selfhost) {
        // Get Database
        let db = ActiveOptions.get<any>('db', {});

        // Set Url
        db.url = 'http://127.0.0.1:' + db.selfhost.port;

        // We can also update the path to override the default couch install
        db.path = db.selfhost.dir || './.ds';

        // Set Database
        ActiveOptions.set('db', db);
      }

      // Create Database Connection
      this.db = new PouchDB(
        ActiveOptions.get<any>('db', {}).url +
          '/' +
          ActiveOptions.get<any>('db', {}).database,
      );
      this.query = new QueryEngine(
        this.db,
        false,
        ActiveOptions.get<number>('queryLimit', 0),
      );
    }
    return this.db;
  }


  /**
   * Returns Query Engine
   *
   * @static
   * @returns {QueryEngine}
   * @memberof ActiveledgerDatasource
   */
  public static getQuery(): QueryEngine {

    // Make sure we have db connection
    this.getDb();

    // Return Query Object
    return this.query;
  }
}
