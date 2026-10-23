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

import { AsyncLocalStorage } from "async_hooks";

/**
 * Egress block for contracts running on a hybrid.
 *
 * Contracts load modules with plain require() and run in this process, so
 * the block cannot rely on the contract: the network entry points of http,
 * https, net, tls, dgram and fetch are wrapped once, process wide, and throw
 * SupernodeOnly whenever they are called from inside a hybrid contract
 * execution. Everything else in the process (the hybrid's own API, feed and
 * mesh) is outside such an execution and is not affected.
 *
 * "Inside" is tracked with AsyncLocalStorage, so it follows the contract's
 * own promises and timers, and a library the contract calls that opens a
 * socket later is still caught at net.Socket.prototype.connect.
 *
 * Nothing is wrapped until the first hybrid execution, so a supernode never
 * runs through this code.
 */

export interface ISandboxContext {
  /** Called with what was blocked, before SupernodeOnly is thrown */
  onBlocked(what: string): void;
}

export class SupernodeOnlyError extends Error {
  constructor(what: string) {
    super(`${what} is only available on a supernode`);
    this.name = "SupernodeOnly";
  }
}

const context = new AsyncLocalStorage<ISandboxContext>();
let installed = false;

/**
 * Replace target[method] with a version that throws inside a hybrid execution
 */
const guard = (target: any, method: string, what: string): void => {
  const original = target?.[method];
  if (typeof original !== "function") return;
  const guarded = function (this: unknown, ...args: unknown[]) {
    const ctx = context.getStore();
    if (ctx) {
      ctx.onBlocked(what);
      throw new SupernodeOnlyError(what);
    }
    return original.apply(this, args);
  };
  target[method] = guarded;
};

/**
 * Wrap the egress entry points. Idempotent.
 */
export const installSandbox = (): void => {
  if (installed) return;
  installed = true;

  // require(), not import: the module objects themselves must be patched,
  // not an interop copy of them
  const http = require("http");
  const https = require("https");
  const net = require("net");
  const tls = require("tls");
  const dgram = require("dgram");

  guard(http, "request", "http");
  guard(http, "get", "http");
  guard(https, "request", "https");
  guard(https, "get", "https");
  guard(net, "connect", "net");
  guard(net, "createConnection", "net");
  // Catch-all for any client socket, whoever created it
  guard(net.Socket.prototype, "connect", "net");
  guard(tls, "connect", "tls");
  guard(dgram, "createSocket", "dgram");
  guard(dgram.Socket.prototype, "bind", "dgram");
  guard(dgram.Socket.prototype, "send", "dgram");
  guard(dgram.Socket.prototype, "connect", "dgram");
  guard(globalThis, "fetch", "fetch");
};

/**
 * Run fn as part of a hybrid contract execution
 */
export const runSandboxed = <T>(ctx: ISandboxContext, fn: () => T): T => {
  installSandbox();
  return context.run(ctx, fn);
};

/**
 * Run fn outside any contract execution (host work a contract triggers,
 * such as a database read)
 */
export const runUnsandboxed = <T>(fn: () => T): T => context.exit(fn);
