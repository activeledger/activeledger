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

/**
 * Coalesces parent<->child IPC messages sent within the same event loop turn
 * into a single child.send / process.send.
 *
 * Internal protocol only: both ends run the same node version, nothing in this
 * file reaches another node.
 *
 * Messages are serialised when queued, not when flushed. child.send used to
 * snapshot the message synchronously and callers (e.g. the host's live pending
 * entry) keep mutating their objects afterwards, so deferring serialisation
 * would change what the worker receives. A flush therefore sends one string,
 * a JSON array of the already serialised messages, which the receiver unwraps
 * in order with unbatch(). Plain object messages are still accepted by
 * unbatch() so either end can be talked to by an unbatched sender.
 */

/** Anything with the child_process / process IPC send signature */
export interface IpcChannel {
  send(message: any, callback?: (error: Error | null) => void): any;
  connected?: boolean;
}

/** Flush early once this many messages are queued */
export const BATCH_MAX = 64;

interface Queued {
  json: string;
  cb?: (error: Error | null) => void;
}

export class IpcBatcher {
  private queue: Queued[] = [];
  private scheduled = false;
  private closed = false;

  constructor(private channel: IpcChannel, private max = BATCH_MAX) {}

  /** Number of messages waiting for the next flush */
  public get pending(): number {
    return this.queue.length;
  }

  /**
   * Queue a message for this tick's flush. Order is the order of calls. A
   * message that cannot be serialised throws here, to the caller, as
   * child.send would have.
   */
  public send(msg: any, cb?: (error: Error | null) => void): void {
    if (this.closed) {
      if (cb) cb(new Error("IPC channel closed"));
      return;
    }
    this.queue.push({ json: JSON.stringify(msg), cb });
    if (this.queue.length >= this.max) {
      this.flush();
    } else if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
  }

  /**
   * Send everything queued now as one IPC message.
   */
  public flush(): void {
    this.scheduled = false;
    if (!this.queue.length) return;
    const items = this.queue;
    this.queue = [];

    const done = (error: Error | null) => {
      for (const item of items) item.cb?.(error);
    };
    let payload = "[" + items[0].json;
    for (let i = 1; i < items.length; i++) payload += "," + items[i].json;
    payload += "]";

    try {
      if (this.channel.connected === false) {
        throw new Error("IPC channel closed");
      }
      this.channel.send(payload, done);
    } catch (e) {
      // Channel gone: reject every queued message rather than drop silently
      done(e as Error);
    }
  }

  /**
   * Channel is going away. Flush if still connected, otherwise reject the
   * queue, then refuse further messages.
   */
  public close(): void {
    this.flush();
    this.closed = true;
  }
}

/**
 * Call handler once per message, in order, unwrapping a batch string.
 */
export function unbatch(m: any, handler: (m: any) => void): void {
  if (typeof m !== "string") {
    handler(m);
    return;
  }
  for (const inner of JSON.parse(m)) {
    try {
      handler(inner);
    } catch (e) {
      // Keep the remaining messages: as separate IPC messages one throwing
      // would not have stopped the next. Surface it as uncaught as before.
      setImmediate(() => {
        throw e;
      });
    }
  }
}

/**
 * Send via the channel's batcher when it has one, else straight through.
 */
export function ipcSend(
  channel: IpcChannel,
  msg: any,
  cb?: (error: Error | null) => void
): void {
  const batcher: IpcBatcher | undefined = (channel as any).batcher;
  if (batcher) batcher.send(msg, cb);
  else channel.send(msg, cb);
}
