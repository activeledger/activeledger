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

/*
 * Handshake (client = the side that dialled):
 *
 *   C -> S  hello  { v, eph: C_eph }
 *   S -> C  server { v, eph: S_eph, type: S_type, key: S_key, sig: S_sig }
 *              th  = H(PROTOCOL, C_eph, S_eph, S_type, S_key)
 *              S_sig over "PROTOCOL server <th>"
 *   C -> S  client { type: C_type, key: C_key, sig: C_sig }
 *              th2 = H(th, C_type, C_key)
 *              C_sig over "PROTOCOL client <th2>"
 *   S -> C  ready  sealed(s2c, 0, PROTOCOL)
 *
 * Both ephemeral keys and both identities are under a signature, so a
 * signature cannot be replayed into another session and neither identity
 * can be swapped. Session keys come from HKDF(X25519(C_eph, S_eph), th2).
 * The sealed "ready" frame confirms the keys and tells the client that the
 * server accepted it, so connect() fails rather than handing back a
 * connection the server is about to close.
 */

import * as crypto from "crypto";
import { Socket } from "net";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { FrameReader, writeFrame, encode, decode, seal, open } from "./frame";

const PROTOCOL = "activep2p/1";
const VERSION = 1;

/**
 * Handshake messages are small: the largest are post-quantum keys and
 * signatures (ML-DSA-65 is ~2.6KB + ~4.4KB in base64).
 */
const HANDSHAKE_MAX_BYTES = 64 * 1024;

/**
 * A node's long-term identity, in any form ActiveCrypto.KeyPair accepts.
 *
 * @export
 * @interface P2PIdentity
 */
export interface P2PIdentity {
  type: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Decides whether an authenticated peer key may connect.
 */
export type KnownPeerCheck = (
  publicKey: string,
  type: string
) => boolean | Promise<boolean>;

export interface HandshakeOptions {
  identity: P2PIdentity;
  timeoutMs: number;
  isKnownPeer?: KnownPeerCheck;
  expectedPeerKey?: string;
}

export interface Session {
  reader: FrameReader;
  peerKey: string;
  peerKeyType: string;
  sendKey: Buffer;
  receiveKey: Buffer;
  sendCounter: bigint;
  receiveCounter: bigint;
}

/**
 * Hash of length-prefixed parts, so no two different part lists collide.
 */
function transcript(...parts: (Buffer | string)[]): Buffer {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    hash.update(length).update(bytes);
  }
  return hash.digest();
}

function ephemeral(): { privateKey: crypto.KeyObject; raw: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    privateKey,
    raw: Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"),
  };
}

function sharedSecret(privateKey: crypto.KeyObject, peer: Buffer): Buffer {
  const publicKey = crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: peer.toString("base64url") },
    format: "jwk",
  });
  return crypto.diffieHellman({ privateKey, publicKey });
}

function sessionKeys(shared: Buffer, th2: Buffer): { c2s: Buffer; s2c: Buffer } {
  const derive = (info: string) =>
    Buffer.from(crypto.hkdfSync("sha256", shared, th2, `${PROTOCOL} ${info}`, 32));
  return { c2s: derive("c2s"), s2c: derive("s2c") };
}

function sign(identity: P2PIdentity, role: string, hash: Buffer): string {
  return new ActiveCrypto.KeyPair(identity.type, identity.privateKey).sign(
    `${PROTOCOL} ${role} ${hash.toString("hex")}`
  );
}

/**
 * Never throws: an unparseable key, a private key passed as a public one or
 * a malformed signature all mean the same thing - not verified.
 */
function verify(type: string, key: string, role: string, hash: Buffer, sig: string): boolean {
  try {
    return new ActiveCrypto.KeyPair(type, key).verify(
      `${PROTOCOL} ${role} ${hash.toString("hex")}`,
      sig
    );
  } catch {
    return false;
  }
}

function bytes(value: unknown, length: number, name: string): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`invalid ${name}`);
  }
  return Buffer.from(value);
}

function strings(message: any, ...fields: string[]): void {
  for (const field of fields) {
    if (typeof message[field] !== "string" || !message[field]) {
      throw new Error(`invalid handshake field ${field}`);
    }
  }
}

/**
 * Run the handshake on a freshly connected socket. On any failure the
 * socket is destroyed and the promise rejects.
 *
 * @export
 * @param {Socket} socket
 * @param {("client" | "server")} role
 * @param {HandshakeOptions} options
 * @returns {Promise<Session>}
 */
export function handshake(
  socket: Socket,
  role: "client" | "server",
  options: HandshakeOptions
): Promise<Session> {
  return new Promise((resolve, reject) => {
    let done = false;
    let waiting: ((frame: Buffer) => void) | undefined;

    const finish = () => {
      done = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const fail = (reason: string) => {
      if (done) return;
      finish();
      reader.pause();
      socket.destroy();
      reject(new Error(reason));
    };
    const onClose = () => fail("connection closed during handshake");
    const onError = (error: Error) => fail(error.message);
    const timer = setTimeout(() => fail("handshake timed out"), options.timeoutMs);

    // One frame at a time: pause after each so nothing that arrives early
    // (such as the first sealed frame) is handled before the session exists.
    const reader = new FrameReader(
      HANDSHAKE_MAX_BYTES,
      (frame) => {
        reader.pause();
        socket.pause();
        const deliver = waiting;
        waiting = undefined;
        deliver ? deliver(frame) : fail("unexpected handshake frame");
      },
      fail
    );
    const next = (): Promise<Buffer> =>
      new Promise((got) => {
        waiting = got;
        reader.resume();
        socket.resume();
      });
    const send = async (message: any) => writeFrame(socket, await encode(message));

    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.once("close", onClose);
    socket.on("error", onError);

    const run = role === "client" ? client : server;
    run(options, next, send, (body) => writeFrame(socket, body)).then(
      (session) => {
        if (done) return;
        finish();
        resolve({ ...session, reader });
      },
      (error: Error) => fail(error.message)
    );
  });
}

type Next = () => Promise<Buffer>;
type Send = (message: any) => Promise<void>;
type Raw = (body: Buffer) => void;
type Keys = Omit<Session, "reader">;

async function client(options: HandshakeOptions, next: Next, send: Send): Promise<Keys> {
  const { identity } = options;
  const eph = ephemeral();
  await send({ v: VERSION, eph: eph.raw });

  const reply = await decode(await next());
  if (reply.v !== VERSION) throw new Error("unsupported protocol version");
  strings(reply, "type", "key", "sig");
  const serverEph = bytes(reply.eph, 32, "ephemeral key");
  if (options.expectedPeerKey && reply.key !== options.expectedPeerKey) {
    throw new Error("peer key does not match expected key");
  }
  const th = transcript(PROTOCOL, eph.raw, serverEph, reply.type, reply.key);
  if (!verify(reply.type, reply.key, "server", th, reply.sig)) {
    throw new Error("invalid peer signature");
  }
  if (options.isKnownPeer && !(await options.isKnownPeer(reply.key, reply.type))) {
    throw new Error("unknown peer");
  }

  const th2 = transcript(th, identity.type, identity.publicKey);
  const keys = sessionKeys(sharedSecret(eph.privateKey, serverEph), th2);
  await send({ type: identity.type, key: identity.publicKey, sig: sign(identity, "client", th2) });

  const ready = open(keys.s2c, 0n, await next());
  if (!ready || ready.toString() !== PROTOCOL) throw new Error("invalid ready frame");

  return {
    peerKey: reply.key,
    peerKeyType: reply.type,
    sendKey: keys.c2s,
    receiveKey: keys.s2c,
    sendCounter: 0n,
    receiveCounter: 1n,
  };
}

async function server(
  options: HandshakeOptions,
  next: Next,
  send: Send,
  raw: Raw
): Promise<Keys> {
  const { identity } = options;
  const hello = await decode(await next());
  if (hello.v !== VERSION) throw new Error("unsupported protocol version");
  const clientEph = bytes(hello.eph, 32, "ephemeral key");

  const eph = ephemeral();
  const th = transcript(PROTOCOL, clientEph, eph.raw, identity.type, identity.publicKey);
  await send({
    v: VERSION,
    eph: eph.raw,
    type: identity.type,
    key: identity.publicKey,
    sig: sign(identity, "server", th),
  });

  const auth = await decode(await next());
  strings(auth, "type", "key", "sig");
  const th2 = transcript(th, auth.type, auth.key);
  if (!verify(auth.type, auth.key, "client", th2, auth.sig)) {
    throw new Error("invalid peer signature");
  }
  if (options.isKnownPeer && !(await options.isKnownPeer(auth.key, auth.type))) {
    throw new Error("unknown peer");
  }

  const keys = sessionKeys(sharedSecret(eph.privateKey, clientEph), th2);
  raw(seal(keys.s2c, 0n, Buffer.from(PROTOCOL)));

  return {
    peerKey: auth.key,
    peerKeyType: auth.type,
    sendKey: keys.s2c,
    receiveKey: keys.c2s,
    sendCounter: 1n,
    receiveCounter: 0n,
  };
}
