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

import PouchDB from "./pouchdb";
import PouchDBFind from "./pouchdbfind";
import { ActiveDefinitions } from '@activeledger/activedefinitions';
import { IActiveDSConnect } from '../../activedefinitions/src/definitions/interface';

// Add Find Plugin
PouchDB.plugin(PouchDBFind);

export class ActiveDSConnect implements ActiveDefinitions.IActiveDSConnect {
  /**
   *
   *
   * @private
   * @type {*}
   * @memberof DBConnector
   */
  private pDb: any;

  /**
   * Creates an instance of DBConnector.
   * @param {string} location
   * @memberof DBConnector
   */
  constructor(location: string) {
    // Create Database
    this.pDb = new PouchDB(location);
  }

  public info() {
    return this.pDb.info();
  }

  public createIndex(options: any = {}) {
    return this.pDb.createIndex(options);
  }

  public allDocs(options: any = {}) {
    return this.pDb.allDocs(options);
  }

  public get(id: string, options: any = {}) {
    return this.pDb.get(id, options);
  }

  public find(options: any = {}) {
    return this.pDb.find(options);
  }

  public bulkDocs(docs: [], options: any = {}) {
    return this.pDb.bulkDocs(docs, options);
  }

  public post(doc: {}) {
    return this.pDb.post(doc);
  }
}
