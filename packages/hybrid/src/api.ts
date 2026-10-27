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

import * as http from "http";
import * as crypto from "crypto";
import { AddressInfo } from "net";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { EVENT_PREFIX } from "@activeledger/activestorage";
import { EventFilter, FilterError, pinnedFilter } from "./events";
import type { SubmitResult } from "./submit";
import type { HybridStore, NodeState, Sources, StreamLookup } from "./types";
import { docHash, verifyAttestation } from "./verify";

type IHybridConfig = ActiveDefinitions.IHybridConfig;

/** Largest `POST /` body, the same cap the supernode applies */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** A stream id: no `:` suffix (meta, volatile, umid) and no `_` internals */
const STREAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const UMID = /^[A-Za-z0-9]{1,128}$/;

export interface HybridServerOptions {
  config: Pick<IHybridConfig, "bind" | "port" | "token" | "maxLagSeconds" | "events">;
  state: NodeState;
  store: Pick<HybridStore, "data" | "events">;
  lookup: StreamLookup;
  submitter: { submit(tx: unknown): Promise<SubmitResult> };
  /** Where `/umid` fetches a pruned or unknown umid from (supernodes) */
  sources?: Sources;
  /** What `activehybrid divergences` and `prune` ask of the running node */
  admin?: {
    divergences(since?: string): Promise<unknown[]>;
    prune(dryRun: boolean): Promise<unknown>;
  };
  /** Longest a request may take before 503. Default 90s (POST / waits for a supernode). */
  requestTimeoutMs?: number;
  /** SSE keep-alive comment interval. Default 15s. */
  heartbeatMs?: number;
  /** How long a stream no upstream had is not asked for again. Default 30s. */
  notFoundCacheMs?: number;
  now?: () => number;
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
};

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

/** Constant time: compared as digests, so the length does not leak either */
const tokenMatches = (header: string | undefined, token: string): boolean => {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return crypto.timingSafeEqual(sha(m ? m[1].trim() : "\u0000"), sha(token)) && !!m;
};

const isDoc = (v: any, id: string) => v && typeof v === "object" && v._id === id;

/** The routes and the methods each allows */
const ROUTES: { match: RegExp; methods: string[] }[] = [
  { match: /^\/health$/, methods: ["GET"] },
  { match: /^\/stream\/[^/]+$/, methods: ["GET"] },
  { match: /^\/umid\/[^/]+$/, methods: ["GET"] },
  { match: /^\/events$/, methods: ["GET"] },
  { match: /^\/$/, methods: ["POST"] },
  // For the activehybrid CLI: the node holds the database, so it answers
  { match: /^\/divergences$/, methods: ["GET"] },
  { match: /^\/prune$/, methods: ["POST"] },
];

/**
 * The hybrid's local API, on Node's http server:
 *
 * - `GET /health`, `GET /stream/:id`, `GET /umid/:umid`, `GET /events` (SSE,
 *   `Last-Event-ID` resume) and `POST /`.
 * - A configured bearer `token` is required on every route.
 * - Errors never carry internals: a fixed message per status.
 */
export class HybridServer {
  private server?: http.Server;
  private readonly sockets = new Set<import("net").Socket>();
  private readonly closers = new Set<() => void>();
  private readonly notFound = new Map<string, number>();
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly notFoundCacheMs: number;

  constructor(private readonly opts: HybridServerOptions) {
    this.now = opts.now ?? Date.now;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 90000;
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    this.notFoundCacheMs = opts.notFoundCacheMs ?? 30000;
  }

  /** Listen on config bind:port (port 0 picks one). Resolves with the address. */
  public start(): Promise<AddressInfo> {
    const server = http.createServer((req, res) => this.handle(req, res));
    // Time to receive a request, separate from the handler timeout below
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.config.port, this.opts.config.bind, () => {
        server.off("error", reject);
        resolve(server.address() as AddressInfo);
      });
    });
  }

  /** Close the server, its event streams and every open connection */
  public stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const close of [...this.closers]) close();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      for (const s of this.sockets) s.destroy();
    });
  }

  /** The `/health` body and its status */
  public health(): { status: number; body: any } {
    const s = this.opts.state;
    const lagSeconds =
      s.headConfirmedAt > 0
        ? Math.max(0, Math.floor((this.now() - s.headConfirmedAt) / 1000))
        : null;
    const body: any = { ready: !!s.ready };
    if (!s.ready) body.reason = s.reason ?? "starting";
    body.version = s.version;
    body.minVersion = s.minVersion ?? null;
    body.lagSeconds = lagSeconds;
    body.cursor = s.cursor;
    body.upstreams = (s.upstreams ?? []).map((u) => ({ host: u.host, ok: !!u.ok }));

    let status = s.ready ? 200 : 503;
    const max = this.opts.config.maxLagSeconds;
    if (status === 200 && typeof max === "number" && max > 0) {
      // Never confirmed at the head counts as beyond any limit
      if (lagSeconds === null || lagSeconds > max) status = 503;
    }
    return { status, body };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const token = this.opts.config.token;
      if (token && !tokenMatches(req.headers.authorization, token)) {
        req.resume();
        return json(res, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
      }

      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://hybrid");
      } catch {
        req.resume();
        return json(res, 400, { error: "Bad request" });
      }
      const path = url.pathname;
      const route = ROUTES.find((r) => r.match.test(path));
      if (!route) {
        req.resume();
        return json(res, 404, { error: "Not found" });
      }
      const method = req.method ?? "GET";
      if (!route.methods.includes(method)) {
        req.resume();
        return json(res, 405, { error: "Method not allowed" }, { allow: route.methods.join(", ") });
      }

      if (path === "/events") return await this.events(req, res, url);

      timer = setTimeout(() => {
        json(res, 503, { error: "Timed out" });
      }, this.requestTimeoutMs);

      if (path === "/health") {
        const h = this.health();
        return json(res, h.status, h.body);
      }
      if (path === "/") return await this.post(req, res);
      if (path === "/divergences" || path === "/prune") return await this.admin(req, res, url);

      const param = safeDecode(path.slice(path.indexOf("/", 1) + 1));
      if (path.startsWith("/stream/")) return await this.stream(res, param);
      return await this.umid(res, param);
    } catch {
      json(res, 500, { error: "Internal error" });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * CLI administration. Loopback only, whatever `bind` and `token` say: one
   * of these deletes history.
   */
  private async admin(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    req.resume();
    const addr = req.socket.remoteAddress ?? "";
    const local = addr === "::1" || addr === "127.0.0.1" || addr.startsWith("127.") || addr === "::ffff:127.0.0.1";
    if (!local) return json(res, 403, { error: "Forbidden" });
    const admin = this.opts.admin;
    if (!admin) return json(res, 404, { error: "Not found" });
    if (url.pathname === "/divergences") {
      const since = url.searchParams.get("since") ?? undefined;
      if (since !== undefined && Number.isNaN(new Date(isNaN(Number(since)) ? since : Number(since)).getTime())) {
        return json(res, 400, { error: "Invalid since" });
      }
      return json(res, 200, await admin.divergences(since));
    }
    return json(res, 200, await admin.prune(url.searchParams.get("dryRun") === "true"));
  }

  private async stream(res: http.ServerResponse, id: string | undefined): Promise<void> {
    if (!id || !STREAM_ID.test(id)) return json(res, 400, { error: "Invalid stream id" });
    let found = await this.readStream(id);
    if (!found) {
      await this.fetchStream(id);
      found = await this.readStream(id);
    }
    if (!found) return json(res, 404, { error: "Stream not found" });
    return json(res, 200, found);
  }

  /** State and `:stream` meta from the local store; volatile is never read */
  private async readStream(id: string): Promise<{ stream: any; meta: any } | undefined> {
    const data = this.opts.store.data;
    const [stream, meta] = await Promise.all([data.get(id), data.get(`${id}:stream`)]);
    if (!isDoc(stream, id) || !isDoc(meta, `${id}:stream`)) return;
    return { stream, meta };
  }

  /** Learn an unknown stream from upstream, once at a time per id */
  private fetchStream(id: string): Promise<void> {
    const until = this.notFound.get(id);
    if (until !== undefined && until > this.now()) return Promise.resolve();
    const inflight = this.fetching.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      let missing = true;
      try {
        const r = await this.opts.lookup.refreshToTip([id]);
        missing = r.missing.includes(id);
      } catch {
        missing = true;
      }
      if (missing) {
        if (this.notFound.size > 10000) this.notFound.clear();
        this.notFound.set(id, this.now() + this.notFoundCacheMs);
      } else {
        this.notFound.delete(id);
      }
    })().finally(() => this.fetching.delete(id));
    this.fetching.set(id, p);
    return p;
  }

  private async umid(res: http.ServerResponse, umid: string | undefined): Promise<void> {
    if (!umid || !UMID.test(umid)) return json(res, 400, { error: "Invalid umid" });
    const local = await this.opts.store.data.get(`${umid}:umid`);
    if (isDoc(local, `${umid}:umid`)) return json(res, 200, local);

    // Pruned or never held: from a supernode, checked against its attestation
    const verify = this.opts.state.verify;
    if (verify) {
      for (const up of this.opts.sources?.supernodes ?? []) {
        try {
          const doc: any = await up.umid(umid);
          const att: ActiveDefinitions.ICommitAttestation | undefined = doc
            ? await up.attest(umid)
            : undefined;
          if (
            doc &&
            att &&
            att.umid === umid &&
            doc._id === `${umid}:umid` &&
            docHash(doc) === att.umidDocHash &&
            verifyAttestation(att, doc.umid?.$revs, verify.keys)
          ) {
            return json(res, 200, doc);
          }
        } catch {
          // next upstream
        }
      }
    }
    return json(res, 404, { error: "Umid not found" });
  }

  private async post(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const declared = Number(req.headers["content-length"]);
    if (declared > MAX_BODY_BYTES) {
      req.resume();
      return json(res, 413, { $hybrid: "denied", error: "Request too large" }, { connection: "close" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const text = await new Promise<string | undefined>((resolve, reject) => {
      // Past the cap the rest is read and dropped, so the client gets the
      // 413 rather than a reset; the server's requestTimeout bounds it
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) chunks.length = 0;
        else chunks.push(c);
      });
      req.on("end", () =>
        resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString("utf8"))
      );
      req.on("error", reject);
    });
    if (text === undefined) {
      return json(res, 413, { $hybrid: "denied", error: "Request too large" }, { connection: "close" });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, { $hybrid: "denied", error: "Invalid JSON" });
    }
    const r = await this.opts.submitter.submit(body);
    return json(res, r.status, r.body);
  }

  /**
   * SSE. Live events, and with `Last-Event-ID` first everything after it.
   * The pinned and the client's filter apply to both, so a resume replays
   * only events the client may see.
   */
  private async events(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    let filter: EventFilter;
    try {
      filter = new EventFilter(pinnedFilter(this.opts.config), EventFilter.parseQuery(url.searchParams));
    } catch (e) {
      return json(res, 400, { error: e instanceof FilterError ? e.message : "Bad filter" });
    }
    const lastHeader = req.headers["last-event-id"];
    const lastEventId = typeof lastHeader === "string" && lastHeader.length <= 512 ? lastHeader : "";

    req.socket.setTimeout(0);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(":\n\n");

    let open = true;
    const send = (id: string, event: any) => {
      if (!open || !filter.allows(event)) return;
      res.write(`id:${id}\nevent: message\ndata:${JSON.stringify(event)}\n\n`);
    };

    // Attached before the replay is read, so an event committed during the
    // read is in one or the other; held back until the replay is sent
    let pending: [string, any][] | null = lastEventId ? [] : null;
    let replayed: Set<string> | null = null;
    const listener = (change: any) => {
      const docId: string = change?.id ?? "";
      if (!docId.startsWith(EVENT_PREFIX) || !change.doc) return;
      const { _id, _rev, ...event } = change.doc;
      const id = docId.slice(EVENT_PREFIX.length);
      if (pending) pending.push([id, event]);
      else if (!replayed || !replayed.has(id)) send(id, event);
    };
    const emitter = this.opts.store.events.level.changes();
    emitter.on("change", listener);
    const heartbeat = setInterval(() => open && res.write(":\n\n"), this.heartbeatMs);

    const close = () => {
      if (!open) return;
      open = false;
      emitter.off("change", listener);
      clearInterval(heartbeat);
      this.closers.delete(close);
      res.end();
    };
    this.closers.add(close);
    req.on("close", close);
    res.on("error", close);

    if (lastEventId) {
      try {
        const missed = await this.opts.store.events.eventsSince(lastEventId);
        for (const [id, event] of missed) send(id, event);
        replayed = new Set(missed.map(([id]) => id));
      } catch {
        replayed = new Set();
      }
      const held = pending ?? [];
      pending = null;
      for (const [id, event] of held) if (!replayed.has(id)) send(id, event);
      // Only a live event that raced the replay can be a duplicate
      replayed = null;
    }
  }
}

const safeDecode = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s);
  } catch {
    return;
  }
};
