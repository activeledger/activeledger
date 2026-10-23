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

import { HttpRequest, HttpResponse, TemplatedApp } from "uWebSockets.js";
import { ActiveLogger } from "@activeledger/activelogger";
import { HybridApi } from "./hybridApi";

/** How often a feed polls for new items, and how often it sends a heartbeat */
export const FEED_POLL_MS = 500;
export const FEED_HEARTBEAT_MS = 10_000;

export interface FeedClient {
  keyHash: string;
  since: string;
  /** The last cursor sent, kept current by the session */
  cursor?: string;
  connectedAt: number;
}

/**
 * One connected hybrid's feed. Transport free: `write` sends SSE text and
 * returns false once the client has gone.
 */
export class FeedSession {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastBeat = 0;
  private stopped = false;
  public cursor: string;

  constructor(
    private api: HybridApi,
    private write: (chunk: string) => boolean,
    from: string,
    private pollMs = FEED_POLL_MS,
    private heartbeatMs = FEED_HEARTBEAT_MS,
    private now: () => number = Date.now,
    /** Asked on every heartbeat: a banned or retired key loses its feed */
    private allowed: () => Promise<boolean> = async () => true,
    /** Called once when the session ends, whatever the reason */
    private onStop: () => void = () => {},
    /** Called with each cursor sent, for `hybrid feeds` */
    private onCursor: (cursor: string) => void = () => {}
  ) {
    this.cursor = from;
  }

  /** Send the first heartbeat and begin polling */
  public async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.stopped) {
      this.stopped = true;
      this.onStop();
    }
  }

  /** Send everything ready after the cursor, then a heartbeat if one is due */
  public async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const items = await this.api.feedSince(this.cursor, 50);
        for (const { cursor, item } of items) {
          if (!this.write(`id: ${cursor}\ndata: ${JSON.stringify(item)}\n\n`)) {
            return this.stop();
          }
          this.cursor = cursor;
          this.onCursor(cursor);
        }
        if (items.length < 50) break;
      }
      if (this.now() - this.lastBeat >= this.heartbeatMs) await this.beat();
    } catch (e) {
      ActiveLogger.error(e, "Hybrid feed failed");
      this.write(`event: error\ndata: {"error":"feed failed"}\n\n`);
      this.stop();
    } finally {
      this.busy = false;
    }
  }

  private async beat(): Promise<void> {
    this.lastBeat = this.now();
    if (!(await this.allowed())) {
      this.write(`event: error\ndata: {"error":"not authorised"}\n\n`);
      return this.stop();
    }
    const head = await this.api.head(this.now());
    if (!this.write(`event: heartbeat\ndata: ${JSON.stringify({ head, time: this.now() })}\n\n`)) {
      this.stop();
    }
  }
}

export interface HybridRouteOptions {
  /** Feeds allowed at once (`hybrid.maxFeeds` in the supernode's own config) */
  maxFeeds: () => number;
  /** Largest `POST /h/streams` body */
  maxBodyBytes?: number;
  /** Called as feeds open and close, for `hybrid feeds` */
  onFeeds?: (feeds: Set<FeedClient>) => void;
}

/**
 * Register `/h/*` on the supernode's uWebSockets app. Every route
 * authenticates first. These are more specific than the catch-all, so
 * uWebSockets matches them before it.
 */
export const registerHybridRoutes = (
  app: TemplatedApp,
  api: HybridApi,
  options: HybridRouteOptions
): Set<FeedClient> => {
  const feeds = new Set<FeedClient>();
  const closers = new Map<FeedClient, () => void>();

  const send = (res: HttpResponse, status: number, body: unknown) => {
    if (!(res as any).writable) return;
    (res as any).writable = false;
    res.cork(() => {
      res.writeStatus(String(status));
      res.writeHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
  };

  /** Read what must be read synchronously, then authenticate */
  const guard = (
    handler: (res: HttpResponse, ctx: { keyHash: string; params: string[]; query: string; lastEventId: string; req: HttpRequest }) => Promise<void> | void,
    paramCount = 0
  ) =>
    (res: HttpResponse, req: HttpRequest) => {
      (res as any).writable = true;
      res.onAborted(() => {
        (res as any).writable = false;
      });
      const headers = {
        key: req.getHeader("x-hybrid-key"),
        timestamp: req.getHeader("x-hybrid-timestamp"),
        signature: req.getHeader("x-hybrid-signature"),
      };
      const params = Array.from({ length: paramCount }, (_, i) => req.getParameter(i) ?? "");
      const query = req.getQuery() ?? "";
      const lastEventId = req.getHeader("last-event-id");
      api
        .authenticate(headers)
        .then(async (auth) => {
          if (!auth.ok) return send(res, auth.status, { error: auth.reason });
          await handler(res, { keyHash: auth.keyHash, params, query, lastEventId, req });
        })
        .catch((e) => {
          ActiveLogger.error(e, "Hybrid route failed");
          send(res, 500, { error: "internal error" });
        });
    };

  app.get("/h/bootstrap", guard(async (res) => send(res, 200, await api.bootstrap())));
  app.get("/h/head", guard(async (res) => {
    const now = Date.now();
    send(res, 200, { cursor: await api.head(now), time: now });
  }));
  app.get("/h/peers", guard(async (res) => send(res, 200, await api.peers())));
  app.get("/h/umid/:umid", guard(async (res, c) => {
    const doc = await api.umid(c.params[0]);
    doc ? send(res, 200, doc) : send(res, 404, { error: "not found" });
  }, 1));
  app.get("/h/attest/:umid", guard(async (res, c) => {
    const doc = await api.attest(c.params[0]);
    doc ? send(res, 200, doc) : send(res, 404, { error: "not found" });
  }, 1));

  app.post("/h/streams", (res, req) => {
    (res as any).writable = true;
    const headers = {
      key: req.getHeader("x-hybrid-key"),
      timestamp: req.getHeader("x-hybrid-timestamp"),
      signature: req.getHeader("x-hybrid-signature"),
    };
    const chunks: Buffer[] = [];
    let size = 0;
    const max = options.maxBodyBytes ?? 1024 * 1024;
    let refused = false;
    res.onAborted(() => {
      (res as any).writable = false;
    });
    res.onData((ab, last) => {
      if (refused) return;
      size += ab.byteLength;
      if (size > max) {
        refused = true;
        return send(res, 413, { error: "request too large" });
      }
      chunks.push(Buffer.from(new Uint8Array(ab)));
      if (!last) return;
      api
        .authenticate(headers)
        .then(async (auth) => {
          if (!auth.ok) return send(res, auth.status, { error: auth.reason });
          let requests: any;
          try {
            requests = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            return send(res, 400, { error: "invalid JSON" });
          }
          if (
            !Array.isArray(requests) ||
            requests.some((r) => typeof r?.id !== "string" || (r.rev !== undefined && typeof r.rev !== "string"))
          ) {
            return send(res, 400, { error: "expected [{id, rev?}]" });
          }
          send(res, 200, await api.streams(requests));
        })
        .catch((e) => {
          ActiveLogger.error(e, "Hybrid streams failed");
          send(res, 500, { error: "internal error" });
        });
    });
  });

  app.get("/h/feed", guard(async (res, c) => {
    const fromParam = new URLSearchParams(c.query).get("from") ?? "";
    // A reconnecting client's Last-Event-ID wins over its original ?from
    const from = c.lastEventId || fromParam;
    const client: FeedClient = { keyHash: c.keyHash, since: from, connectedAt: Date.now() };

    // One feed per key: a reconnect replaces the old one, so a half-dead
    // connection cannot hold the slot against its own owner
    for (const [old, end] of closers) {
      if (old.keyHash === c.keyHash) end();
    }
    // Checked after the replacement, which may have freed the slot
    if (feeds.size >= options.maxFeeds()) {
      return send(res, 503, { error: "feed limit reached" });
    }

    feeds.add(client);
    options.onFeeds?.(feeds);

    res.cork(() => {
      res.writeStatus("200");
      res.writeHeader("Content-Type", "text/event-stream");
      res.writeHeader("Cache-Control", "no-cache");
      res.write(": connected\n\n");
    });

    const finish = () => {
      closers.delete(client);
      feeds.delete(client);
      options.onFeeds?.(feeds);
      if ((res as any).writable) {
        (res as any).writable = false;
        res.cork(() => res.end());
      }
    };
    const session: FeedSession = new FeedSession(
      api,
      (chunk) => {
        if (!(res as any).writable) return false;
        res.cork(() => res.write(chunk));
        return true;
      },
      from,
      FEED_POLL_MS,
      FEED_HEARTBEAT_MS,
      Date.now,
      () => api.stillAllowed(c.keyHash),
      finish,
      (cursor) => {
        client.cursor = cursor;
      }
    );
    closers.set(client, () => session.stop());
    res.onAborted(() => {
      (res as any).writable = false;
      session.stop();
    });
    try {
      await session.start();
    } catch (e) {
      ActiveLogger.error(e, "Hybrid feed failed to start");
      session.stop();
    }
  }));

  return feeds;
};
