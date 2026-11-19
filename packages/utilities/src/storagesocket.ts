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

import * as net from "net";
import * as os from "os";
import * as path from "path";
import { ActiveFrame } from "./frame";

/**
 * What a socket request resolves to. `undefined` means nothing was written,
 * so the caller can use HTTP instead; `null` means it was written and then
 * the connection was lost or timed out, so the outcome is unknown and, like
 * a dead HTTP socket, it is reported as a failure and never replayed (a
 * write replayed here could be applied twice).
 */
export type StorageSocketReply = { status: number; body: Buffer } | null | undefined;

/**
 * Persistent framed connection from a node's processes to its storage
 * process. Requests carry the same method, path and JSON body as the HTTP
 * API and are answered by the same route handlers; it only removes the HTTP
 * machinery. Many requests share one connection and are matched to replies
 * by id.
 *
 * Request frame:  u32 length | u32 id | u16 header length | "METHOD /path?query" | body
 * Reply frame:    u32 length | u32 id | u16 status | body
 *
 * @export
 * @class StorageSocket
 */
export class StorageSocket {
  private static targets = new Map<string, StorageSocket>();

  /** Where the storage process listens for a given HTTP port */
  public static defaultPath(port: number | string): string {
    return path.join(os.tmpdir(), `activeledger-ds-${port}.sock`);
  }

  /** Use the socket for requests to this origin (http://127.0.0.1:5260) */
  public static register(origin: string, socketPath: string): void {
    if (!this.targets.has(origin)) {
      this.targets.set(origin, new StorageSocket(socketPath));
    }
  }

  public static unregisterAll(): void {
    for (const target of this.targets.values()) target.close();
    this.targets.clear();
  }

  public static for(origin: string): StorageSocket | undefined {
    return this.targets.size ? this.targets.get(origin) : undefined;
  }

  /** After a failed connect, use HTTP for this long before trying again */
  private static readonly RETRY_MS = 2000;

  private socket: net.Socket | null = null;
  private connecting: Promise<boolean> | null = null;
  private retryAt = 0;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: StorageSocketReply) => void; timer: NodeJS.Timeout }
  >();
  private chunks: Buffer[] = [];
  private buffered = 0;

  private constructor(private socketPath: string) {}

  public close(): void {
    this.socket?.destroy();
  }

  private connect(): Promise<boolean> {
    if (this.socket) return Promise.resolve(true);
    if (Date.now() < this.retryAt) return Promise.resolve(false);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<boolean>((resolve) => {
      const socket = net.connect(this.socketPath);
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        if (!ok) {
          this.retryAt = Date.now() + StorageSocket.RETRY_MS;
          socket.destroy();
        }
        resolve(ok);
      };
      socket.once("connect", () => {
        this.socket = socket;
        this.chunks = [];
        this.buffered = 0;
        socket.unref();
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("close", () => this.onClose(socket));
        settle(true);
      });
      socket.on("error", () => {
        // 'close' follows and fails anything in flight
        settle(false);
      });
      socket.setTimeout(1000, () => settle(false));
    });
    return this.connecting;
  }

  private onClose(socket: net.Socket): void {
    if (this.socket === socket) {
      this.socket = null;
    }
    this.retryAt = Date.now() + StorageSocket.RETRY_MS;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(null);
      this.pending.delete(id);
    }
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    let frame = ActiveFrame.read(this.chunks, this.buffered);
    while (frame) {
      const item = frame.item;
      this.chunks = frame.remaining.length ? [frame.remaining] : [];
      this.buffered = frame.remaining.length;
      const id = item.readUInt32BE(0);
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve({ status: item.readUInt16BE(4), body: item.subarray(6) });
      }
      frame = this.buffered ? ActiveFrame.read(this.chunks, this.buffered) : null;
    }
  }

  public async request(
    method: string,
    url: string,
    body: Buffer | undefined,
    timeoutMs: number
  ): Promise<StorageSocketReply> {
    if (!(await this.connect()) || !this.socket) return undefined;

    const id = this.nextId;
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    const head = Buffer.from(`${method} ${url}`);
    const bodyLength = body ? body.length : 0;
    const frame = Buffer.allocUnsafe(4 + 4 + 2 + head.length + bodyLength);
    frame.writeUInt32BE(frame.length - 4, 0);
    frame.writeUInt32BE(id, 4);
    frame.writeUInt16BE(head.length, 8);
    head.copy(frame, 10);
    if (body) body.copy(frame, 10 + head.length);

    return new Promise<StorageSocketReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.socket!.write(frame);
    });
  }
}
