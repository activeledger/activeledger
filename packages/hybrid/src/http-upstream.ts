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

import * as fs from "fs";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { IBootstrap, Upstream } from "./upstream";

/**
 * - `refused`: 401 or 403, the key is not registered, banned, retired or
 *   its signature was refused. Retrying the same upstream will not help.
 * - `http`: any other unexpected status.
 * - `network`: the request never got a response.
 * - `timeout`: no response, or no feed traffic, in time.
 * - `protocol`: a response that does not follow the contract.
 */
export type UpstreamErrorKind = "refused" | "http" | "network" | "timeout" | "protocol";

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly kind: UpstreamErrorKind,
    public readonly status?: number,
    public readonly body?: any
  ) {
    super(message);
    this.name = "UpstreamError";
  }

  /** Not registered, banned or retired, as opposed to unreachable */
  get refused(): boolean {
    return this.kind === "refused";
  }
}

/** The hybrid's signing identity */
export interface HybridIdentity {
  pair: ActiveCrypto.KeyPair;
  type: string;
  /** Public key PEM, as registered */
  publicPem: string;
  keyHash: string;
}

/** From the node `.identity` JSON: `{type?, prv:{pkcs8pem}, pub:{pkcs8pem}}` */
export function identityFrom(json: any): HybridIdentity {
  const prv = json?.prv?.pkcs8pem;
  const pub = json?.pub?.pkcs8pem;
  if (typeof prv !== "string" || typeof pub !== "string") {
    throw new Error("identity: expected {prv:{pkcs8pem}, pub:{pkcs8pem}}");
  }
  const type = typeof json.type === "string" && json.type ? json.type : "rsa";
  return {
    pair: new ActiveCrypto.KeyPair(type, prv),
    type,
    publicPem: pub,
    keyHash: ActiveCrypto.keyHash(pub),
  };
}

export const loadIdentity = (path: string): HybridIdentity =>
  identityFrom(JSON.parse(fs.readFileSync(path, "utf8")));

export interface SseEvent {
  /** "message" when the event has no `event:` field */
  event: string;
  data: string;
  /** The `id:` of this event only */
  id?: string;
}

/**
 * Incremental Server-Sent Events parser. Push decoded text in any chunking;
 * complete events come back. Handles LF, CRLF and CR line ends (a CR at the
 * end of a chunk waits for a possible LF), multi-line data, comments and a
 * leading BOM. An event left incomplete at the end of the stream is dropped,
 * as the SSE specification says.
 */
export class SseParser {
  private buf = "";
  private started = false;
  private event = "";
  private data: string[] = [];
  private dataBytes = 0;
  private id?: string;

  constructor(private maxBuffer = 64 * 1024 * 1024) {}

  public push(text: string): SseEvent[] {
    if (!this.started && text.length) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.buf += text;
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c !== "\n" && c !== "\r") continue;
      // A CR as the last character may be the first half of a CRLF
      if (c === "\r" && i + 1 === this.buf.length) break;
      const line = this.buf.slice(start, i);
      if (c === "\r" && this.buf[i + 1] === "\n") i++;
      start = i + 1;
      this.line(line, events);
    }
    this.buf = this.buf.slice(start);
    // An event of many short data lines is held in `data`, not `buf`
    if (this.buf.length + this.dataBytes > this.maxBuffer) {
      throw new UpstreamError("feed line too long", "protocol");
    }
    return events;
  }

  /** The stream ended: settle a trailing CR line. Incomplete events are dropped. */
  public end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buf.endsWith("\r")) this.line(this.buf.slice(0, -1), events);
    this.buf = "";
    return events;
  }

  private line(line: string, events: SseEvent[]) {
    if (line === "") {
      if (this.data.length) {
        events.push({
          event: this.event || "message",
          data: this.data.join("\n"),
          ...(this.id !== undefined ? { id: this.id } : {}),
        });
      }
      this.event = "";
      this.data = [];
      this.dataBytes = 0;
      this.id = undefined;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        this.dataBytes += value.length;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      // retry and unknown fields are ignored
    }
  }
}

export interface HttpUpstreamOptions {
  host: string;
  port: number;
  identity: HybridIdentity;
  /** Per request, connection to complete body. Default 15s. */
  timeoutMs?: number;
  /** Feed: longest silence before the connection is treated as dead. Default 35s (heartbeats are about every 10s). */
  idleTimeoutMs?: number;
  /** https instead of http. /h requests are signed, not encrypted: use this over any network you do not own. */
  tls?: boolean;
  /** Largest response body accepted for a unary request. Default 64MB. */
  maxResponseBytes?: number;
}

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A supernode over HTTP: REST plus SSE, with signed-header auth */
export class HttpUpstream implements Upstream {
  public readonly id: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private opts: HttpUpstreamOptions) {
    const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
    this.base = `${opts.tls ? "https" : "http"}://${host}:${opts.port}`;
    this.id = `${host}:${opts.port}:http`;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 35000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024 * 1024;
  }

  private readonly maxResponseBytes: number;
  private lastStamp = 0;

  /** The body as text, refusing more than maxResponseBytes */
  private async readBody(res: Response): Promise<string> {
    const declared = Number(res.headers.get("content-length"));
    if (declared > this.maxResponseBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamError(`${this.id}: response too large`, "protocol", res.status);
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpstreamError(`${this.id}: response too large`, "protocol", res.status);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Fresh signed headers; every request carries them */
  private auth(extra: Record<string, string> = {}): Record<string, string> {
    const { keyHash, pair } = this.opts.identity;
    // The supernode accepts one request per key per timestamp, so every
    // request gets a millisecond of its own
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    const r = ActiveCrypto.signRequest(pair, keyHash, this.lastStamp);
    return {
      "x-hybrid-key": r.key,
      "x-hybrid-timestamp": String(r.timestamp),
      "x-hybrid-signature": r.signature,
      ...extra,
    };
  }

  private failure(e: any, signal: AbortSignal, what: string): UpstreamError {
    if (e instanceof UpstreamError) return e;
    if (signal.aborted && signal.reason instanceof UpstreamError) return signal.reason;
    if (e?.name === "TimeoutError" || signal.reason?.name === "TimeoutError") {
      return new UpstreamError(`${this.id} ${what}: timed out`, "timeout");
    }
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e);
    return new UpstreamError(`${this.id} ${what}: ${cause}`, "network");
  }

  private async statusError(res: Response, what: string): Promise<UpstreamError> {
    let body: any;
    let text = "";
    try {
      text = await this.readBody(res);
      body = JSON.parse(text);
    } catch {
      body = text || undefined;
    }
    const reason =
      (isObject(body) && (body.reason ?? body.error ?? body.message)) ||
      (typeof body === "string" ? body : "") ||
      res.statusText;
    const kind = res.status === 401 || res.status === 403 ? "refused" : "http";
    return new UpstreamError(
      `${this.id} ${what}: ${res.status}${reason ? ` ${reason}` : ""}`,
      kind,
      res.status,
      body
    );
  }

  /** One JSON request. `undefined` for a 404 when `notFound` allows it. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    notFound = false
  ): Promise<any> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const what = `${method} ${path}`;
    try {
      const headers = this.auth({ accept: "application/json" });
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (notFound && res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!res.ok) throw await this.statusError(res, what);
      const text = await this.readBody(res);
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError(`${this.id} ${what}: response is not JSON`, "protocol", res.status);
      }
    } catch (e) {
      throw this.failure(e, signal, what);
    }
  }

  public async bootstrap(): Promise<IBootstrap> {
    const b = await this.request("GET", "/h/bootstrap");
    if (!isObject(b) || !Array.isArray(b.contracts) || typeof b.cursor !== "string") {
      throw new UpstreamError(`${this.id} GET /h/bootstrap: malformed response`, "protocol");
    }
    return { ...b, required: Array.isArray(b.required) ? b.required : [] } as IBootstrap;
  }

  public async head(): Promise<{ cursor: string; time: number }> {
    const h = await this.request("GET", "/h/head");
    if (!isObject(h) || typeof h.cursor !== "string" || typeof h.time !== "number") {
      throw new UpstreamError(`${this.id} GET /h/head: malformed response`, "protocol");
    }
    return { cursor: h.cursor, time: h.time };
  }

  public async streams(
    reqs: { id: string; rev?: string }[]
  ): Promise<{ docs: any[]; missing: { id: string; rev?: string }[] }> {
    const r = await this.request("POST", "/h/streams", reqs);
    if (!isObject(r) || !Array.isArray(r.docs) || !Array.isArray(r.missing)) {
      throw new UpstreamError(`${this.id} POST /h/streams: malformed response`, "protocol");
    }
    return { docs: r.docs, missing: r.missing };
  }

  public umid(umid: string): Promise<any | undefined> {
    return this.request("GET", `/h/umid/${encodeURIComponent(umid)}`, undefined, true);
  }

  public attest(umid: string): Promise<ActiveDefinitions.ICommitAttestation | undefined> {
    return this.request("GET", `/h/attest/${encodeURIComponent(umid)}`, undefined, true);
  }

  public async peers(): Promise<any[]> {
    const p = await this.request("GET", "/h/peers");
    if (!Array.isArray(p)) {
      throw new UpstreamError(`${this.id} GET /h/peers: malformed response`, "protocol");
    }
    return p;
  }

  public submit(tx: any): Promise<any> {
    return this.request("POST", "/", tx);
  }

  public async feed(
    cursor: string,
    onItem: (cursor: string, item: ActiveDefinitions.IFeedItem) => Promise<void>,
    signal: AbortSignal,
    onHeartbeat?: (head: string, time: number) => void
  ): Promise<void> {
    if (signal.aborted) return;
    const what = "GET /h/feed";
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    let idleTimer: NodeJS.Timeout | undefined;
    const idle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          ctl.abort(
            new UpstreamError(`${this.id} ${what}: no traffic for ${this.idleTimeoutMs}ms`, "timeout")
          ),
        this.idleTimeoutMs
      );
    };

    try {
      idle();
      const headers = this.auth({ accept: "text/event-stream" });
      if (cursor) headers["last-event-id"] = cursor;
      let res: Response;
      try {
        res = await fetch(`${this.base}/h/feed?from=${encodeURIComponent(cursor)}`, {
          headers,
          signal: ctl.signal,
        });
      } catch (e) {
        if (signal.aborted) return;
        throw this.failure(e, ctl.signal, what);
      }
      if (!res.ok) throw await this.statusError(res, what);
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("text/event-stream") || !res.body) {
        throw new UpstreamError(`${this.id} ${what}: not an event stream (${type})`, "protocol", res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal.aborted) return;
          throw this.failure(e, ctl.signal, what);
        }
        if (chunk.done) {
          parser.end();
          return;
        }
        idle();
        for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          if (signal.aborted) return;
          if (ev.event === "heartbeat") {
            let hb: any;
            try {
              hb = JSON.parse(ev.data);
            } catch {
              throw new UpstreamError(`${this.id} ${what}: heartbeat is not JSON`, "protocol");
            }
            if (!isObject(hb) || typeof hb.head !== "string" || typeof hb.time !== "number") {
              throw new UpstreamError(`${this.id} ${what}: malformed heartbeat`, "protocol");
            }
            onHeartbeat?.(hb.head, hb.time);
          } else if (ev.event === "message") {
            if (!ev.id) {
              throw new UpstreamError(`${this.id} ${what}: item without a cursor id`, "protocol");
            }
            let item: any;
            try {
              item = JSON.parse(ev.data);
            } catch {
              throw new UpstreamError(`${this.id} ${what}: item ${ev.id} is not JSON`, "protocol");
            }
            // Processing time is not upstream silence
            clearTimeout(idleTimer);
            await onItem(ev.id, item);
            if (signal.aborted) return;
            idle();
          }
          // Other event types are reserved and skipped
        }
      }
    } finally {
      clearTimeout(idleTimer);
      signal.removeEventListener("abort", onAbort);
      // Releases the connection whether we finished, failed or were aborted
      if (!ctl.signal.aborted) ctl.abort();
    }
  }
}
