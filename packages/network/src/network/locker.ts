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

import { setTimeout } from "timers";

const CHECKER_TIMER = 5 * 1000 * 60;
const AUTO_RELEASE_TIME = 10 * 1000 * 60;

/**
 * Class manages stream locks for multiple processor safety
 *
 * @export
 * @class Locker
 */
export class Locker {
  /**
   * Holds information about stream locks
   * In the future we can add a lock time and have a timeout to release locks
   * this shouldn't happen as V1 solves this problem however maybe useful. Alternative on process exit
   * we can trigger release.
   *
   * Currently we do not have to concern ourselves on input and output lock differential
   *
   * @private
   * @static
   * @type {{[stream: string]: number | boolean}}
   * @memberof Locker
   */
  private static cell: { [stream: string]: number | boolean } = {};

  /**
   * Holds the current timer job
   *
   * @private
   * @static
   * @type {NodeJS.Timeout}
   * @memberof Locker
   */
  private static timer: NodeJS.Timeout | null;

  /**
   * Attempts to lock a stream returns is succussful
   *
   * @static
   * @param {string} stream
   * @returns {boolean}
   * @memberof Locker
   */
  public static hold(stream: string): boolean;
  public static hold(stream: string[]): boolean;
  public static hold(stream: any): boolean {
    if (Array.isArray(stream)) {
      // Are all the streams available
      let i = stream.length;
      let success = true;
      while (i--) {
        if (!Locker.hold(stream[i])) {
          // Update flag and quit early
          success = false;
          break;
        }
      }

      // Let process know
      return success;
    } else {
      // Is the single stream available?
      if (!this.cell[stream]) {
        this.cell[stream] = Date.now();
        return true;
      }
      return false;
    }
  }

  /**
   * Release stream lock
   *
   * @static
   * @param {string} stream
   * @memberof Locker
   */
  public static release(stream: string): boolean;
  public static release(stream: string[]): boolean;
  public static release(stream: any): boolean {
    if (Array.isArray(stream)) {
      let i = stream.length;
      while (i--) {
        Locker.release(stream[i]);
      }
      return true;
    } else {
      this.cell[stream] = false;
      return true;
    }
  }

  /**
   * Checks to make sure locks have been released. If 10 minutes has passed good chance
   * something has crashed before they could get released properly
   *
   * @static
   * @memberof Locker
   */
  public static checker() {
    if (!Locker.timer) {
      Locker.timer = setTimeout(() => {
        // Loop cell and release if 10 minutes has passed
        const locks = Object.keys(this.cell);
        for (let i = locks.length; i--; ) {
          if (
            this.cell[locks[i]] &&
            Date.now() - (this.cell[locks[i]] as number) >= AUTO_RELEASE_TIME
          ) {
            Locker.release(locks[i]);
          }
        }

        // Unset so can setup next call
        this.timer = null;
        this.checker();
      }, CHECKER_TIMER);
    }
  }
}

// Startup Checker
Locker.checker();
