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
  public info(): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}`, "GET")
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Create an index
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public createIndex(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_index`, "POST", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(error => reject(error));
    });
  }

  /**
   * Returns all the documents in the database
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public allDocs(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/_all_docs`,
        "GET",
        undefined,
        options
      ).then((response: any) => resolve(response.data))
      .catch(error => reject(error));
    });
  }

  /**
   * Get a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public get(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/${id}`,
        "GET",
        undefined,
        options
      ).then((response: any) => resolve(response.data))
      .catch(error => reject(error));
    });
  }

  /**
   * Query the data store
   *
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public find(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/_find`,
        "POST",
        undefined,
        options
      ).then((response: any) => resolve(response.data))
      .catch(error => reject(error));
    });
  }

  /**
   * Create / Append multiple documents at the same time
   *
   * @param {any[]} docs
   * @param {*} [options={}]
   * @returns
   * @memberof ActiveDSConnect
   */
  public bulkDocs(docs: any[], options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/_bulk_docs`,
        "POST",
        undefined,
        {
          docs,
          options
        }
      ).then((response: any) => resolve(response.data))
      .catch(error => reject(error));
    });
  }

  /**
   * Create a document with auto generated id
   *
   * @param {} doc
   * @returns
   * @memberof ActiveDSConnect
   */
  public post(doc: {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        this.location,
        "POST",
        undefined,
        doc
      ).then((response: any) => resolve(response.data))
      .catch(error => reject(error));
    });
  }

  /**
   * Create / Append a document
   *
   * @param {{ _id: string }} doc
   * @returns
   * @memberof ActiveDSConnect
   */
  public put(doc: { _id: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(
        `${this.location}/${doc._id}`,
        "PUT",
        undefined,
        doc
      ).then((response: any) => resolve(response.data))
      .catch(error => reject(error));
    });
  }
}
