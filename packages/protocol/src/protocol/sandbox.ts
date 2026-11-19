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
import { ContractScope, StorageAccessError, IContractDestination } from "@activeledger/activeutilities";

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
 * A supernode's contracts run in a narrower mode (`storage`): everything stays
 * open except the node's own storage, which a contract must not reach. The
 * storage has no login, so a contract that connected to its port could read or
 * write any document, including another namespace's volatile data. That mode
 * blocks a connection to a port registered with ContractScope.protectPorts()
 * (whatever host name is used) and any unix socket, and leaves other network
 * use alone. ActiveRequest, which is the contract's HTTP toolkit and the
 * engine's own storage client, makes the same check itself.
 *
 * Nothing is wrapped until the first contract execution.
 */

export interface ISandboxContext {
  /** Called with what was blocked, before it is refused */
  onBlocked(what: string): void;
  /** "all" (default): block every network entry point. "storage": block only the node's storage */
  mode?: "all" | "storage";
  /** In "storage" mode: whether this contract's namespace may reach a destination the storage guard would refuse */
  allow?(destination: IContractDestination): boolean;
  /** In "storage" mode: custom databases are open without a list */
  customDatabases?: boolean;
}

/** Where an outgoing connection is headed: a host and port (and the path of an HTTP request), or a unix socket */
interface IDestination {
  host?: string;
  port?: number | string;
  path?: string;
  socket?: string;
  method?: string;
  body?: unknown;
}

export class SupernodeOnlyError extends Error {
  constructor(what: string) {
    super(`${what} is only available on a supernode`);
    this.name = "SupernodeOnly";
  }
}

// One store for the process, shared (by symbol) with ActiveRequest
const SCOPE = Symbol.for("activeledger.contractScope");
const context: AsyncLocalStorage<ISandboxContext> = ((globalThis as any)[SCOPE] ||=
  new AsyncLocalStorage<ISandboxContext>());
let installed = false;

/** Host, port and path of a URL-like thing, with the scheme's default port */
const urlDestination = (value: unknown, fallback: number): IDestination => {
  try {
    const url = value instanceof URL ? value : new URL(String((value as any)?.url ?? value));
    return { host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : fallback), path: url.pathname + url.search };
  } catch {
    return {};
  }
};

/** http.request(url | options, options?, cb?) and http.get */
const requestDestination = (defaultPort: number) => (args: unknown[]): IDestination => {
  const dest: IDestination = {};
  for (const arg of args) {
    if (typeof arg === "string" || arg instanceof URL) Object.assign(dest, urlDestination(arg, defaultPort));
    else if (arg && typeof arg === "object") {
      const options: any = arg;
      if (options.socketPath) dest.socket = String(options.socketPath);
      if (options.hostname || options.host) dest.host = String(options.hostname || options.host);
      if (options.port !== undefined) dest.port = options.port;
      else if (options.defaultPort !== undefined && dest.port === undefined) dest.port = options.defaultPort;
      if (typeof options.path === "string") dest.path = options.path;
      if (typeof options.method === "string") dest.method = options.method;
    }
  }
  if (dest.port === undefined && !dest.socket) dest.port = defaultPort;
  return dest;
};

/** net.connect / tls.connect / Socket.prototype.connect: (options) | (port, host) | (path) */
const connectDestination = (args: unknown[]): IDestination => {
  const first = args[0];
  if (first && typeof first === "object") {
    const options: any = first;
    return { host: options.host, port: options.port, socket: options.path };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first)))
    return { port: first as any, host: typeof args[1] === "string" ? (args[1] as string) : undefined };
  if (typeof first === "string") return { socket: first };
  return {};
};

/** fetch(url | Request) */
const fetchDestination = (args: unknown[]): IDestination => {
  const dest = urlDestination(args[0], 80);
  const init: any = args[1] && typeof args[1] === "object" ? args[1] : (args[0] as any);
  if (init && typeof init.method === "string") dest.method = init.method;
  if (init && typeof init.body === "string") dest.body = init.body;
  else if (init && init.body !== undefined && init.body !== null) dest.body = undefined, (dest as any).opaqueBody = true;
  return dest;
};

/**
 * Replace target[method] with a version that throws inside a contract
 * execution: always in "all" mode, and in "storage" mode only for a
 * destination that is the node's storage.
 */
/**
 * Arguments whose values could change between the guard reading them and the
 * real call reading them again: a top-level object that is not a plain object
 * or a URL (a Request, a class instance with getters), or one with accessor
 * properties. Contracts do not need them; they are refused.
 */
const suspicious = (args: unknown[]): boolean =>
  args.some((arg) => {
    if (!arg || typeof arg !== "object" || arg instanceof URL || Array.isArray(arg) || ArrayBuffer.isView(arg)) return false;
    const proto = Object.getPrototypeOf(arg);
    if (proto !== Object.prototype && proto !== null) return true;
    return Object.values(Object.getOwnPropertyDescriptors(arg)).some((d: any) => d.get || d.set);
  });

const guard = (
  target: any,
  method: string,
  what: string,
  destination?: (args: unknown[]) => IDestination
): void => {
  const original = target?.[method];
  if (typeof original !== "function") return;
  const guarded = function (this: unknown, ...args: unknown[]) {
    const ctx = context.getStore();
    if (ctx) {
      if (ctx.mode === "storage") {
        if (destination && suspicious(args)) {
          ctx.onBlocked(`storage:${what}`);
          throw new StorageAccessError(`${what} with arguments that could change after they are checked`);
        }
        const dest = destination ? destination(args) : undefined;
        if (dest) {
          // A unix socket is never a contract's business
          if (dest.socket) {
            ctx.onBlocked(`storage:${what}`);
            throw new StorageAccessError(`${what} to a unix socket`);
          }
          // A port is refused only if it is the storage's and this namespace is not allowed it
          if (dest.port !== undefined) {
            // A method that carries a body is only approved if the body can be read: a raw
            // request is written to afterwards, and a fetch body may be a stream
            const bodyless = !dest.method || /^(GET|HEAD|DELETE|OPTIONS)$/i.test(dest.method);
            const unseen = !bodyless && dest.body === undefined;
            const approve = ContractScope.enforce(ctx, { host: dest.host, port: Number(dest.port), path: dest.path, body: dest.body, method: dest.method, unseenBody: unseen });
            // An approved request carries that approval to the connection it opens
            if (approve) return approve(() => original.apply(this, args));
          }
        }
      } else {
        ctx.onBlocked(what);
        throw new SupernodeOnlyError(what);
      }
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

  guard(http, "request", "http", requestDestination(80));
  guard(http, "get", "http", requestDestination(80));
  guard(https, "request", "https", requestDestination(443));
  guard(https, "get", "https", requestDestination(443));
  guard(net, "connect", "net", connectDestination);
  guard(net, "createConnection", "net", connectDestination);
  // Catch-all for any client socket, whoever created it
  guard(net.Socket.prototype, "connect", "net", connectDestination);
  guard(tls, "connect", "tls", connectDestination);
  guard(dgram, "createSocket", "dgram");
  guard(dgram.Socket.prototype, "bind", "dgram");
  guard(dgram.Socket.prototype, "send", "dgram");
  guard(dgram.Socket.prototype, "connect", "dgram");
  guard(globalThis, "fetch", "fetch", fetchDestination);
};

/**
 * Run fn as part of a hybrid contract execution
 */
export const runSandboxed = <T>(ctx: ISandboxContext, fn: () => T): T => {
  installSandbox();
  // Frozen: the context is handed to code that must not be able to change it
  return context.run(Object.freeze({ ...ctx }), fn);
};

/**
 * Run fn outside any contract execution (host work a contract triggers,
 * such as a database read)
 */
export const runUnsandboxed = <T>(fn: () => T): T => context.exit(fn);
