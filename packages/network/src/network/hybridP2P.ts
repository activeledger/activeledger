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

import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger } from "@activeledger/activelogger";
import { P2PConnection, P2PIdentity, P2PServer } from "@activeledger/activep2p";
import { HybridApi } from "./hybridApi";
import { FeedClient, FeedSession, FEED_HEARTBEAT_MS, FEED_POLL_MS } from "./hybridRoutes";

export interface HybridP2POptions {
  port: number;
  host?: string;
  /** This supernode's identity key, which hybrids pin or check against the setup stream */
  identity: P2PIdentity;
  maxFeeds: () => number;
  /** Hand a transaction a hybrid forwarded to the normal external entry point */
  forward?: (tx: any, relayer: string) => Promise<any>;
}

/**
 * The supernode's P2P listener for hybrids. It serves the same messages as
 * `/h/*` over an authenticated, encrypted connection: a hybrid behind NAT
 * dials out and pulls, and items are pushed down the open connection.
 *
 * Channels: bootstrap, head, streams, umid, attest, peers, feed, tx-forward.
 * `feed` is a request ({from}) that answers {ok} and then pushes `feed`
 * messages: {type:"item"|"heartbeat"|"error", ...}.
 */
/** Stops the session behind a feed entry, so a replaced feed really ends */
const replace = new WeakMap<FeedClient, () => void>();

export const startHybridP2P = async (
  api: HybridApi,
  feeds: Set<FeedClient>,
  options: HybridP2POptions
): Promise<P2PServer> => {
  const server = await P2PServer.listen({
    port: options.port,
    host: options.host,
    identity: options.identity,
    // Registered, not retired, not banned: the same test every /h request gets
    isKnownPeer: async (publicKey) => api.stillAllowed(ActiveCrypto.keyHash(publicKey)),
  });

  server.on("connection", (conn: P2PConnection) => {
    const keyHash = ActiveCrypto.keyHash(conn.peerKey);
    let session: FeedSession | undefined;
    let client: FeedClient | undefined;

    const drop = () => {
      session?.stop();
      if (client) feeds.delete(client);
      session = client = undefined;
    };
    conn.on("close", drop);
    conn.on("error", () => undefined);

    // Registration can change while a connection stays open
    const guard = <T>(fn: (payload: any) => Promise<T> | T) => async (payload: any) => {
      if (!(await api.stillAllowed(keyHash))) {
        // Answer first, so the hybrid can tell "refused" from a network fault
        setImmediate(() => conn.drop("no longer allowed"));
        throw new Error("not authorised");
      }
      return fn(payload);
    };

    conn.handle("bootstrap", guard(() => api.bootstrap()));
    conn.handle("head", guard(async () => ({ cursor: await api.head(), time: Date.now(), minVersion: api.minVersion() })));
    conn.handle("streams", guard((p) => {
      if (!Array.isArray(p) || p.some((r) => typeof r?.id !== "string")) throw new Error("expected [{id, rev?}]");
      return api.streams(p);
    }));
    conn.handle("umid", guard((p) => api.umid(String(p?.umid ?? ""))));
    conn.handle("attest", guard((p) => api.attest(String(p?.umid ?? ""))));
    conn.handle("peers", guard(() => api.peers()));
    conn.handle("tx-forward", guard((tx) => {
      if (!options.forward) throw new Error("not accepted here");
      return options.forward(tx, keyHash);
    }));

    conn.handle("feed", guard(async (p) => {
      // One feed per key: a new request replaces this connection's old one,
      // and any other connection's, which may be half-dead. Replaced before
      // the cap is checked, so reconnecting never counts against itself.
      drop();
      for (const other of [...feeds]) {
        if (other.keyHash === keyHash) {
          feeds.delete(other);
          replace.get(other)?.();
        }
      }
      if (feeds.size >= options.maxFeeds()) throw new Error("feed limit reached");
      const from = typeof p?.from === "string" ? p.from : "";
      const me: FeedClient = { keyHash, since: from, connectedAt: Date.now() };
      feeds.add(me);
      client = me;
      replace.set(me, () => session?.stop());
      session = new FeedSession(
        api,
        (event) => {
          if (conn.closed) return false;
          conn.push("feed", event).catch(() => undefined);
          return true;
        },
        from,
        FEED_POLL_MS,
        FEED_HEARTBEAT_MS,
        Date.now,
        () => api.stillAllowed(keyHash),
        () => {
          feeds.delete(me);
          if (client === me) client = undefined;
        },
        (cursor) => {
          me.cursor = cursor;
        }
      );
      await session.start();
      return { ok: true };
    }));
  });

  server.on("reject", (reason: string, address?: string) =>
    ActiveLogger.debug(`Hybrid P2P refused ${address}: ${reason}`)
  );
  server.on("error", (e: Error) => ActiveLogger.error(e, "Hybrid P2P listener"));
  return server;
};
