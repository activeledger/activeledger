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
import * as fs from "fs";
import * as path from "path";
import { ActiveCacheManager } from "@activeledger/activeoptions";
import type { ActiveDSConnect } from "@activeledger/activeoptions";
import { LevelMe } from "./levelme";
import { eventsSince } from "./events";
import {
  checkDoc,
  filterPrefix,
  isValidDbName,
  prepareAllDocs,
} from "./selfhost-helpers";

/**
 * The part of ActiveDSConnect that protocol, network and restore actually
 * call. ActiveDSConnect satisfies it structurally (checked below), and so
 * does EmbeddedDSConnect.
 */
export interface IDSConnect {
  info(): Promise<any>;
  get(id: string, options?: any): Promise<any>;
  exists(id: string): Promise<Boolean>;
  allDocs(options?: any): Promise<any>;
  bulkDocs(docs: any[], options?: any, timeout?: number): Promise<any>;
  post(doc: {}): Promise<any>;
  put(doc: { _id: string; _rev?: string }): Promise<any>;
  purge(doc: { _id: string; _rev?: string }): Promise<any>;
  clearCache(key: string): void;
}

// Fails to compile if ActiveDSConnect stops matching IDSConnect.
type ImplementsIDSConnect<T extends IDSConnect> = T;
type ActiveDSConnectIsIDSConnect = ImplementsIDSConnect<ActiveDSConnect>;

/**
 * What an ActiveDSConnect caller receives for a value the storage process
 * answered with.
 *
 * ActiveRequest.send() never rejects: whatever httpd wrote is JSON-parsed
 * and resolved, success or failure alike. httpd JSON-serialises an object
 * (a thrown Error keeps only its own enumerable properties, so LevelMe's
 * not-found error arrives as {code: "LEVEL_NOT_FOUND", notFound: true, ...}),
 * writes nothing for a falsy result, and writes anything else raw. An
 * unparseable or empty body resolves as null.
 *
 * The round trip is also what keeps callers away from LevelMe's own cached
 * objects, which they would otherwise mutate in place.
 */
const overTheWire = (value: unknown): any => {
  if (!value) {
    return null;
  }
  try {
    if (typeof value === "object" && !Buffer.isBuffer(value)) {
      return JSON.parse(JSON.stringify(value));
    }
    return JSON.parse(value.toString());
  } catch {
    return null;
  }
};

/**
 * What the storage process receives for a request body: a fresh copy, so
 * LevelMe (which sets _rev and _id on the document it is given, and caches
 * it) never holds a reference to the caller's object.
 */
const requestBody = (data: any): any => JSON.parse(JSON.stringify(data));

/**
 * ActiveDSConnect without the HTTP hop: the same calls, answered by a LevelMe
 * in this process.
 *
 * Each method does what selfhost.ts's handler for the matching route does,
 * then hands back what ActiveDSConnect would have resolved with - including
 * resolving (never rejecting) with the serialised error on failure.
 *
 * @export
 * @class EmbeddedDSConnect
 * @implements {IDSConnect}
 */
export class EmbeddedDSConnect implements IDSConnect {
  /**
   * The underlying store. Its changes() emitter is the live feed the
   * storage process's /events and _changes handlers listen to.
   */
  public readonly level: LevelMe;

  /**
   * Directory holding this database's LevelDB files.
   */
  private readonly dir: string;

  /**
   * @param {string} location Data directory, with trailing separator
   * @param {string} name Database name, as in config db.database/event/error
   * @param {string} [engine="level"] Storage driver, as db.selfhost.engine
   */
  constructor(location: string, public readonly name: string, engine = "level") {
    if (!isValidDbName(name)) {
      throw new Error(`invalid database - ${name}`);
    }
    // LevelMe's read cache is process-wide per database name. A storage
    // process starts with it empty; so does this, rather than serving
    // whatever an earlier store of the same name left in it.
    ActiveCacheManager.fetch(`streams:${name}`).clear();
    this.level = new LevelMe(location, name, engine);
    this.dir = location + name;
  }

  /**
   * GET /:db - database info, with data_size summed from its files.
   */
  public info(): Promise<any> {
    return this.answer(async () => {
      const info: any = await this.level.info();
      const files = await fs.promises.readdir(this.dir);
      const stats = await Promise.all(
        files.map((source) => fs.promises.stat(this.dir + "/" + source))
      );
      info.data_size = stats.reduce((total, stat) => total + stat.size, 0);
      return info;
    });
  }

  /**
   * GET /:db/:id. Options are accepted for compatibility and, as over HTTP
   * (a GET carries no body), ignored.
   */
  public get(id: string, options: any = {}): Promise<any> {
    return this.answer(() => this.level.get(filterPrefix(id, this.name)));
  }

  /**
   * True when the document exists, judged as ActiveDSConnect judges it.
   */
  public async exists(id: string): Promise<boolean> {
    const data = await this.get(id);
    return data?._id ? true : false;
  }

  /**
   * GET (no options) or POST /:db/_all_docs.
   */
  public allDocs(options?: any): Promise<any> {
    return this.answer(() =>
      this.level.allDocs(
        prepareAllDocs(options ? Object.assign({}, requestBody(options)) : {})
      )
    );
  }

  /**
   * POST /:db/_bulk_docs. Resolves {ok: true} or {ok: false}.
   *
   * @param {number} [timeout] accepted for compatibility; there is no
   * request to time out
   */
  public bulkDocs(docs: any[], options: any = {}, timeout?: number): Promise<any> {
    return this.answer(async () => {
      const body = requestBody({ docs, options });
      if (!Array.isArray(body) && body.docs) {
        return { ok: await this.level.bulkDocs(body.docs, body.options) };
      }
    });
  }

  /**
   * POST /:db - write a document, generating its _id if it has none.
   */
  public post(doc: {}): Promise<any> {
    return this.answer(async () => {
      try {
        return await this.level.post(checkDoc(requestBody(doc)));
      } catch (e) {
        e.reason = e.message;
        throw e;
      }
    });
  }

  /**
   * PUT /:db/:id - write a document. The id is taken from the body.
   */
  public put(doc: { _id: string; _rev?: string }): Promise<any> {
    return this.answer(async () => {
      try {
        return await this.level.put(requestBody(doc));
      } catch (e) {
        e.reason = e.message;
        throw e;
      }
    });
  }

  /**
   * DELETE /:db/:id - the self-hosted purge.
   */
  public purge(doc: { _id: string; _rev?: string }): Promise<any> {
    return this.answer(async () => {
      await this.level.del(filterPrefix(decodeURIComponent(doc._id), this.name));
      return { success: "ok" };
    });
  }

  /**
   * ActiveDSConnect's own client-side cache is never filled, so clearing it
   * does nothing. LevelMe's cache is invalidated by its own writes.
   */
  public clearCache(key: string): void {}

  /**
   * Events after `lastEventId`, oldest first, for an SSE client resuming
   * with Last-Event-ID - read from this database as /:db/events does.
   */
  public eventsSince(
    lastEventId: string
  ): Promise<Array<[string, Record<string, unknown>]>> {
    return eventsSince(this.level, lastEventId);
  }

  /**
   * Close the underlying LevelDB. It must have been opened (any read or
   * write, or info(), opens it).
   */
  public close(): Promise<void> {
    return this.level.close();
  }

  /**
   * Runs a route's work and resolves with what an HTTP caller would get.
   */
  private async answer(work: () => Promise<unknown>): Promise<any> {
    let result: unknown;
    try {
      result = await work();
    } catch (e) {
      result = e;
    }
    return overTheWire(result);
  }
}

/**
 * Database names, as config.json's db section names them.
 */
export interface IEmbeddedStorageOptions {
  /** Storage driver, db.selfhost.engine. Default "level". */
  engine?: string;
  /** db.database. Default "activeledger". */
  database?: string;
  /** db.event. Default "activeledgerevents". */
  event?: string;
  /** db.error. Default "activeledgererrors". */
  error?: string;
}

export interface IEmbeddedStorage {
  data: EmbeddedDSConnect;
  events: EmbeddedDSConnect;
  errors: EmbeddedDSConnect;
  close(): Promise<void>;
}

/**
 * Opens the data, events and errors databases from a data directory with
 * the storage process's layout: one LevelDB directory per database, named
 * after it, inside `dir` (db.selfhost.dir). The directory is created if
 * missing, as ActiveDataStore does, and each database is opened (created
 * if new) before this resolves, so a lock held by another process fails
 * here rather than on first use.
 *
 * `dir` is resolved against the working directory, so a relative
 * db.selfhost.dir lands where the storage process puts it.
 *
 * @param {string} dir
 * @param {IEmbeddedStorageOptions} [options={}]
 * @returns {Promise<IEmbeddedStorage>}
 */
export async function openEmbeddedStorage(
  dir: string,
  options: IEmbeddedStorageOptions = {}
): Promise<IEmbeddedStorage> {
  const location = path.resolve(dir) + path.sep;
  fs.mkdirSync(location, { recursive: true });
  const engine = options.engine || "level";
  const data = new EmbeddedDSConnect(location, options.database || "activeledger", engine);
  const events = new EmbeddedDSConnect(location, options.event || "activeledgerevents", engine);
  const errors = new EmbeddedDSConnect(location, options.error || "activeledgererrors", engine);
  // Not via info(): LevelMe.info() swallows its own open failure.
  for (const db of [data, events, errors]) {
    await db.level["open"]();
  }
  return {
    data,
    events,
    errors,
    close: async () => {
      await Promise.all([data.close(), events.close(), errors.close()]);
    },
  };
}
