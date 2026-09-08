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
import { Dispatcher, request, setGlobalDispatcher, Agent } from "undici";

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
    const options: Omit<Dispatcher.RequestOptions, "path"> = {
      method: type.toUpperCase() as any, // Fix
      headers: {},
      headersTimeout: timeout,
      bodyTimeout: timeout,
    };

    // Compressable?
    if (enableGZip) {
      (options.headers as any)["Accept-Encoding"] = "gzip";
    }

    let bundled = false;

    // Add Headers
    if (header) {
      for (let i = header.length; i--; ) {
        // Split Headers
        const [name, value] = header[i].split(":");
        // Asign to Header
        (options.headers as any)[name] = value;
        if (!bundled && name == "X-Bundle") {
          bundled = true;
        }
      }
    }

    // Manage Data
    if (data && (options.method == "POST" || options.method == "PUT")) {
      // convert data to string if object
      if (typeof data === "object") {
        data = Buffer.from(JSON.stringify(data), "utf8");
        (options.headers as any)["content-type"] = "application/json";
      }

      // Compressable? Below GZIP_MIN_BYTES the compression CPU cost outweighs
      // the bandwidth saved, so skip it - the receiver already falls back to
      // treating the body as plain JSON whenever content-encoding isn't "gzip".
      if (enableGZip && data.length >= GZIP_MIN_BYTES) {
        // Compress
        data = await ActiveGZip.gzip(data);
        (options.headers as any)["content-encoding"] = "gzip";
      }

      // Additional Post headers
      //(options.headers as any)["Content-Length"] = data.length;
      //(options.headers as any)["Content-Length-x2"] = data.length;

      options.body = data;
    }

    try {
      const { headers, body, statusCode } = await request(reqUrl, options);

      // Cannot do this just yet, deposit wants to treat 404 as 200 (and maybe other areas)
      // if (statusCode < 200 || statusCode > 299) {
      //   const errorBody = await body.text();
      //   throw {
      //     name: "ActiveError",
      //     message: `URL Request Failed : ${reqUrl} - ${statusCode}`,
      //     body: errorBody,
      //     stack: new Error().stack,
      //   };
      // }

      try {
        // Back Compat gzip support
        if (headers["content-encoding"]?.includes("gzip")) {
          const data = await ActiveGZip.ungzip(
            Buffer.from(await body.arrayBuffer())
          );
          return { data: JSON.parse(data.toString()) };
        } else {
          return { data: await body.json() };
        }
      } catch (e) {
        return { data: null };
      }
    } catch (e) {
      if (!bundled) {
        return { data: null };
      } else {
        // Circular Dependency issue
        return { data: null };
      }
    }
  }
}
