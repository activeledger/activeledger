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

import * as events from "events";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveDSConnect, ActiveDSChanges } from "./dsconnect";

/**
 * Watches for changes to the datastore and emits
 *
 * @export
 * @class ActiveChanges
 * @extends {events.EventEmitter}
 */
export class ActiveChanges extends events.EventEmitter {
  /**
   * Follow Changes Object
   *
   * @private
   * @type {*}
   * @memberof ActiveChanges
   */
  private dbChanges: ActiveDSChanges;

  /**
   * Store last sequence value
   *
   * @private
   * @type {(number | undefined)}
   * @memberof ActiveChanges
   */
  private lastSequence: number | undefined;

  /**
   * Is the connection restarting
   *
   * @private
   * @type {boolean}
   * @memberof ActiveChanges
   */
  private restarting: boolean = false;

  /**
   * Creates an instance of ActiveChanges.
   * @param {string} name
   * @param {ActiveDSConnect} db
   * @param {number} [limit]
   * @memberof ActiveChanges
   */
  constructor(
    private name: string,
    private db: ActiveDSConnect,
    private limit?: number
  ) {
    super();
  }

  /**
   * Start Following Changes
   *
   * @param {(string | number)} [since="now"]
   * @memberof ActiveChanges
   */
  public start(since: string | number = "now"): void {
    // Have we already got the object
    if (!this.dbChanges) {
      ActiveLogger.info("Starting Change Feed - " + this.name);
      // Resuming from an in memory stored sequence?
      if (this.lastSequence) {
        since = this.lastSequence;
      }

      // Create Follow Object
      this.dbChanges = this.db.changes({
        since: since,
        live: true,
        include_docs: true,
        timeout: false,
        limit: this.limit || 25
      }) as ActiveDSChanges;

      // Listen to changes
      this.dbChanges.on("change", (change: any) => {
        // Cache sequence
        this.lastSequence = change.seq;

        // Re-emit the changes
        this.emit("change", change);
      });

      // bind On Error Event
      this.dbChanges.on("error", (e: Error) => {
        if (!this.restarting) {
          // Restart after small timeout
          this.restarting = true;
          // Pause feed (Clear Events)
          this.pause();
          // Setup Feed again
          this.resume(true);
        }
      });
    }
  }

  /**
   * Pause Changes
   *
   * @memberof ActiveChanges
   */
  public pause(): void {
    // Make sure changes exists
    if (this.dbChanges) {
      this.dbChanges.cancel();
      this.dbChanges = (null as unknown) as ActiveDSChanges;
    }
  }

  /**
   * Proxy to start
   *
   * @memberof ActiveChanges
   */
  public resume(force: boolean = false): void {
    if (force || !this.restarting) {
      // Add a timeout to allow for startup
      setTimeout(() => {
        ActiveLogger.info("Attempting Restarting Change Feed - " + this.name);
        // We need to change the last sequence has changed from a restore
        this.db
          .info()
          .then((info: any) => {
            // Is our last sequence ahead?
            if (this.lastSequence && this.lastSequence > info.update_seq) {
              // Yes, Reset it back
              this.lastSequence = info.update_seq;
            }
            // Reset restarting flag
            this.restarting = false;

            // Start Listening
            this.start();
          })
          .catch(() => {
            // Connection Error, Attempt Reconnect
            setTimeout(() => {
              this.resume(true);
            }, 1500);
          });
      }, 1500);
    }
  }

  /**
   * Stop Following Changes
   *
   * @memberof ActiveChanges
   */
  public stop(): void {
    this.lastSequence = undefined;
    this.dbChanges.cancel();
    this.dbChanges = (null as unknown) as ActiveDSChanges;
  }
}
