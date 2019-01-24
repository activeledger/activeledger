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
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveRequest } from "./request";

/**
 * Sends HTTP requests to the data store
 *
 * @export
 * @class ActiveDSConnect
 * @implements {ActiveDefinitions.IActiveDSConnect}
 */
export class ActiveDSConnect implements ActiveDefinitions.IActiveDSConnect {
  /**
   * Creates an instance of DBConnector.
   * @param {string} location
   * @memberof DBConnector
   */
  constructor(private location: string) {}

  /**
   * Creates Database / Get Database Info
   *
   * @returns
   * @memberof ActiveDSConnect
   */
  public async info() {
    return await ActiveRequest.send(`${this.location}`, "GET");
  }

  /**
   * Create an index
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public async createIndex(options: any = {}) {
    return await ActiveRequest.send(
      `${this.location}/_index`,
      "POST",
      undefined,
      options
    );
  }

  /**
   * Returns all the documents in the database
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public async allDocs(options: any = {}) {
    return await ActiveRequest.send(
      `${this.location}/_all_docs`,
      "GET",
      undefined,
      options
    );
  }

  /**
   * Get a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public async get(id: string, options: any = {}) {
    return await ActiveRequest.send(
      `${this.location}/${id}`,
      "GET",
      undefined,
      options
    );
  }

  /**
   * Query the data store
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public async find(options: any = {}) {
    return await ActiveRequest.send(
      `${this.location}/_find`,
      "POST",
      undefined,
      options
    );
  }

  /**
   * Create / Append multiple documents at the same time
   *
   * @param {any[]} docs
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public async bulkDocs(docs: any[], options: any = {}) {
    return await ActiveRequest.send(
      `${this.location}/_bulk_docs`,
      "POST",
      undefined,
      {
        docs,
        options
      }
    );
  }

  /**
   * Create a document with auto generated id
   *
   * @param {{}} doc
   * @returns
   * @memberof ActiveDSConnect
   */
  public async post(doc: {}) {
    return await ActiveRequest.send(`${this.location}`, "POST", undefined, doc);
  }

  /**
   * Create / Append a document
   *
   * @param {{}} doc
   * @returns
   * @memberof ActiveDSConnect
   */
  public async put(doc: {}) {
    return await ActiveRequest.send(`${this.location}`, "PUT", undefined, doc);
  }
}
