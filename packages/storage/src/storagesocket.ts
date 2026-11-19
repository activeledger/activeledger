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
import * as net from "net";
import { ActiveFrame } from "@activeledger/activeutilities";
import { ActiveHttpd } from "@activeledger/httpd";

/**
 * Serves the storage routes on a local unix socket, for the node's own
 * processes. Frames are described in StorageSocket (activeutilities). Each
 * request runs through the same handlers as HTTP, concurrently, and is
 * answered by id as it finishes.
 *
 * The socket file is mode 0600, so only the node's user can connect, which
 * is no wider than the loopback port it sits beside.
 */
export function serveStorageSocket(http: ActiveHttpd, socketPath: string): net.Server {
  // A stale file from a killed process would refuse the bind
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // not there
  }

  const server = net.createServer((socket) => {
    let chunks: Buffer[] = [];
    let buffered = 0;

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      buffered += chunk.length;
      let frame = ActiveFrame.read(chunks, buffered);
      while (frame) {
        const item = frame.item;
        chunks = frame.remaining.length ? [frame.remaining] : [];
        buffered = frame.remaining.length;
        handle(socket, item);
        frame = buffered ? ActiveFrame.read(chunks, buffered) : null;
      }
    });
    socket.on("error", () => {
      // The client went away mid frame; nothing to answer
    });
  });

  const handle = async (socket: net.Socket, item: Buffer) => {
    const id = item.readUInt32BE(0);
    const headLength = item.readUInt16BE(4);
    const head = item.subarray(6, 6 + headLength).toString();
    const space = head.indexOf(" ");
    const body = item.subarray(6 + headLength);

    const reply = await http.invoke(
      head.slice(0, space),
      head.slice(space + 1),
      body.length ? body : undefined
    );
    if (socket.destroyed) return;
    const payload = Buffer.from(reply.body);
    const out = Buffer.allocUnsafe(4 + 4 + 2 + payload.length);
    out.writeUInt32BE(out.length - 4, 0);
    out.writeUInt32BE(id, 4);
    out.writeUInt16BE(reply.status, 8);
    payload.copy(out, 10);
    socket.write(out);
  };

  // The socket is an extra route to the same store. If it cannot be bound
  // (a path another user owns, a read only temp folder) the store carries on
  // over HTTP, which is what every client falls back to.
  server.on("error", (error: Error) => {
    console.error("Storage socket unavailable, using HTTP only: " + error.message);
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // best effort
    }
  });
  return server;
}
