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

import { ActiveDSConnect } from "@activeledger/activeoptions";
import { IActiveHttpIncoming } from "@activeledger/httpd";
import { Allowlist } from "../allowlist";
import { verifyHandshake } from "../auth";
import { ChangesWatcher } from "../changesWatcher";
import { IWritableHttpResponse, NanoSSE } from "../sse";

/**
 * Auth travels in the POST body, not headers - @activeledger/httpd's
 * listen() only forwards a fixed, hardcoded set of headers to route
 * handlers (Accept-Encoding, X-Activeledger, x-activeledger-encrypt,
 * content-encoding, X-Bundle, Content-Length, Last-Event-ID - confirmed
 * by reading its published lib/httpd.js), so custom x-nano-* headers
 * would never arrive. The body is already freely JSON and already how
 * nano sends its stream-id list, so this just extends that shape rather
 * than fighting the framework. Last-Event-ID *is* one of the forwarded
 * headers though (Activecore's own SSE feature already relied on it),
 * so resume uses the real header, not another body field.
 */
export interface ISubscribeRequestBody {
  identity: string;
  timestamp: number;
  signature: string;
  streamIds: string[];
}

export interface ISubscribeOptions {
  db: ActiveDSConnect;
  allowlist: Allowlist;
  authWindowSeconds: number;
  heartbeatSeconds: number;
}

/** Loose shape of what @activeledger/httpd's listen() actually builds for the "req" handler param - see the header-forwarding note above. */
export interface IHttpdRequest {
  headers?: Record<string, string | undefined>;
}

export async function subscribe(
  incoming: IActiveHttpIncoming,
  req: IHttpdRequest,
  res: IWritableHttpResponse,
  options: ISubscribeOptions
): Promise<"handled"> {
  const body = (incoming.body ?? {}) as Partial<ISubscribeRequestBody>;

  const auth = await verifyHandshake(
    {
      identity: body.identity,
      timestamp: body.timestamp !== undefined ? String(body.timestamp) : undefined,
      signature: body.signature,
    },
    options.allowlist,
    options.db,
    options.authWindowSeconds
  );

  if (!auth.ok) {
    res.cork(() => {
      res.writeStatus("403 Forbidden").writeHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: auth.reason }));
    });
    return "handled";
  }

  const streamIds = Array.isArray(body.streamIds) ? body.streamIds : [];
  if (streamIds.length === 0) {
    res.cork(() => {
      res.writeStatus("400 Bad Request").writeHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "streamIds must be a non-empty array" }));
    });
    return "handled";
  }

  // Reconnecting after a drop resumes from exactly where the client left
  // off instead of missing whatever changed in the gap - a fresh
  // subscription (no header) just starts from "now", same as before.
  const resumeFrom = req.headers?.["Last-Event-ID"] || "now";

  const watcher = new ChangesWatcher(options.db, new Set(streamIds), resumeFrom);
  const sse = new NanoSSE(res, options.heartbeatSeconds, () => watcher.stop());

  watcher.start(
    (doc, seq) => sse.write({ event: "update", stream: doc, time: Date.now() }, seq),
    (error) => {
      sse.write({ event: "error", message: String(error), time: Date.now() });
    }
  );

  return "handled";
}
