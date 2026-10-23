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
   * The supernode's key, when known: pinned in the handshake. Without it the
   * first connection accepts any key, and `bootstrap()` then checks that the
   * key is one of the setup stream's nodes (the setup itself is what a
   * `pin` in the config protects).
   */
  expectedPeerKey?: string;
  /** The setup stream's network id, for checking the peer against its nodes */
  network?: () => string;
}

/**
 * An Upstream over the authenticated P2P transport. One connection is kept
 * and re-dialled when it drops; the feed is requested on it and items are
 * pushed back.
 */
export class P2PUpstream implements Upstream {
  public readonly id: string;
  private conn?: P2PConnection;
  private connecting?: Promise<P2PConnection>;
  private known?: Set<string>;

  constructor(private opts: P2PUpstreamOptions) {
    const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
    this.id = `${host}:${opts.port}:p2p`;
  }

  private async connection(): Promise<P2PConnection> {
    if (this.conn && !this.conn.closed) return this.conn;
    this.connecting ??= P2PClient.connect({
      host: this.opts.host,
      port: this.opts.port,
      identity: {
        type: this.opts.identity.type,
        publicKey: this.opts.identity.publicPem,
        privateKey: this.opts.identity.pair.pem as string,
      },
      expectedPeerKey: this.opts.expectedPeerKey,
      // Before bootstrap there is nothing to check against (see the option)
      isKnownPeer: this.opts.expectedPeerKey ? undefined : (key) => !this.known || this.known.has(key),
      handshakeTimeoutMs: 5000,
    })
      .then((c) => {
        this.conn = c;
        c.on("error", () => undefined);
        return c;
      })
      .catch((e: Error) => {
        throw new UpstreamError(`${this.id}: ${e.message}`, "network");
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async call(channel: string, payload: unknown): Promise<any> {
    const c = await this.connection();
    try {
      return await c.request(channel, payload, this.opts.timeoutMs ?? 15000);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      if (/not authorised|no longer allowed/i.test(message)) {
        throw new UpstreamError(`${this.id} ${channel}: ${message}`, "refused", 403);
      }
      throw new UpstreamError(
        `${this.id} ${channel}: ${message}`,
        /timed out/i.test(message) ? "timeout" : "network"
      );
    }
  }

  public async bootstrap(): Promise<IBootstrap> {
    const b = await this.call("bootstrap", {});
    if (!b || !Array.isArray(b.contracts) || typeof b.cursor !== "string") {
      throw new UpstreamError(`${this.id} bootstrap: malformed response`, "protocol");
    }
    // The key we are talking to must be one of the setup stream's nodes
    if (b.setup && this.opts.network) {
      this.known = new Set(
        [...nodeKeys(b.setup, this.opts.network()).values()].map((k) => k.public)
      );
      const peer = this.conn?.peerKey;
      if (this.known.size && peer && !this.known.has(peer)) {
        this.conn?.drop("peer is not a node of the setup stream");
        throw new UpstreamError(`${this.id} bootstrap: peer key is not a node in the setup stream`, "refused", 403);
      }
    }
    return { ...b, required: Array.isArray(b.required) ? b.required : [] } as IBootstrap;
  }

  public async head(): Promise<{ cursor: string; time: number }> {
    const h = await this.call("head", {});
    if (typeof h?.cursor !== "string" || typeof h?.time !== "number") {
      throw new UpstreamError(`${this.id} head: malformed response`, "protocol");
    }
    return h;
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
    const c = await this.connection();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let chain: Promise<void> = Promise.resolve();
      let idle: NodeJS.Timeout | undefined;
      const idleMs = this.opts.idleTimeoutMs ?? 35000;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        signal.removeEventListener("abort", onAbort);
        c.off("close", onClose);
        // Stop receiving; a later feed() sets its own handler
        c.handle("feed", () => undefined);
        error ? reject(error) : resolve();
      };
      const onAbort = () => finish();
      const onClose = () => finish();
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => finish(new UpstreamError(`${this.id} feed: no traffic for ${idleMs}ms`, "timeout")),
          idleMs
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      c.on("close", onClose);
      touch();

      // Pushes arrive as they are sent; the chain keeps onItem one at a time, in order
      c.handle("feed", (m: any) => {
        touch();
        if (m?.type === "heartbeat") return void onHeartbeat?.(m.head, m.time);
        if (m?.type === "error") {
          return finish(new UpstreamError(`${this.id} feed: ${m.error}`, /authoris/.test(m.error) ? "refused" : "protocol"));
        }
        if (m?.type !== "item" || typeof m.cursor !== "string") return;
        chain = chain
          .then(() => (settled ? undefined : onItem(m.cursor, m.item)))
          .catch((e) => finish(e));
      });

      this.call("feed", { from: cursor }).catch((e) => finish(e));
    });
  }

  public close(): void {
    this.conn?.close();
  }
}
