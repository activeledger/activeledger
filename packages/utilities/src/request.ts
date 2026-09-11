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
import { ActiveGZip } from "./gzip";
import { Dispatcher, setGlobalDispatcher, getGlobalDispatcher, Agent } from "undici";

/**
 * Returned HTTP Resonse data
 *
 * @interface IHTTPResponse
 */
interface IHTTPResponse {
  //raw: string;
  data: unknown;
}

// Below this many bytes, gzip's CPU cost outweighs the bandwidth it saves.
const GZIP_MIN_BYTES = 1024;

/**
 * How long the SERVER we talk to keeps an idle connection.
 *
 * The self hosted store is @activeledger/httpd, which calls uWebSockets'
 * App() with no options - and uWS's AppOptions has no timeout field at
 * all, only TLS settings. Its HTTP idle timeout is compiled in: 10s
 * upstream, swept by a ~4s timer, so an idle socket is closed somewhere in
 * the 10-14s band. Measured at 11.8s against a live node.
 *
 * Not configurable, so it is a ceiling to design under rather than a
 * number to change.
 */
export const SERVER_IDLE_TIMEOUT_MS = 10_000;

/**
 * How long WE keep an idle connection. Must be comfortably below
 * SERVER_IDLE_TIMEOUT_MS - see the invariant asserted in the tests.
 *
 * This is undici's own default. It was raised to 30s in 16d3a9f to avoid
 * a fresh handshake between consensus rounds, without the server's idle
 * timeout in view, and that opened a ~20 second window in which this
 * client would hand a request to a socket the server had already closed.
 *
 * undici does not retry non-idempotent requests, and a stream write is a
 * POST to _bulk_docs. So the failure landed exactly there:
 *
 *   idle connection -> server closes at ~10s -> we reuse it inside our 30s
 *   window -> POST dies on a dead socket -> ActiveRequest.send() returns
 *   { data: null } -> bulkDocs resolves null -> streamUpdater raises 1510
 *   "Failed to save streams" -> that node drops out of the round.
 *
 * Which is intermittent, hits writes but not reads (GETs are idempotent
 * and undici retries them silently), leaves nothing in the server's log
 * because the close was deliberate, and gets WORSE on quiet nodes, whose
 * connections sit idle long enough to cross the server's timeout more
 * often. On a four node network, losing two nodes to this is enough to
 * put a round below consensus and commit nothing anywhere.
 *
 * The handshake this was avoiding costs a millisecond or two on a LAN. A
 * lost commit costs a transaction.
 */
const CLIENT_IDLE_TIMEOUT_MS = 4_000;

export const DISPATCHER_OPTIONS = {
  connect: {
    rejectUnauthorized: false,
  },
  keepAliveTimeout: CLIENT_IDLE_TIMEOUT_MS,
  // Pinned as well as the default above. Left at undici's 600s default, a
  // server advertising a long "Keep-Alive: timeout=N" would be honoured
  // for up to ten minutes, which is the same bug against a different peer.
  keepAliveMaxTimeout: CLIENT_IDLE_TIMEOUT_MS,
};

// One dispatcher governs every undici copy in the process: it is stored on
// globalThis under Symbol.for("undici.globalDispatcher.1"), a registered
// symbol, so the three copies in this workspace (utilities, options,
// nano-gateway - all 6.18.2, all the same symbol version) share it. This
// is the only setGlobalDispatcher call in the codebase. Anything that
// somehow bypasses it falls back to undici's own 4s default, which is
// safe by the same margin.
setGlobalDispatcher(new Agent(DISPATCHER_OPTIONS));

/**
 * Simple HTTP Request Object
 *
 * @export
 * @class ActiveRequest
 */
/**
 * Reads one header value out of undici's raw header list, which arrives as a
 * flat array of Buffers alternating name, value. Only used for
 * content-encoding, so a linear scan over a handful of entries is cheaper
 * than building an object for every response.
 */
function rawHeader(headers: Buffer[] | string[] | null, name: string): string | undefined {
  if (!headers) return undefined;
  for (let i = 0; i < headers.length - 1; i += 2) {
    if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
  }
  return undefined;
}

/**
 * Simple HTTP Request Object
 *
 * @export
 * @class ActiveRequest
 */
export class ActiveRequest {
  public static async send(
    reqUrl: string,
    type: string,
    header?: string[],
    data?: any,
    enableGZip: boolean = false,
    timeout: number = 300 // undici default
  ): Promise<IHTTPResponse> {
    //enableGZip = false
    timeout = timeout * 1000;
    const headers: Record<string, string> = {};

    // Compressable?
    if (enableGZip) {
      headers["Accept-Encoding"] = "gzip";
    }

    let bundled = false;

    // Add Headers
    if (header) {
      for (let i = header.length; i--; ) {
        // Split Headers
        const [name, value] = header[i].split(":");
        // Asign to Header
        headers[name] = value;
        if (!bundled && name == "X-Bundle") {
          bundled = true;
        }
      }
    }

    const method = type.toUpperCase();
    let body: any;

    // Manage Data
    if (data && (method == "POST" || method == "PUT")) {
      // convert data to string if object
      if (typeof data === "object") {
        data = Buffer.from(JSON.stringify(data), "utf8");
        headers["content-type"] = "application/json";
      }

      // Compressable? Below GZIP_MIN_BYTES the compression CPU cost outweighs
      // the bandwidth saved, so skip it - the receiver already falls back to
      // treating the body as plain JSON whenever content-encoding isn't "gzip".
      if (enableGZip && data.length >= GZIP_MIN_BYTES) {
        // Compress
        data = await ActiveGZip.gzip(data);
        headers["content-encoding"] = "gzip";
      }

      body = data;
    }

    // undici's request() is a wrapper over dispatch() that builds a
    // Readable per response. dispatch() skips that: measured against a bare
    // node server it carries ~35% more throughput (16704 vs 12401 req/s at
    // 64 in flight) and a far tighter tail (p99 8ms vs 51ms), because the
    // tail is dominated by the stream machinery rather than the socket.
    //
    // Retry-on-connection-error is unaffected: it lives in the Client, below
    // both, so idempotent requests are still retried silently and a POST to
    // _bulk_docs still is not - see CLIENT_IDLE_TIMEOUT_MS above for why that
    // distinction matters here.
    //
    // The handler shape below is undici 6/7's. undici 8 renames these
    // (onConnect/onHeaders/onData/onComplete -> onRequestStart/
    // onResponseStart/onResponseData/onResponseEnd) and validates the shape
    // up front, so a major bump needs this updated - it will throw
    // "invalid onRequestStart method" immediately rather than fail quietly.
    let origin: string;
    let path: string;
    try {
      const parsed = new URL(reqUrl);
      origin = parsed.origin;
      path = parsed.pathname + parsed.search;
    } catch {
      // Same contract as every other failure here: never throw at the caller.
      return { data: null };
    }

    return new Promise<IHTTPResponse>((resolve) => {
      const chunks: Buffer[] = [];
      let encoding: string | undefined;
      let settled = false;

      // Every exit resolves - callers rely on this never rejecting, even on
      // a genuine connection failure (neighbour.knock() and
      // checkNeighbourhood() read { data: null } to decide a node is down).
      const done = (value: IHTTPResponse) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      getGlobalDispatcher().dispatch(
        {
          origin,
          path,
          method: method as Dispatcher.HttpMethod,
          headers,
          body,
          headersTimeout: timeout,
          bodyTimeout: timeout,
        },
        {
          onConnect: () => {},
          onHeaders: (_statusCode: number, rawHeaders: Buffer[] | null) => {
            encoding = rawHeader(rawHeaders, "content-encoding");
            return true;
          },
          onData: (chunk: Buffer) => {
            chunks.push(chunk);
            return true;
          },
          onComplete: () => {
            const raw = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            // Back Compat gzip support
            if (encoding?.includes("gzip")) {
              ActiveGZip.ungzip(raw)
                .then((plain: Buffer) => {
                  try {
                    done({ data: JSON.parse(plain.toString()) });
                  } catch {
                    done({ data: null });
                  }
                })
                .catch(() => done({ data: null }));
              return;
            }
            try {
              done({ data: JSON.parse(raw.toString()) });
            } catch {
              done({ data: null });
            }
          },
          onError: () => {
            if (!bundled) {
              done({ data: null });
            } else {
              // Circular Dependency issue
              done({ data: null });
            }
          },
        }
      );
    });
  }
}
