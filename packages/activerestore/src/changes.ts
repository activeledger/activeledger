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

export class FollowChanges extends events.EventEmitter {
  /**
   * Pouch Database Connection
   *
   * @private
   * @type {*}
   * @memberof FollowChanges
   */
  private db: any;

  /**
   * Follow Changes Object
   *
   * @private
   * @type {*}
   * @memberof FollowChanges
   */
  private dbChanges: any;

  /**
   * Store last sequence value
   *
   * @private
   * @type {(number | undefined)}
   * @memberof FollowChanges
   */
  private lastSequence: number | undefined;

  /**
   * Is the connection restarting
   *
   * @private
   * @type {boolean}
   * @memberof FollowChanges
   */
  private restarting: boolean = false;

  /**
   * Creates an instance of FollowChanges.
   *
   * @param {*} db
   * @memberof FollowChanges
   */
  constructor(db: any) {
    super();
    this.db = db;
  }

  /**
   * Start Following Changes
   *
   * @memberof FollowChanges
   */
  public start(): void {
    // Starting new or Resuming?
    let since: string | number = "now";
    if (this.lastSequence) {
      since = this.lastSequence;
    }

    // Create Follow Object
    this.dbChanges = this.db.changes({
      since: since,
      live: true,
      include_docs: true
    });

    // Listen to changes
    this.dbChanges.on("change", (change: any) => {
      // Cache sequence
      this.lastSequence = change.seq;

      // Re-emit the changes
      this.emit("change", change);
    });

    // bind On Error Event
    this.dbChanges.on("error", (e: Error) => {
      ActiveLogger.error(e, "Feed Error");
      if (!this.restarting) {
        // Stop the listner
        this.stop();
        // Restart after small timeout
        this.restarting = true;
        setTimeout(() => {
          ActiveLogger.info("Restarting Restore Feed");
          this.start();
          // Reset the restart flag
          this.restarting = false;
        }, 3000);
      }
    });
  }

  /**
   * Pause Changes
   *
   * @memberof FollowChanges
   */
  public pause(): void {
    this.dbChanges.cancel();
    this.dbChanges = undefined;
  }

  /**
   * Proxy to start
   *
   * @memberof FollowChanges
   */
  public resume(): void {
    this.start();
  }

  /**
   * Stop Following Changes
   *
   * @memberof FollowChanges
   */
  public stop(): void {
    this.lastSequence = undefined;
    this.dbChanges.cancel();
    this.dbChanges = undefined;
  }
}
