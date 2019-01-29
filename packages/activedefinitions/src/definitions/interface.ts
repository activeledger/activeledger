import { EventEmitter } from "events";

/**
 * Basice interface for Neighbours
 *
 * @export
 * @interface INeighbourBase
 */
export interface INeighbourBase {
  reference: string;
  knock(endpoint: string, params?: any, external?: boolean): Promise<any>;
}

/**
 * Sends HTTP requests to the data store
 *
 * @export
 * @interface IActiveDSConnect
 */
export interface IActiveDSConnect {
  /**
   * Creates Database / Get Database Info
   *
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  info(): Promise<any>;

  /**
   * Create an index
   *
   * @param {*} options
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  createIndex(options: any): Promise<any>;

  /**
   * Returns all the documents in the database
   *
   * @param {*} options
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  allDocs(options: any): Promise<any>;

  /**
   * Get a specific document
   *
   * @param {string} id
   * @param {*} [options]
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  get(id: string, options?: any): Promise<any>;

  /**
   * Query the data store
   *
   * @param {*} options
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  find(options: any): Promise<any>;

  /**
   * Create / Append multiple documents at the same time
   *
   * @param {any[]} docs
   * @param {*} [options]
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  bulkDocs(docs: any[], options?: any): Promise<any>;

  /**
   * Create a document with auto generated id
   *
   * @param {} doc
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  post(doc: {}): Promise<any>;

  /**
   * Create / Append a document
   *
   * @param {{ _id: string }} doc
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  put(doc: { _id: string; _rev?: string }): Promise<any>;

  /**
   * Fetch latest changes (not streaming)
   *
   * @param {{}} opts
   * @returns {Promise<any>}
   * @memberof IActiveDSConnect
   */
  changes(opts: {
    live?: boolean;
    [opt: string]: any;
  }): Promise<any> | IActiveDSChanges;
}

export interface IActiveDSChanges extends EventEmitter {
  cancel(): void;
}
