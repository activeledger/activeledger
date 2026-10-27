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

import * as crypto from "crypto";
import { Socket } from "net";
import { ActiveClone, ActiveFrame } from "@activeledger/activeutilities";

/**
 * Default largest frame body (after the length prefix) either side accepts.
 */
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Poly1305 tag appended to every sealed frame.
 */
export const TAG_BYTES = 16;

/**
 * Splits a byte stream into length-prefixed frames. A declared length over
 * maxFrameBytes is reported before any of the body is buffered, so a peer
 * cannot make us hold an arbitrarily large frame.
 *
 * While paused, frames stay buffered; the owner also pauses the socket so
 * TCP backpressure bounds what can pile up.
 *
 * @export
 * @class FrameReader
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private paused = false;

  constructor(
    public maxFrameBytes: number,
    public onFrame: (frame: Buffer) => void,
    public onError: (reason: string) => void
  ) {}

  public push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.drain();
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
    this.drain();
  }

  private drain(): void {
    while (!this.paused && this.buffered >= 4) {
      const head =
        this.chunks[0].length >= 4 ? this.chunks[0] : Buffer.concat(this.chunks);
      const length = head.readUInt32BE(0);
      if (length > this.maxFrameBytes) {
        this.paused = true;
        this.onError(`frame of ${length} bytes exceeds ${this.maxFrameBytes}`);
        return;
      }
      const frame = ActiveFrame.read(this.chunks, this.buffered);
      if (!frame) return;
      this.chunks = frame.remaining.length ? [frame.remaining] : [];
      this.buffered = frame.remaining.length;
      this.onFrame(frame.item);
    }
  }
}

/**
 * Write one length-prefixed frame.
 *
 * @export
 * @param {Socket} socket
 * @param {Buffer} body
 */
export function writeFrame(socket: Socket, body: Buffer): void {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

/**
 * 96 bit ChaCha20-Poly1305 nonce: 4 zero bytes then the 64 bit counter.
 * The counter is never sent; each side tracks it, so a replayed, dropped or
 * reordered frame fails authentication.
 */
function nonce(counter: bigint): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(counter, 4);
  return iv;
}

export function seal(key: Buffer, counter: bigint, plaintext: Buffer): Buffer {
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce(counter), {
    authTagLength: TAG_BYTES,
  });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Decrypt and authenticate a frame body. Returns null if it does not
 * authenticate under this key and counter.
 */
export function open(key: Buffer, counter: bigint, body: Buffer): Buffer | null {
  if (body.length < TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce(counter), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

/**
 * msgpack via ActiveClone. Compression is off: the frame cap must bound the
 * decoded size too, and gzip would let a small frame inflate without limit.
 */
export function encode(message: any): Promise<Buffer> {
  return ActiveClone.serialize(message, { enableCompression: false });
}

/**
 * Inverse of encode(). Only the uncompressed msgpack form is accepted -
 * ActiveClone.deserialize would also take gzip or V8 serialised input,
 * neither of which a peer has any business sending.
 */
export async function decode(buffer: Buffer): Promise<any> {
  if (buffer.length < 2 || buffer[0] !== 0x00) {
    throw new Error("unsupported message encoding");
  }
  const message = await ActiveClone.deserialize<any>(buffer);
  if (!message || typeof message !== "object") {
    throw new Error("message is not an object");
  }
  return message;
}
