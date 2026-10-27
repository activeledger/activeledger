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

import * as net from "net";
import { DEFAULT_MAX_FRAME_BYTES } from "./frame";
import { handshake, P2PIdentity, KnownPeerCheck } from "./handshake";
import { P2PConnection } from "./connection";

export interface P2PClientOptions {
  host: string;
  port: number;
  identity: P2PIdentity;
  /** Refuse the server unless it presents exactly this public key. */
  expectedPeerKey?: string;
  /** Optional further check on the server's verified key. */
  isKnownPeer?: KnownPeerCheck;
  /** Largest frame body accepted or sent. Default 4MB. */
  maxFrameBytes?: number;
  /** Covers TCP connect and handshake. Default 5000ms. */
  handshakeTimeoutMs?: number;
}

/**
 * Dials authenticated P2P connections.
 *
 * @export
 * @class P2PClient
 */
export class P2PClient {
  /**
   * Connect and handshake. Resolves only once both sides have verified each
   * other; rejects (and closes the socket) otherwise.
   *
   * @static
   * @param {P2PClientOptions} options
   * @returns {Promise<P2PConnection>}
   */
  public static async connect(options: P2PClientOptions): Promise<P2PConnection> {
    // Fail closed: a client that accepts any server key can be impersonated
    if (!options.expectedPeerKey && !options.isKnownPeer) {
      throw new Error(
        "P2PClient.connect needs expectedPeerKey or isKnownPeer to authenticate the server"
      );
    }
    const socket = net.connect({ host: options.host, port: options.port });
    const session = await handshake(socket, "client", {
      identity: options.identity,
      expectedPeerKey: options.expectedPeerKey,
      isKnownPeer: options.isKnownPeer,
      timeoutMs: options.handshakeTimeoutMs ?? 5000,
    });
    return new P2PConnection(
      socket,
      session,
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    );
  }
}
