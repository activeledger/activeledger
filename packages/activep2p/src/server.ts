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

import { EventEmitter } from "events";
import * as net from "net";
import { DEFAULT_MAX_FRAME_BYTES } from "./frame";
import { handshake, P2PIdentity, KnownPeerCheck } from "./handshake";
import { P2PConnection, ChannelHandler } from "./connection";

/**
 * The address a connection counts against: IPv4-mapped IPv6 becomes IPv4, and
 * an IPv6 address is grouped by its /64, since one host usually holds a whole
 * /64 and a per-address cap on single addresses would be free to dodge.
 */
export const addressGroup = (address: string | undefined): string => {
  if (!address) return "unknown";
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (address.includes(":")) {
    const [head, tail] = address.split("::");
    const groups = head.split(":").filter(Boolean);
    if (tail === undefined && groups.length === 8) return groups.slice(0, 4).join(":");
    return groups.slice(0, 4).join(":") + (groups.length < 4 ? "::" : "");
  }
  return address;
};

export interface P2PServerOptions {
  port: number;
  host?: string;
  identity: P2PIdentity;
  isKnownPeer: KnownPeerCheck;
  /** Established inbound connections. Default 64. */
  maxConnections?: number;
  /**
   * Sockets still handshaking, across all addresses. They are capped apart
   * from established connections so unauthenticated sockets can never use
   * up the slots authenticated peers need. Default 16.
   */
  maxHandshaking?: number;
  /** Sockets still handshaking from one address. Default 4. */
  maxHandshakingPerAddress?: number;
  /** Largest frame body accepted or sent. Default 4MB. */
  maxFrameBytes?: number;
  /** Default 3000ms. */
  handshakeTimeoutMs?: number;
}

/**
 * Accepts authenticated P2P connections.
 *
 * Events:
 *  - "connection" (connection: P2PConnection) after a successful handshake
 *  - "reject" (reason: string, remoteAddress?: string) for a refused socket
 *  - "error" (error: Error) server socket errors
 *
 * @export
 * @class P2PServer
 * @extends {EventEmitter}
 */
export class P2PServer extends EventEmitter {
  public readonly connections = new Set<P2PConnection>();
  private sockets = new Set<net.Socket>();
  private handshaking = new Map<net.Socket, string>();
  private handlers = new Map<string, ChannelHandler>();
  private server: net.Server;

  private constructor(private options: P2PServerOptions) {
    super();
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => this.emit("error", error));
  }

  /**
   * Start listening. Resolves once the port is bound.
   *
   * @static
   * @param {P2PServerOptions} options
   * @returns {Promise<P2PServer>}
   */
  public static listen(options: P2PServerOptions): Promise<P2PServer> {
    const p2p = new P2PServer(options);
    return new Promise((resolve, reject) => {
      p2p.server.once("error", reject);
      p2p.server.listen(options.port, options.host, () => {
        p2p.server.off("error", reject);
        resolve(p2p);
      });
    });
  }

  /**
   * The bound port (useful when listening on port 0).
   */
  public get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  /**
   * Register a channel handler for every connection.
   *
   * @param {string} channel
   * @param {ChannelHandler} handler
   * @returns {this}
   */
  public handle(channel: string, handler: ChannelHandler): this {
    this.handlers.set(channel, handler);
    return this;
  }

  /**
   * Stop accepting and drop every connection.
   *
   * @returns {Promise<void>}
   */
  public close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    const address = addressGroup(socket.remoteAddress);
    // Established connections are full: refuse before spending a handshake
    if (this.connections.size >= (this.options.maxConnections ?? 64)) {
      socket.destroy();
      this.emit("reject", "connection limit reached", address);
      return;
    }
    let fromAddress = 0;
    for (const a of this.handshaking.values()) if (a === address) fromAddress++;
    if (fromAddress >= (this.options.maxHandshakingPerAddress ?? 4)) {
      socket.destroy();
      this.emit("reject", "too many unauthenticated connections", address);
      return;
    }
    // Full: drop the oldest half-open socket, so a flood of idle sockets
    // cannot keep a real peer out. An attacker has to keep re-dialling.
    if (this.handshaking.size >= (this.options.maxHandshaking ?? 16)) {
      const oldest = this.handshaking.keys().next().value as net.Socket;
      this.emit("reject", "too many unauthenticated connections", this.handshaking.get(oldest));
      oldest.destroy();
      this.handshaking.delete(oldest);
    }
    this.sockets.add(socket);
    this.handshaking.set(socket, address);
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.handshaking.delete(socket);
    });

    handshake(socket, "server", {
      identity: this.options.identity,
      isKnownPeer: this.options.isKnownPeer,
      timeoutMs: this.options.handshakeTimeoutMs ?? 3000,
    }).then(
      (session) => {
        this.handshaking.delete(socket);
        if (this.connections.size >= (this.options.maxConnections ?? 64)) {
          socket.destroy();
          this.emit("reject", "connection limit reached", address);
          return;
        }
        const connection = new P2PConnection(
          socket,
          session,
          this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
          this.handlers
        );
        this.connections.add(connection);
        connection.on("close", () => this.connections.delete(connection));
        this.emit("connection", connection);
      },
      (error: Error) => this.emit("reject", error.message, socket.remoteAddress)
    );
  }
}
