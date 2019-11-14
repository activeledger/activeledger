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
import { ServerResponse } from "http";

/**
 * Connection Heartbeat management
 *
 * @export
 * @class HeartBeat
 */
export class HeartBeat {
  /**
   * Start & Maintain SSE Heartbeat
   *
   * @static
   * @param {ServerResponse} response
   * @returns {NodeJS.Timeout}
   * @memberof HeartBeat
   */
  public static Start(response: ServerResponse): NodeJS.Timeout {
    return setInterval(() => {
      if (response.writable) {
        // Empty bytes can cause issues to some client
        //response.write("\0");
        // better to use a "comment"
        if (!response.write(":\n\n")) {
        } else {
          // force flush
          process.nextTick(() => {});
        }
      }
      // Increase timeout with TCP keepalive enabled.
      // Some connections still may timeout after long periods of inactivity
    }, 10 * 60 * 1000);
  }

  /**
   * Stop SSE Heartbeat
   *
   * @static
   * @param {NodeJS.Timeout} interval
   * @memberof HeartBeat
   */
  public static Stop(interval: NodeJS.Timeout): void {
    clearInterval(interval);
  }
}
