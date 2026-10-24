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

import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { P2PClient, P2PConnection } from "@activeledger/activep2p";
import { HybridIdentity, UpstreamError } from "./http-upstream";
import { IBootstrap, Upstream } from "./upstream";
import { nodeKeys } from "./verify";

export interface P2PUpstreamOptions {
  host: string;
  port: number;
  identity: HybridIdentity;
  /** Per request. Default 15s. */
  timeoutMs?: number;
  /** Feed: longest silence (heartbeats come about every 10s). Default 35s. */
  idleTimeoutMs?: number;
  /**
   * The supernode's identity key, when known: every connection must present
   * exactly this key.
   */
  expectedPeerKey?: string;
  /**
   * The setup stream's network id. Without `expectedPeerKey` it is required:
   * `bootstrap()` checks the supernode's key against the setup stream's
   * nodes, see the class notes.
   */
  network?: () => string;
}

/** The supernode's answer to a request from a key it no longer allows */
const NOT_AUTHORISED = "not authorised";

/**
 * An Upstream over the authenticated P2P transport (`startHybridP2P` on the
 * supernode). Requests share one connection, dialled on first use and
 * re-dialled once it closes; concurrent calls share one dial. Each `feed()`
 * gets a connection of its own, closed when the feed ends: the supernode has
 * no "stop feed" message, so closing is what ends its session, and a feed's
 * pushes can never reach another feed.
 *
 * Authenticating the supernode:
 * - With `expectedPeerKey`, every connection must present that key.
 * - Without it, trust is on first use: the first connection accepts any key
 *   that signs the handshake, and only `bootstrap()` may run on it.
 *   `bootstrap()` then requires the key to be one of the nodes of the setup
 *   stream it returns (by `neighbourhood[].identity.public`). Until that
 *   check has passed every other call is refused, and afterwards every
 *   connection must present one of those keys. This only shows the peer is a
 *   node of the setup it served: the caller must check that setup against its
 *   pin (or other trust) before acting on either.
 *
 * Errors, as `UpstreamError` kinds:
 * - `network`: the connection could not be made or was lost. A failed dial
 *   is marked `undelivered`, so a forwarded transaction can go elsewhere.
 *   A supernode refuses a key that is not registered, or is banned or
 *   retired, by closing the connection during the handshake; the transport
 *   cannot tell that apart from any other early close.
 * - `protocol`: the supernode's key is not the expected one, or a response
 *   or feed message does not follow the contract.
 * - `timeout`: no response in `timeoutMs`, or no feed traffic in
 *   `idleTimeoutMs`.
 * - `refused`: the supernode answered "not authorised" (it does so on the
 *   feed when the key is banned or retired while connected).
 * - `http`: any other error the supernode answered with (the counterpart of
 *   an error status; there is no status code).
 */
export class P2PUpstream implements Upstream {
  public readonly id: string;
  private conn?: P2PConnection;
  private connecting?: Promise<P2PConnection>;
  /** Setup stream node keys, once `bootstrap()` has checked the peer against them */
  private nodes?: Set<string>;
  /** Open connections (shared and feeds), for close() */
  private open = new Set<P2PConnection>();

  constructor(private opts: P2PUpstreamOptions) {
    if (!opts.expectedPeerKey && !opts.network) {
      throw new Error("P2PUpstream needs expectedPeerKey or network to authenticate the supernode");
    }
    const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
    this.id = `${host}:${opts.port}:p2p`;
  }

  /** The supernode's key has been checked: pinned, or by `bootstrap()` */
  private get verified(): boolean {
    return !!this.opts.expectedPeerKey || !!this.nodes;
  }

  /** Whether a dial may accept this (handshake-verified) supernode key */
  private acceptable(key: string): boolean {
    if (this.opts.expectedPeerKey) return key === this.opts.expectedPeerKey;
    // Trust on first use: nothing to check against until bootstrap() has run,
    // and until then only bootstrap() is allowed on the connection
    return this.nodes ? this.nodes.has(key) : true;
  }

  /** Dial and handshake one connection */
  private async dial(what: string): Promise<P2PConnection> {
    let unacceptable: string | undefined;
    let c: P2PConnection;
    try {
      c = await P2PClient.connect({
        host: this.opts.host,
        port: this.opts.port,
        identity: {
          type: this.opts.identity.type,
          publicKey: this.opts.identity.publicPem,
          privateKey: this.opts.identity.pair.pem as string,
        },
        // Called after the handshake signature is verified, so the key is proven
        isKnownPeer: (key) => {
          const ok = this.acceptable(key);
          if (!ok) unacceptable = key;
          return ok;
        },
        handshakeTimeoutMs: 5000,
      });
    } catch (e: any) {
      const reason = String(e?.message ?? e);
      const error = unacceptable
        ? new UpstreamError(
            `${this.id} ${what}: supernode key is not ${
              this.opts.expectedPeerKey ? "the expected key" : "a node of the setup stream"
            }`,
            "protocol"
          )
        : new UpstreamError(
            `${this.id} ${what}: ${reason}` +
              (reason === "connection closed during handshake"
                ? " (a supernode closes it for a key that is not registered, or is banned or retired)"
                : ""),
            "network"
          );
      // Nothing was sent: a transaction can be tried elsewhere
      (error as any).undelivered = true;
      throw error;
    }
    c.on("error", () => undefined);
    this.open.add(c);
    c.once("close", () => this.open.delete(c));
    return c;
  }

  /** The shared connection for requests */
  private connection(what: string): Promise<P2PConnection> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.connecting ??= this.dial(what)
      .then((c) => (this.conn = c))
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async request(c: P2PConnection, channel: string, payload: unknown): Promise<any> {
    const timeoutMs = this.opts.timeoutMs ?? 15000;
    let timer: NodeJS.Timeout | undefined;
    // Our own deadline, so a timeout is known as one; the transport's is a backstop
    const pending = c.request(channel, payload, timeoutMs + 5000);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new UpstreamError(`${this.id} ${channel}: timed out after ${timeoutMs}ms`, "timeout")),
        timeoutMs
      );
    });
    try {
      return await Promise.race([pending, deadline]);
    } catch (e: any) {
      if (e instanceof UpstreamError) throw e;
      const message = String(e?.message ?? e);
      // The transport rejects every pending request when the connection closes
      if (c.closed) {
        throw new UpstreamError(`${this.id} ${channel}: connection closed: ${c.closeReason ?? "remote"}`, "network");
      }
      // Otherwise the supernode answered with this error
      if (message === NOT_AUTHORISED) {
        throw new UpstreamError(`${this.id} ${channel}: ${message}`, "refused", 403);
      }
      throw new UpstreamError(`${this.id} ${channel}: ${message}`, "http");
    } finally {
      clearTimeout(timer);
      pending.catch(() => undefined);
    }
  }

  private async call(channel: string, payload: unknown): Promise<any> {
    if (!this.verified && channel !== "bootstrap") {
      throw new UpstreamError(
        `${this.id} ${channel}: the supernode's key is not pinned, so bootstrap() must check it first`,
        "protocol"
      );
    }
    return this.request(await this.connection(channel), channel, payload);
  }

  public async bootstrap(): Promise<IBootstrap> {
    const c = await this.connection("bootstrap");
    const b = await this.request(c, "bootstrap", {});
    if (!b || !Array.isArray(b.contracts) || typeof b.cursor !== "string") {
      throw new UpstreamError(`${this.id} bootstrap: malformed response`, "protocol");
    }
    // The key we are talking to must be one of the setup stream's nodes. A
    // pinned key is trusted as it is when the supernode has no setup yet.
    if (this.opts.network && (b.setup || !this.opts.expectedPeerKey)) {
      const nodes = new Set([...nodeKeys(b.setup, this.opts.network()).values()].map((k) => k.public));
      if (!nodes.has(c.peerKey)) {
        c.drop("peer is not a node of the setup stream");
        throw new UpstreamError(
          `${this.id} bootstrap: supernode key is not a node of the setup stream` +
            (nodes.size ? "" : " (it lists no node keys)"),
          "protocol"
        );
      }
      this.nodes = nodes;
    }
    return { ...b, required: Array.isArray(b.required) ? b.required : [] } as IBootstrap;
  }

  public async head(): Promise<{ cursor: string; time: number }> {
    const h = await this.call("head", {});
    if (typeof h?.cursor !== "string" || typeof h?.time !== "number") {
      throw new UpstreamError(`${this.id} head: malformed response`, "protocol");
    }
    return { cursor: h.cursor, time: h.time };
  }

  public async streams(reqs: { id: string; rev?: string }[]) {
    const r = await this.call("streams", reqs);
    if (!Array.isArray(r?.docs) || !Array.isArray(r?.missing)) {
      throw new UpstreamError(`${this.id} streams: malformed response`, "protocol");
    }
    return { docs: r.docs, missing: r.missing };
  }

  public async umid(umid: string): Promise<any | undefined> {
    return (await this.call("umid", { umid })) ?? undefined;
  }

  public async attest(umid: string): Promise<ActiveDefinitions.ICommitAttestation | undefined> {
    return (await this.call("attest", { umid })) ?? undefined;
  }

  public async peers(): Promise<any[]> {
    const p = await this.call("peers", {});
    if (!Array.isArray(p)) throw new UpstreamError(`${this.id} peers: malformed response`, "protocol");
    return p;
  }

  public submit(tx: any): Promise<any> {
    return this.call("tx-forward", tx);
  }

  public async feed(
    cursor: string,
    onItem: (cursor: string, item: ActiveDefinitions.IFeedItem) => Promise<void>,
    signal: AbortSignal,
    onHeartbeat?: (head: string, time: number) => void
  ): Promise<void> {
    if (signal.aborted) return;
    if (!this.verified) {
      throw new UpstreamError(
        `${this.id} feed: the supernode's key is not pinned, so bootstrap() must check it first`,
        "protocol"
      );
    }
    const c = await this.dial("feed");
    if (signal.aborted) return void c.close();

    return new Promise<void>((resolve, reject) => {
      let done = false;
      // Items and heartbeats in arrival order, one at a time: never overlapping
      let chain: Promise<void> = Promise.resolve();
      let idle: NodeJS.Timeout | undefined;
      const idleMs = this.opts.idleTimeoutMs ?? 35000;

      // Settles once whatever onItem is running has returned, so a caller
      // never sees the feed end while its handler is still busy
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(idle);
        signal.removeEventListener("abort", onAbort);
        c.off("close", onClose);
        // Ends the supernode's session; later pushes go nowhere
        c.close();
        void chain.then(() => (error === undefined ? resolve() : reject(error)));
      };
      const fail = (message: string, kind: "protocol" | "refused" | "http") =>
        finish(new UpstreamError(`${this.id} feed: ${message}`, kind, kind === "refused" ? 403 : undefined));
      const onAbort = () => finish();
      const onClose = () =>
        finish(new UpstreamError(`${this.id} feed: connection closed: ${c.closeReason ?? "remote"}`, "network"));
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => finish(new UpstreamError(`${this.id} feed: no traffic for ${idleMs}ms`, "timeout")),
          idleMs
        );
      };
      const queue = (fn: () => void | Promise<void>) => {
        chain = chain.then(() => (done ? undefined : fn())).catch((e) => finish(e ?? new Error("onItem failed")));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      c.on("close", onClose);
      touch();

      c.handle("feed", (m: any) => {
        if (done) return;
        touch();
        switch (m?.type) {
          case "heartbeat":
            if (typeof m.head !== "string" || typeof m.time !== "number") return fail("malformed heartbeat", "protocol");
            return queue(() => onHeartbeat?.(m.head, m.time));
          case "item":
            if (typeof m.cursor !== "string" || !m.cursor || !m.item || typeof m.item !== "object") {
              return fail("malformed item", "protocol");
            }
            return queue(() => onItem(m.cursor, m.item));
          case "error":
            return fail(String(m.error), m.error === NOT_AUTHORISED ? "refused" : "http");
          // Other types are reserved and skipped
        }
      });

      this.request(c, "feed", { from: cursor }).then(
        (r) => r?.ok === true || fail("malformed response", "protocol"),
        (e) => finish(e)
      );
    });
  }

  /** Close every connection; feeds end with a network error. A later call dials again. */
  public close(): void {
    for (const c of this.open) c.close();
    this.connecting?.then((c) => c.close(), () => undefined);
  }
}
