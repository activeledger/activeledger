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
import * as path from "path";
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
  // The socket lives in a folder only this user can write to, which is what
  // keeps another local user from binding the path first (or swapping it) and
  // receiving the node's storage traffic. A folder that is not ours, or that
  // anyone else can write to, means no socket: the store carries on over HTTP
  // and clients, which check the same thing, never connect.
  const dir = path.dirname(socketPath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(dir);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
      throw new Error(dir + " is not a private folder of this user");
    }
    // A stale socket from a killed process would refuse the bind. Only ours.
    try {
      const old = fs.lstatSync(socketPath);
      if (old.isSocket() && old.uid === uid) fs.unlinkSync(socketPath);
    } catch {
      // not there
    }
  } catch (error: any) {
    console.error("Storage socket unavailable, using HTTP only: " + error.message);
    return net.createServer();
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
        // A bad frame must not end the storage process: drop that client
        handle(socket, item).catch(() => socket.destroy());
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

    // Take the file with us when the process ends. Only the one this process
    // made: a storage process started in its place may already have bound the
    // same path, and that one is not ours to remove.
    let made = -1;
    try {
      made = fs.lstatSync(socketPath).ino;
    } catch {
      return;
    }
    const remove = () => {
      try {
        const now = fs.lstatSync(socketPath);
        if (now.isSocket() && now.ino === made) fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
    };
    process.once("exit", remove);
    server.once("close", () => process.removeListener("exit", remove));
  });
  return server;
}
