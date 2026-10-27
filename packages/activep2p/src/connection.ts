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
import { Socket } from "net";
import { writeFrame, encode, decode, seal, open, TAG_BYTES } from "./frame";
import { Session } from "./handshake";

/**
 * Handles a request (its return value is the response) or a push (its
 * return value is ignored) on one channel.
 */
export type ChannelHandler = (payload: any, connection: P2PConnection) => any;

const REQUEST = 0;
const RESPONSE = 1;
const PUSH = 2;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * An authenticated, encrypted connection to one peer.
 *
 * Events:
 *  - "close" (reason?: string) once, when the connection ends for any reason
 *  - "error" (error: Error) on socket errors and handler failures, only
 *    emitted when something is listening for it
 *
 * @export
 * @class P2PConnection
 * @extends {EventEmitter}
 */
export class P2PConnection extends EventEmitter {
  /**
   * The peer's verified identity public key, as it presented it.
   */
  public readonly peerKey: string;

  /**
   * The peer's identity key type (rsa, secp256k1, ml-dsa-65, ...).
   */
  public readonly peerKeyType: string;

  /**
   * Why the connection was dropped, when it was.
   */
  public closeReason?: string;

  public closed = false;

  private handlers = new Map<string, ChannelHandler>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private sendCounter: bigint;
  private receiveCounter: bigint;

  constructor(
    private socket: Socket,
    private session: Session,
    private maxFrameBytes: number,
    private fallbackHandlers?: Map<string, ChannelHandler>
  ) {
    super();
    this.peerKey = session.peerKey;
    this.peerKeyType = session.peerKeyType;
    this.sendCounter = session.sendCounter;
    this.receiveCounter = session.receiveCounter;

    socket.on("close", () => this.closedDown());
    socket.on("error", (error) => {
      this.closeReason ??= error.message;
      this.raise(error);
    });

    const { reader } = session;
    reader.maxFrameBytes = maxFrameBytes;
    reader.onFrame = (frame) => this.receive(frame);
    reader.onError = (reason) => this.drop(reason);
    reader.resume();
    socket.resume();
  }

  /**
   * Register the handler for a channel on this connection.
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
   * Send a request and wait for the peer's response.
   *
   * @template T
   * @param {string} channel
   * @param {*} payload
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<T>}
   */
  public async request<T = any>(
    channel: string,
    payload: any,
    timeoutMs: number = 30000
  ): Promise<T> {
    const id = this.nextId++;
    const body = await encode({ t: REQUEST, c: channel, i: id, d: payload });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${id} on ${channel} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(body);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Send a one-way message.
   *
   * @param {string} channel
   * @param {*} payload
   * @returns {Promise<void>}
   */
  public async push(channel: string, payload: any): Promise<void> {
    this.send(await encode({ t: PUSH, c: channel, d: payload }));
  }

  /**
   * Close the connection gracefully.
   */
  public close(): void {
    if (this.closed) return;
    this.closeReason ??= "closed";
    this.socket.destroySoon();
  }

  /**
   * Close the connection immediately, recording why. Used for any invalid
   * frame; callers use it for their own policy (rate limits, bans).
   *
   * @param {string} reason
   */
  public drop(reason: string): void {
    if (this.closed) return;
    this.closeReason ??= reason;
    this.session.reader.pause();
    this.socket.destroy();
  }

  private send(plaintext: Buffer): void {
    if (this.closed) throw new Error("connection is closed");
    const size = plaintext.length + TAG_BYTES;
    if (size > this.maxFrameBytes) {
      throw new Error(`frame of ${size} bytes exceeds ${this.maxFrameBytes}`);
    }
    writeFrame(this.socket, seal(this.session.sendKey, this.sendCounter++, plaintext));
  }

  private receive(frame: Buffer): void {
    const plaintext = open(this.session.receiveKey, this.receiveCounter, frame);
    if (!plaintext) return this.drop("invalid frame");
    this.receiveCounter++;
    decode(plaintext).then(
      (message) => this.dispatch(message),
      () => this.drop("invalid message")
    );
  }

  private dispatch(message: any): void {
    if (this.closed) return;
    const { t, c, i, d, e } = message;
    if (t === RESPONSE && typeof i === "number") {
      const pending = this.pending.get(i);
      if (!pending) return; // already timed out
      this.pending.delete(i);
      clearTimeout(pending.timer);
      return typeof e === "string" ? pending.reject(new Error(e)) : pending.resolve(d);
    }
    if (typeof c !== "string") return this.drop("invalid message");
    const handler = this.handlers.get(c) ?? this.fallbackHandlers?.get(c);
    if (t === PUSH) {
      if (handler) {
        Promise.resolve()
          .then(() => handler(d, this))
          .catch((error) => this.raise(error));
      }
      return;
    }
    if (t === REQUEST && typeof i === "number") {
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error(`no handler for channel ${c}`);
          return handler(d, this);
        })
        .then(
          (result) => ({ t: RESPONSE, i, d: result }),
          (error) => ({ t: RESPONSE, i, e: error?.message ?? String(error) })
        )
        .then(encode)
        .then((body) => !this.closed && this.send(body))
        .catch((error) => this.raise(error));
      return;
    }
    this.drop("invalid message");
  }

  private raise(error: Error): void {
    if (this.listenerCount("error")) this.emit("error", error);
  }

  private closedDown(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.reader.pause();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`connection closed: ${this.closeReason ?? "remote"}`));
    }
    this.pending.clear();
    this.emit("close", this.closeReason);
  }
}
