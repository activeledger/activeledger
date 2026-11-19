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
  /** In "storage" mode: custom databases this namespace may use by name */
  databases?: string[];
  /** In "storage" mode: this machine's other ports are closed unless `allow` lists them */
  denyLocalhost?: boolean;
  limits?: { timeoutSeconds: number; maxResponseBytes: number };
  spent?: { bytes: number };
  inflight?: Set<() => void>;
  ended?: { value: boolean };
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
 * What a contract may pass to http, net, tls or fetch for them to be looked at:
 * strings, URLs, callbacks, and plain objects holding only the keys below with
 * plain values. The guard copies the arguments into fresh objects ONCE and both
 * checks and uses the copy, so nothing the contract controls (a getter, a Proxy, a
 * class, an agent, a custom connection, a dispatcher, a lookup) is read twice or
 * reaches the real call. Anything else is refused.
 */
const PLAIN_KEYS = new Set([
  "host", "hostname", "port", "path", "method", "headers", "protocol", "family", "timeout", "servername",
  "body", "redirect", "cache", "credentials", "mode", "referrer", "referrerPolicy", "integrity", "keepalive", "auth", "setHost",
]);
const isPlain = (v: unknown) => v === null || ["string", "number", "boolean", "undefined"].includes(typeof v);
const snapshotArgs = (args: unknown[]): unknown[] =>
  args.map((arg) => {
    if (arg === null || arg === undefined || typeof arg === "string" || typeof arg === "number" || typeof arg === "boolean" || typeof arg === "function") return arg;
    if (arg instanceof URL) return new URL(arg.href);
    if (!arg || typeof arg !== "object" || require("util").types.isProxy(arg)) throw new StorageAccessError("An argument that is not plain data");
    if (Array.isArray(arg) || ArrayBuffer.isView(arg)) throw new StorageAccessError("An argument that is not plain data");
    const proto = Object.getPrototypeOf(arg);
    if (proto !== Object.prototype && proto !== null) throw new StorageAccessError("An argument that is not plain data");
    const copy: any = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(arg)) as Array<[string, any]>) {
      if (descriptor.get || descriptor.set || !PLAIN_KEYS.has(key)) throw new StorageAccessError(`The option ${key}`);
      const value = descriptor.value;
      if (key === "headers" && value && typeof value === "object" && !Array.isArray(value) && !require("util").types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype) {
        const headers: any = {};
        for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(value)) as Array<[string, any]>) {
          if (d.get || d.set) throw new StorageAccessError("A header that is not plain data");
          headers[name] = Array.isArray(d.value) ? d.value.map(String) : String(d.value);
        }
        copy.headers = headers;
      } else if (isPlain(value)) {
        copy[key] = value;
      } else {
        throw new StorageAccessError(`The option ${key}`);
      }
    }
    return copy;
  });

/**
 * For net and tls, whose own code passes normalised argument arrays between its
 * methods: no copying, but nothing a contract could change between reads (a
 * Proxy, a getter, a class instance) is accepted.
 */
// Options that change how a connection is made (resolver, socket, agent): never a contract's to set
const REFUSED_OPTIONS = new Set(["lookup", "createConnection", "agent", "socket", "socketPath", "fd", "handle", "dispatcher", "setHost", "secureContext", "checkServerIdentity"]);

const lightCheck = (args: unknown[]): void => {
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || value instanceof URL) return;
    if (require("util").types.isProxy(value) || depth > 2) throw new StorageAccessError("An argument that is not plain data");
    if (Array.isArray(value)) { value.forEach((v) => visit(v, depth + 1)); return; }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new StorageAccessError("An argument that is not plain data");
    // Every own property, hidden ones and symbols too: net and tls read options by name
    for (const key of Reflect.ownKeys(value)) {
      const d: any = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key === "symbol" || !d.enumerable || d.get || d.set) throw new StorageAccessError("An option that is not plain data");
      if (REFUSED_OPTIONS.has(key)) throw new StorageAccessError(`The option '${key}'`);
    }
  };
  args.forEach((a) => visit(a, 0));
};

const guard = (
  target: any,
  method: string,
  what: string,
  destination?: (args: unknown[]) => IDestination,
  // net.connect and the like end in Socket.prototype.connect: the approval is spent there
  peek = false
): void => {
  const original = target?.[method];
  if (typeof original !== "function") return;
  const guarded = function (this: unknown, ...args: unknown[]) {
    const ctx = context.getStore();
    let safe: unknown[] = args;
    if (ctx) {
      if (ctx.mode === "storage") {
        if (destination) {
          try {
            if (what === "http" || what === "https" || what === "fetch") safe = snapshotArgs(args);
            else lightCheck(args);
          } catch (error) {
            ctx.onBlocked(`storage:${what}`);
            throw error;
          }
        }
        const dest = destination ? destination(safe) : undefined;
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
            const approve = ContractScope.enforce(ctx, { host: dest.host, port: Number(dest.port), path: dest.path, body: dest.body, method: dest.method, unseenBody: unseen }, peek);
            // An approved request carries that approval to the connection it opens
            if (approve) return approve(() => original.apply(this, safe));
          }
        }
      } else {
        ctx.onBlocked(what);
        throw new SupernodeOnlyError(what);
      }
    }
    return original.apply(this, safe);
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
  guard(net, "connect", "net", connectDestination, true);
  guard(net, "createConnection", "net", connectDestination, true);
  // Catch-all for any client socket, whoever created it
  guard(net.Socket.prototype, "connect", "net", connectDestination);
  guard(tls, "connect", "tls", connectDestination, true);
  guard(dgram, "createSocket", "dgram");
  guard(dgram.Socket.prototype, "bind", "dgram");
  guard(dgram.Socket.prototype, "send", "dgram");
  guard(dgram.Socket.prototype, "connect", "dgram");
  guard(globalThis, "fetch", "fetch", fetchDestination);
};

/** A value that is awaitable but not by this realm's own machinery: its then is the contract's code */
const normalise = (value: any): any =>
  value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function"
    ? new Promise((resolve) => resolve(value))
    : value;

/** A thrown object that is not an Error is copied to plain data (its toString and getters are not ours to run) */
const plainThrown = (error: unknown): unknown => {
  if (!error || typeof error !== "object" || error instanceof Error) return error;
  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return new Error("Contract threw a value that is not data");
  }
};

/**
 * Bind a callback to the contract context it was made in, so that when the host calls it
 * later (an event from host work done outside the sandbox) it still runs inside it.
 */
export const bindToContext = <F extends (...args: any[]) => any>(fn: F): F => {
  const ctx = context.getStore();
  if (!ctx) return fn;
  return ((...args: any[]) => context.run(ctx, () => fn(...args))) as F;
};

/**
 * Run fn as part of a hybrid contract execution
 */
export const runSandboxed = <T>(ctx: ISandboxContext, fn: () => T): T => {
  installSandbox();
  // Frozen: the context is handed to code that must not be able to change it
  // When the call ends, whatever requests it started are cancelled: nothing a
  // contract began may land after its transaction has moved on
  const end = () => {
    if (ctx.ended) ctx.ended.value = true;
    ctx.inflight?.forEach((abort) => { try { abort(); } catch { /* already done */ } });
  };
  let result: any;
  try {
    result = context.run(Object.freeze({ ...ctx }), () => {
      // Whatever the contract hands back is made plain here, inside its sandbox: a thenable's
      // then, a getter or a thrown object's toString would otherwise run when the host
      // later awaits, reads or logs it, outside the sandbox
      try {
        return normalise(fn());
      } catch (error) {
        throw plainThrown(error);
      }
    });
  } catch (error) {
    end();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value: unknown) => { end(); return value; },
      (error: unknown) => { end(); throw error; }
    ) as T;
  }
  end();
  return result;
};

/**
 * Run fn outside any contract execution (host work a contract triggers,
 * such as a database read)
 */
export const runUnsandboxed = <T>(fn: () => T): T => context.exit(fn);
