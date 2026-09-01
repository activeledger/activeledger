/*
 * MIT License (MIT)
 * Copyright (c) 2026 Activeledger
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

/**
 * uWebSockets.js-correct SSE helper.
 *
 * packages/core (Activecore)'s own SSE class (controllers/sse.ts) is
 * written against Node's raw http.IncomingMessage/ServerResponse -
 * res.setHeader(), res.write(), res.flushHeaders(), req.socket.setTimeout().
 * The @activeledger/httpd this repo actually ships today (confirmed by
 * reading its published lib/httpd.js, not assumed) is built on
 * uWebSockets.js - route handlers receive (incoming, req, res) where res
 * is a raw uWS HttpResponse, which has none of those methods
 * (writeStatus/writeHeader/write/cork/onAborted instead, no .socket, no
 * .flushHeaders). Activecore's SSE class would throw immediately if
 * actually invoked against this. This is a real, working reimplementation,
 * not a port of the broken one - see docs/nano-gateway.md for why this
 * package exists at all.
 *
 * Two uWS-specific correctness requirements this gets right:
 * 1. Every write here happens either from an async auth check or a
 *    setInterval heartbeat - both are outside uWS's default "top of
 *    handler" cork context, so every write is wrapped in res.cork().
 * 2. ActiveHttpd's own listen() wrapper already calls res.onAborted() once
 *    (setting a bolted-on res.writable = false, not part of uWS's real
 *    HttpResponse type) before invoking any route handler. uWS keeps only
 *    the latest onAborted handler, so registering a second one here would
 *    silently replace it - this class's onAborted handler re-sets
 *    res.writable = false itself to preserve that invariant, on top of
 *    its own cleanup.
 */

// Matches ActiveHttpd's own bolted-on res.writable convention (not part of
// uWS's real HttpResponse type - see class doc comment above).
export interface IWritableHttpResponse {
  writable: boolean;
  cork(cb: () => void): IWritableHttpResponse;
  writeStatus(status: string): IWritableHttpResponse;
  writeHeader(key: string, value: string): IWritableHttpResponse;
  write(chunk: string): boolean;
  end(body?: string): IWritableHttpResponse;
  onAborted(handler: () => void): IWritableHttpResponse;
}

export class NanoSSE {
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private res: IWritableHttpResponse, heartbeatSeconds: number, onClose?: () => void) {
    res.cork(() => {
      res
        .writeStatus("200 OK")
        .writeHeader("Content-Type", "text/event-stream")
        .writeHeader("Cache-Control", "no-cache")
        .writeHeader("Access-Control-Allow-Origin", "*");
    });

    res.onAborted(() => {
      // Re-set what ActiveHttpd's own onAborted handler would have set -
      // we've just replaced that handler by registering this one (uWS
      // keeps only the latest), so this preserves the invariant other
      // code (findHandler's writeResponse fallbacks) relies on.
      res.writable = false;
      this.close();
      onClose?.();
    });

    // uWS's default idle timeout is 10s of no traffic on the socket - far
    // shorter than Activecore's now-provably-too-slow 10-minute heartbeat
    // (packages/core/src/heartbeat.ts). A short, aggressive default here
    // is deliberate, not arbitrary.
    this.heartbeat = setInterval(() => {
      if (this.closed || !res.writable) return;
      res.cork(() => {
        res.write(":\n\n");
      });
    }, heartbeatSeconds * 1000);
  }

  public write(event: unknown): boolean {
    if (this.closed || !this.res.writable) return false;
    this.res.cork(() => {
      this.res.write(`data:${JSON.stringify(event)}\n\n`);
    });
    return true;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}
