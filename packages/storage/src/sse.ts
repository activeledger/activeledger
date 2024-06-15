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
import { IncomingMessage, ServerResponse } from "http";
import { HeartBeat } from "./heartbeat";
import { Socket } from "net";

/**
 * Manages SSE Connection
 *
 * @export
 * @class SSE
 */
export class SSE {
  constructor(private res: Socket) {
    // Make sure we have an array
    //res.statusCode = 200;

    // Set Header
    res.write(`HTTP/1.1 200 OK\r\n`)
    res.write(`Content-type: text/event-stream\r\n`)
    res.write(`Cache-Control: no-cache\r\n`)
    res.write(`X-Accel-Buffering: no\r\n\r\n`)


    /*
      Ngnix recommend values:
      proxy_set_header Connection '';
      proxy_http_version 1.1;
      proxy_connect_timeout 24h;
      proxy_read_timeout 24h;
    */
    // Prevents proxy buffering
    // res.setHeader("X-Accel-Buffering", "no");
    // if (req.httpVersion !== "2.0") {
    //   res.setHeader("Connection", "keep-alive");
    // }

    // Native TCP Keepalive optimal
    // res.shouldKeepAlive = true;
    res.setTimeout(0);
    res.setNoDelay(true);
    res.setKeepAlive(true);


    // Setup Heartbeat
    const heartBeat = HeartBeat.Start(res);

    // On disconnect remove listener
    res.on("close", () => {
      // Clear Heartbeat
      HeartBeat.Stop(heartBeat);
    });
  }

  /**
   * Write to the SSE stream
   *
   * @param {(number | string)} sequence
   * @param {unknown} prepare
   * @returns {boolean}
   */
  public write(sequence: number | string, prepare: unknown): boolean {
    // Connection still open?
    if (this.res.writable) {
      // Write new event
      if (
        !this.res.write(
          `id:${sequence}\nevent: message\ndata:${JSON.stringify(prepare)}\n\n`
        )
      ) {
        return true;
      } else {
        process.nextTick(() => {});
        return true;
      }
    } else {
      // End Server Side
      this.res.end();
      return false;
    }
  }
}
