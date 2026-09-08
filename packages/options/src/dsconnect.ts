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
import * as querystring from "querystring";
import { createHash } from "crypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ActiveRequest } from "@activeledger/activeutilities";
import { EventEmitter } from "events";
import { ActiveOptions } from "./options";

const REMOVE_CACHE_TIMER = 5 * 60 * 1000;

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
   */
  constructor(private location: string) {
    // Search to make sure the database exists
    // DISABLED
    //this.timerUnCache();
  }

  /**
   * Clears Cache
   *
   * @private
   */
  private timerUnCache() {
    setTimeout(() => {
      const memory = Object.keys(this.secondaryCache);
      const nowMinus5 = new Date(Date.now() - REMOVE_CACHE_TIMER * 2);
      for (let i = memory.length; i--; ) {
        if (this.secondaryCache[memory[i]].data < nowMinus5) {
          // 5 minutes has passed without accessing it so lets clear
          delete this.secondaryCache[memory[i]];
        }
      }
      this.timerUnCache();
    }, REMOVE_CACHE_TIMER);
  }

  /**
   * We need a way to clear this cache for Position Incorrect! (Or all errors?)
   *
   * @param {string} key
   */
  public clearCache(key: string) {
    delete this.secondaryCache[key];
  }

  /**
   * Creates Database / Get Database Info
   *
   * @returns
   */
  public info(): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}`, "GET")
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }

  /**
   * Drops database table
   *
   * @returns {Promise<any>}
   */
  public drop(): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}`, "DELETE")
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }

  /**
   * Create an index
   *
   * @param {*} [options={}]
   * @returns
   */
  public createIndex(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_index`, "POST", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }
  // TODO _rev doesn't go up correct
  // for now disabling this cache

  private secondaryCache: {
    [index: string]: {
      data: any;
      create: Date;
    };
  } = {};

  /**
   * Returns all the documents in the database
   *
   * @param {*} [options]
   * @returns
   */

  public async allDocs(options?: any): Promise<any> {
    //return new Promise(async (resolve, reject) => {

    const x = await ActiveRequest.send(
      `${this.location}/_all_docs`,
      options ? "POST" : "GET",
      undefined,
      options
    );
    return x.data;

    // if (options.keys) {
    //   let tmpKeys = options.keys;
    //   let cached = [];
    //   //const now = new Date();

    //   // for (let i = options.keys.length; i--;) {
    //   //   if (!this.secondaryCache[options.keys[i]]) {
    //   //     tmpKeys.push(options.keys[i]);
    //   //   } else {
    //   //     cached.push({ doc: this.secondaryCache[options.keys[i]].data });
    //   //     this.secondaryCache[options.keys[i]].create = now;
    //   //   }
    //   // }

    //   // Get uncached
    //   if (tmpKeys) {
    //     const result = await ActiveRequest.send(
    //       `${this.location}/_all_docs`,
    //       options ? "POST" : "GET",
    //       undefined,
    //       { ...options, keys: tmpKeys }
    //     );

    //     // Loop and cache
    //     for (let i = (result.data as any).rows.length; i--;) {
    //       const data = (result.data as any).rows[i].doc;

    //       // DISABLED
    //       // this.secondaryCache[data._id] = {
    //       //   data: data,
    //       //   create: new Date()
    //       // }
    //       cached.push({ doc: data });
    //     }
    //   }

    //   // TODO: Track offset?
    //   return { total_rows: cached.length, offset: 0, rows: cached };
    // } else {
    //   const x = await ActiveRequest.send(
    //     `${this.location}/_all_docs`,
    //     options ? "POST" : "GET",
    //     undefined,
    //     options
    //   );
    //   return x.data;
    // }

    //  .then((response: any) => resolve(response.data))
    //  .catch(reject);
    //});
  }

  /**
   * Get a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   */
  public get(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });

    // if (!this.secondaryCache[id]) {
    //   const response = await ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, options);
    //   return response.data
    //   // DISABLED
    //   // this.secondaryCache[id] = {
    //   //   data: response.data,
    //   //   create: new Date()
    //   // } // TODO Error Handling now?
    // }
    // return this.secondaryCache[id].data;
  }

  /**
   * Create New or Gets a specific document
   *
   * @param {string} id
   * @param {*} [options={}]
   * @returns
   */
  public createget(id: string, options: any = {}): Promise<any> {
    return new Promise((resolve) => {
      ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(() => {
          resolve({ _id: id });
        });
    });
  }

  /**
   * Checks to see if a document exists, If doesn't exist a 404 log will be created
   *
   * @param {string} id
   * @returns {(Promise<{} | Boolean>)}
   */
  public exists(id: string): Promise<Boolean> {
    return new Promise<Boolean>((resolve) => {
      ActiveRequest.send(`${this.location}/${id}`, "GET", undefined, {})
        .then((response: any) => resolve(response.data?._id ? true : false))
        .catch(() => {
          resolve(false);
        });
    });
  }

  /**
   * Query the data store
   *
   * @param {*} [options={}]
   * @returns
   */
  public find(options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_find`, "POST", undefined, options)
        .then((response: any) => resolve(response.data))
        .catch(reject);
    });
  }

  /**
   * Create / Append multiple documents at the same time
   *
   * @param {any[]} docs
   * @param {*} [options={}]
   * @returns
   */
  public bulkDocs(docs: any[], options: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/_bulk_docs`, "POST", undefined, {
        docs,
        options,
      })
        .then((response: any) => {
          resolve(response.data);
          // Update cache
          // const create = new Date();
          // for (let i = docs.length; i--;) {
          //   // Update MD5 (We are doing this twice in 2 different processors)
          //   const md5 = createHash("md5").update(docs[i]).digest("hex");
          //   if (docs[i]._rev) {
          //     const pos = parseInt(docs[i]._rev.split("-")[0]) + 1;
          //     docs[i]._rev = `${pos}-${md5}`;
          //   } else {
          //     // Or just don't cache "new"?
          //     docs[i]._rev = `1-${md5}`;
          //   }

          //   // DISABLED
          //   this.secondaryCache[docs[i]._id] = {
          //     data: docs[i],
          //     create
          //   }
          // }
        })
        .catch(reject);
    });
  }

  /**
   * Create a document with auto generated id
   *
   * @param {} doc
   * @returns
   */
  public post(doc: {}): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(this.location, "POST", undefined, doc)
        .then((response: any) => {
          resolve(response.data);

          // We need to update _rev here, Should we just fetch in background?
          // Or do we manage md5 ourself

          // Update MD5 (We are doing this twice in 2 different processors)
          // const md5 = createHash("md5").update((doc as any)).digest("hex");
          // if ((doc as any)._rev) {
          //   const pos = parseInt((doc as any)._rev.split("-")[0]) + 1;
          //   (doc as any)._rev = `${pos}-${md5}`;
          // }
          // else {
          //   // Or just don't cache "new"?
          //   (doc as any)._rev = `1-${md5}`;
          // }

          // // DISABLED
          // this.secondaryCache[(doc as any)._id] = {
          //   data: doc,
          //   create: new Date()
          // }
        })
        .catch(reject);
    });
  }

  /**
   * Create / Append a document
   *
   * @param {{ _id: string }} doc
   * @returns
   */
  public put(doc: { _id: string; _rev?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      ActiveRequest.send(`${this.location}/${doc._id}`, "PUT", undefined, doc)
        .then((response: any) => {
          resolve(response.data);

          // We need to update _rev here, Should we just fetch in background?
          // Or do we manage md5 ourself

          // if ((doc as any)._rev) {
          //   // Update MD5 (We are doing this twice in 2 different processors)
          //   const md5 = createHash("md5").update((doc as any)).digest("hex");
          //   const pos = parseInt((doc as any)._rev.split("-")[0]) + 1;
          //   (doc as any)._rev = `${pos}-${md5}`;
          // }

          // // DISABLED
          // this.secondaryCache[(doc as any)._id] = {
          //   data: doc,
          //   create: new Date()
          // }
        })
        .catch(reject);
    });
  }

  /**
   * Purges document from the database
   *
   * @param {{}} doc
   * @returns {Promise<any>}
   */
  public purge(doc: { _id: string; _rev?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      if (ActiveOptions.get<any>("db", {}).selfhost) {
        ActiveRequest.send(`${this.location}/${doc._id}`, "DELETE")
          .then((response: any) => resolve(response.data))
          .catch(reject);
      } else {
        // Couchdb 2.3 supports purge again
        ActiveRequest.send(`${this.location}/_purge`, "POST", undefined, {
          [doc._id]: [doc._rev],
        })
          .then((response: any) => resolve(response.data))
          .catch(reject);
      }
    });
  }

  /**
   * Delete a sequence file
   *
   * @param {string} sequence
   * @returns {Promise<any>}
   */
  public async seqDelete(sequence: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(
        `${this.location}/_seq/${sequence}`,
        "DELETE"
      );
    } else {
      // Not supported, Fail quietly.
    }
  }

  /**
   * Get a sequence file
   *
   * @param {string} sequence
   * @returns {Promise<any>}
   */
  public async seqGet(sequence: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(
        `${this.location}/_seq/${sequence}`,
        "GET"
      );
    } else {
      // Not supported, Fail quietly.
    }
  }

  /**
   * Backups the database
   *
   * @returns {Promise<any>}
   */
  public async backup(filename?: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(`${this.location}/_backup`, "POST", [], {
        filename,
      });
    } else {
      // Not supported, Fail quietly.
    }
  }

  /**
   * Restore the database
   *
   * @returns {Promise<any>}
   */
  public async restore(filename: string): Promise<any> {
    if (ActiveOptions.get<any>("db", {}).selfhost) {
      return await ActiveRequest.send(`${this.location}/_restore`, "POST", [], {
        filename,
      });
    } else {
      // Not supported, Fail quietly.
    }
  }

  /**
   * Fetch latest changes
   *
   * @param {{}} opts
   * @returns {Promise<ActiveDSChanges | any>}
   */
  public changes(opts: {
    live?: boolean;
    [opt: string]: any;
  }): Promise<any> | ActiveDSChanges {
    if (opts.live) {
      return new ActiveDSChanges(opts, `${this.location}/_changes`);
    } else {
      return new Promise((resolve, reject) => {
        ActiveRequest.send(
          `${this.location}/_changes?${querystring.stringify(opts)}`,
          "GET"
        )
          .then((response: any) => resolve(response.data))
          .catch(reject);
      });
    }
  }
}

/**
 * Simple DS Changes Listener
 *
 * @export
 * @class ActiveDSChanges
 * @extends {EventEmitter}
 * @implements {ActiveDefinitions.IActiveDSChanges}
 */
export class ActiveDSChanges
  extends EventEmitter
  implements ActiveDefinitions.IActiveDSChanges
{
  /**
   * Flag for cancelling the next listeing round
   *
   * @private
   */
  private stop = false;

  /**
   * Pending retry from a failed round, so cancel()/restart() can clear it
   * and two listen() loops can never run at once.
   *
   * @private
   */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bumped by cancel() and restart(). A round captures it when it starts and
   * abandons itself if it no longer matches.
   *
   * cancel() cannot abort the in-flight request - ActiveRequest.send exposes
   * no abort handle - so a cancelled round still resolves later. It then
   * re-checked only `this.stop`, which restart() has since set back to false,
   * and called listen() again. Result: two loops against one feed, forever,
   * both advancing `since`, every change emitted twice. ActiveChanges.pause()
   * followed by start() (packages/options/src/changes.ts) is exactly that
   * sequence. retryTimer does not protect against it: that tracks pending
   * TIMERS, and this is a pending REQUEST.
   */
  private generation = 0;

  /**
   * Delay before re-arming after a failed round. Long enough that a
   * datastore which is down doesn't get hammered, short enough that a
   * transient blip costs a consumer a second rather than every subsequent
   * change.
   *
   * @private
   */
  private static readonly RETRY_DELAY_MS = 1000;

  /**
   *Creates an instance of ActiveDSChanges.
   * @param {{ live?: boolean; [opt: string]: any }} opts
   * @param {string} location
   * @param {boolean} [bulk=false]
   */
  constructor(
    private opts: { live?: boolean; [opt: string]: any },
    private location: string,
    private bulk: boolean = false
  ) {
    super();

    // Set default feed type (currently longpoll supported only on httpd)
    if (!opts.feed) {
      opts.feed = "longpoll";
    }

    // Give time before listening.
    //
    // Tracked in retryTimer rather than left as a bare setTimeout, so cancel()
    // can clear it. Untracked, a cancel() during this opening 250ms window did
    // not stop the feed starting: the timer fired regardless and armed a loop
    // nobody had asked for. Paired with restart() - which starts its own - that
    // left TWO loops running against one feed permanently, both advancing
    // `since` and emitting every change twice. Caught by the regression test
    // for the cancel()/restart() race, which kept failing after the in-flight
    // round was correctly disowned; this timer was the other source.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stop) {
        this.listen();
      }
    }, 250);
  }

  /**
   * Listen for changes from the data store
   *
   * @private
   */
  private listen(): void {
    const generation = this.generation;
    ActiveRequest.send(
      `${this.location}?${querystring.stringify(this.opts)}`,
      "GET"
    )
      .then((response: any) => {
        if (!this.stop && generation === this.generation) {
          // Map last_seq -> seq (Matches Pouch Connector)
          // and update since for next round of listening
          //
          // `response` here is the raw ActiveRequest/axios wrapper - it
          // has no top-level `.id` at all (that was always undefined).
          // The server writes `last_seq` inside the JSON body itself
          // (selfhost.ts's longpoll handler: `res.write('],\n"last_seq":'
          // + change.seq + "}\n")`), i.e. under `.data`, not `.id`. Every
          // round after the first therefore requested `since=undefined`
          // -> parseInt(undefined) = NaN server-side - live-confirmed as
          // part of the same investigation that found the longpoll
          // handler's response was never being finalised at all (see
          // that fix in packages/storage/src/selfhost.ts) - fixing just
          // that bug wasn't enough on its own, this one still silently
          // broke every round after the first.
          this.opts.since = response.data?.last_seq ?? this.opts.since;

          // `data` can legitimately be null/empty - a longpoll round that
          // times out with nothing to report is an ordinary outcome, not an
          // error. The `?.` on last_seq above already allowed for that, but
          // the reads below did not: `response.data.results` threw
          // "Cannot read properties of null (reading 'results')" from inside
          // this .then(), which landed in the .catch() below, which never
          // called listen() again - so one empty body permanently killed the
          // changes feed. Live-confirmed downstream: a nano-gateway subscriber
          // took that error at 21:11 and never received another change, while
          // its SSE socket stayed open and heartbeating, so nothing anywhere
          // reported a fault.
          const data = response.data;

          if (!data) {
            // Report it, do not just retry it.
            //
            // ActiveRequest.send() NEVER rejects - packages/utilities/src/request.ts
            // returns { data: null } for connection-refused, DNS failure,
            // bodyTimeout, socket reset, non-2xx and unparseable body alike.
            // So the .catch() below is unreachable for every fault its own
            // comment used to name, and emit("error") never fired for any of
            // them. With the datastore completely down this polled in silence
            // forever: ChangesWatcher's onError never ran, nano-gateway never
            // wrote an {event:"error"} frame, and ActiveChanges' whole restart
            // machinery - which is driven exclusively by that event - was dead
            // code. There was no path anywhere by which a consumer could learn
            // the datastore was unreachable.
            //
            // Guarded on listenerCount because Node throws on an "error" event
            // with no listener. This path is now genuinely reachable, so an
            // unguarded emit would turn a datastore blip into a crash in every
            // consumer that never needed an error handler before.
            if (this.listenerCount("error") > 0) {
              this.emit(
                "error",
                new Error(`changes feed round returned no body: ${this.location}`)
              );
            }
            // Nothing to process, and re-arming immediately would spin: a
            // body-less response returns straight away rather than blocking
            // like a healthy longpoll, so an immediate this.listen() here
            // busy-loops the event loop and starves every timer in the
            // process. Back off instead - this is the same "no useful round"
            // case as an outright failure. (An ordinary longpoll timeout is
            // NOT this case: it returns {results: [], last_seq}, so it still
            // continues immediately below.)
            this.scheduleRetry();
            return;
          }

          // A body with no `results` array is a FAILED round, not an empty one.
          //
          // The immediate this.listen() at the bottom is safe only because a
          // healthy longpoll blocks. A truthy body that returns instantly
          // busy-loops it. httpd's error path is exactly that: it responds
          // with JSON.stringify(new Error(...)), which is the literal string
          // "{}" - truthy, parses fine, no results array - so a 500 from a
          // deleted database or a rejected changesFromSeq pegs both ends at
          // full request rate, with no error visible to the consumer.
          //
          // Guarding results against a throw (the previous fix) was necessary
          // but not sufficient: it stopped the crash and left the spin.
          if (!this.bulk && !Array.isArray(data.results)) {
            if (this.listenerCount("error") > 0) {
              this.emit(
                "error",
                new Error(`changes feed round had no results array: ${JSON.stringify(data).slice(0, 200)}`)
              );
            }
            this.scheduleRetry();
            return;
          }

          if (this.bulk) {
            this.emit("change", data);
          } else {
            const results = Array.isArray(data.results) ? data.results : [];
            results.forEach((elm: any) => {
              this.emit("change", {
                doc: elm.doc,
                seq: elm.seq,
              });
            });
          }

          // Listen for next update
          this.listen();
        }
      })
      .catch((error) => {
        this.emit("error", error);

        // Kept as a backstop, but note what does NOT reach here:
        // ActiveRequest.send() never rejects, so transport faults - dropped
        // connection, restarting datastore, timeout, 500 - all arrive above as
        // { data: null } and are handled there. What is left for this catch is
        // a genuine bug in the handling code itself. An earlier version of
        // this comment claimed the transport faults landed here; they never
        // did, and acting on that would send someone looking in the wrong
        // place.
        this.scheduleRetry();
      });
  }

  /**
   * Re-arms listen() after a failed round, without stacking timers or
   * racing a concurrent restart()/cancel().
   */
  private scheduleRetry(): void {
    if (this.stop || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stop) {
        this.listen();
      }
    }, ActiveDSChanges.RETRY_DELAY_MS);
  }

  /**
   * Cancels the changes listner
   *
   */
  public cancel(): void {
    this.stop = true;
    // Invalidates any round already in flight - it cannot be aborted, only
    // disowned when it eventually resolves.
    this.generation++;
    this.clearRetry();
  }

  public restart(): void {
    this.stop = false;
    this.generation++;
    // Without this a restart() landing while a retry is pending would leave
    // two listen() loops running against the same feed, duplicating every
    // change event from then on.
    this.clearRetry();
    this.listen();
  }

  /**
   * @private
   */
  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
