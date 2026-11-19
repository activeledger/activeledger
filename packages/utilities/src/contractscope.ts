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
 * Keeps contract code away from the node's own storage.
 *
 * A contract's HTTP toolkit is ActiveRequest, the same client the engine uses
 * to talk to storage, so without this a contract can read or write any
 * document (another namespace's volatile data, say) by naming the storage
 * port. The storage has no login of its own.
 *
 * Two pieces of shared state, both on globalThis under registered symbols so
 * the protocol package (which knows when a contract is running) and this one
 * (which sends the request) agree without importing each other:
 *   - the AsyncLocalStorage that holds the running contract's context, set by
 *     the protocol package for the length of a contract call. It follows the
 *     contract's own promises and timers; host work a contract triggers
 *     (a database read for getVolatile) runs outside it.
 *   - the ports that belong to the storage.
 *
 * The check is by port, whatever the host is called: a name that resolves to
 * this machine is still that port.
 */
const SCOPE = Symbol.for("activeledger.contractScope");
const PORTS = Symbol.for("activeledger.protectedPorts");
const NEVER = Symbol.for("activeledger.neverDatabases");

/** Where a contract's request is going */
export interface IContractDestination {
  host?: string;
  port: number;
  /** The request path and query, for an HTTP request. Absent for a bare socket */
  path?: string;
  /** The request body, when the sender has it (ActiveRequest, a fetch with a string body) */
  body?: unknown;
  /** The HTTP method, when the sender has it */
  method?: string;
  /** A method that can carry a body whose content the sender cannot show (a raw http request): never approved */
  unseenBody?: boolean;
}

export interface IContractScope {
  /** Called with what was blocked, before the request is refused */
  onBlocked?(what: string): void;
  /** Whether this contract's namespace has been allowed to reach the destination */
  allow?(destination: IContractDestination): boolean;
  /** Custom databases (a name starting activeledger with more after it) are open to contracts without a list */
  customDatabases?: boolean;
  /**
   * A request already approved at a higher level (it was checked with its path):
   * the connection that carries it is not a bare socket to be judged again.
   */
  approved?: { host?: string; port: number; expires: number; used: boolean };
}

export class StorageAccessError extends Error {
  constructor(what: string) {
    super(`${what} is not available to contracts`);
    this.name = "StorageAccessError";
  }
}

export class ContractScope {
  /** Ports that contract code must not connect to */
  public static protectPorts(ports: Array<number | string | undefined>): void {
    const g: any = globalThis;
    const set: Set<number> = (g[PORTS] ||= new Set<number>());
    for (const port of ports) {
      const n = Number(port);
      if (Number.isInteger(n) && n > 0) set.add(n);
    }
  }

  public static isProtected(port: number | string | undefined): boolean {
    const set: Set<number> | undefined = (globalThis as any)[PORTS];
    return !!set && set.size > 0 && set.has(Number(port));
  }

  /** The running contract's context, or undefined outside a contract */
  public static current(): IContractScope | undefined {
    return (globalThis as any)[SCOPE]?.getStore();
  }

  /**
   * Refuses a request to a protected port made from inside a contract, unless
   * the contract's namespace has been allowed that destination. When it is
   * allowed, returns a function that runs the request so the connection it
   * opens is known to be approved; otherwise there is nothing to wrap
   * (outside a contract, or not the storage's port) and it returns undefined.
   *
   * @param {string | URL} target A URL, or a port number
   */
  public static check(
    target: string | URL | number | undefined,
    body?: unknown,
    method?: string
  ): (<T>(run: () => T) => T) | undefined {
    const scope = ContractScope.current();
    if (!scope) return undefined;
    let destination: IContractDestination;
    if (typeof target === "number") destination = { port: target };
    else {
      try {
        const url = target instanceof URL ? target : new URL(String(target));
        destination = {
          host: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          path: url.pathname + url.search,
          body,
          method,
        };
      } catch {
        return undefined;
      }
    }
    return ContractScope.enforce(scope, destination);
  }

  /**
   * Databases no contract may touch whatever it has been allowed: the node's
   * own (ledger, events, errors and the error archive). Compared without regard
   * to case.
   */
  public static neverDatabases(names: Array<string | undefined>): void {
    (globalThis as any)[NEVER] = new Set(
      names.filter((n): n is string => typeof n === "string" && !!n).map((n) => n.toLowerCase())
    );
  }

  /**
   * Whether some text says "volatile", however it is written: any case, and
   * percent-escaped or \u-escaped (once, twice, or more). A request that
   * mentions it is aimed at the node's private data and is never allowed.
   */
  public static mentionsVolatile(text: string): boolean {
    let current = String(text);
    for (let round = 0; round < 8; round++) {
      if (/volatile/i.test(current)) return true;
      let next: string;
      try {
        next = decodeURIComponent(current);
      } catch {
        next = current.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      next = next.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (next === current) break;
      current = next;
    }
    return /volatile/i.test(current);
  }

  /**
   * mentionsVolatile, also against the text with the characters the storage
   * drops or ignores taken out (it deletes quotes from startkey and endkey, so
   * vo"latile reaches it as volatile), and spaces, separators and zero-width marks.
   */
  public static mentionsVolatileSquashed(text: string): boolean {
    if (ContractScope.mentionsVolatile(text)) return true;
    let decoded = String(text);
    for (let round = 0; round < 8; round++) {
      let next: string;
      try { next = decodeURIComponent(decoded); } catch { next = decoded; }
      next = next.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (next === decoded) break;
      decoded = next;
    }
    return /volatile/i.test(decoded.replace(/[\s"'`\\+._\-\u200b-\u200f\u2060\ufeff]/g, ""));
  }

  /**
   * Whether a request is out of bounds for any contract: it mentions volatile
   * anywhere in its path, query or body (the node's private data, in any
   * database), or it is in one of the node's own databases (ledger, events,
   * errors and the error archive).
   */
  public static forbidden(path: string, body?: unknown, method?: string): boolean {
    if (ContractScope.mentionsVolatileSquashed(path)) return true;
    if (body !== undefined && body !== null) {
      let text: string;
      try {
        text = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : JSON.stringify(body);
      } catch {
        return true;
      }
      if (ContractScope.mentionsVolatileSquashed(text ?? "")) return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(ContractScope.normalPath(path));
    } catch {
      return true;
    }
    const parts = decoded.split("/").filter(Boolean);
    const first = parts[0]?.toLowerCase();
    const never: Set<string> | undefined = (globalThis as any)[NEVER];
    if (first && never && never.has(first)) return true;
    // _all_dbs, _explorer, _utils: the storage's own pages and listings
    if (first && first.startsWith("_")) return true;
    // The storage's own routes (backup, restore, prune, compact, raw, ...) take
    // their target from the body or act on the whole database, so a contract
    // gets documents, _all_docs and _bulk_docs and nothing else
    const second = parts[1];
    if (second && second.startsWith("_") && second !== "_all_docs" && second !== "_bulk_docs") return true;
    // Creating or dropping a database is not a contract's to do
    if (parts.length <= 1 && method && !/^(GET|HEAD|OPTIONS)$/i.test(method)) return true;
    return false;
  }

  /** The decision, shared by every route a contract has to the network */
  public static enforce(
    scope: IContractScope,
    destination: IContractDestination
  ): (<T>(run: () => T) => T) | undefined {
    if (!ContractScope.isProtected(destination.port)) return undefined;
    // A bare socket to the storage could say anything, so only the connection of
    // an HTTP request that was just approved (with its path) gets through, once,
    // and only for a moment. Everything with a path is checked in full every
    // time: an approval is never a pass for what the contract does next.
    if (destination.path === undefined) {
      const approved = scope.approved;
      if (
        approved && !approved.used && Date.now() < approved.expires &&
        approved.port === destination.port &&
        ContractScope.hostKey(approved.host) === ContractScope.hostKey(destination.host)
      ) {
        approved.used = true;
        return undefined;
      }
    } else if (!destination.unseenBody && !ContractScope.forbidden(destination.path, destination.body, destination.method)) {
      if (scope.allow?.(destination) || (scope.customDatabases && ContractScope.isCustomDatabase(destination.path))) {
        const als = (globalThis as any)[SCOPE];
        const approval = { host: destination.host, port: destination.port, expires: Date.now() + 5000, used: false };
        return <T>(run: () => T): T => als.run(Object.freeze({ ...scope, approved: approval }), run);
      }
    }
    scope.onBlocked?.("storage");
    throw new StorageAccessError("The node's storage");
  }

  /**
   * A request path as the storage will read it: dot segments resolved (`..`,
   * `%2e%2e`), repeated slashes collapsed (the storage skips empty segments),
   * and escapes of ordinary characters decoded (`%5F` is `_`). An escaped
   * slash stays escaped, so it cannot be used to make one segment two.
   */
  public static normalPath(raw: string): string {
    // A leading "//" would be read as a host, not as empty segments
    const resolved = new URL("/" + raw.replace(/^[\\/]+/, ""), "http://x").pathname;
    const decoded = resolved.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => {
      const c = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(c) ? c : match;
    });
    return decoded.replace(/\/{2,}/g, "/");
  }

  /**
   * A database of a user's own: every database name starts with `activeledger`,
   * and the node's own (which are refused before this is asked) are those names
   * exactly. So a name with more after it is a custom one.
   */
  public static isCustomDatabase(path: string): boolean {
    let decoded: string;
    try {
      decoded = decodeURIComponent(ContractScope.normalPath(path));
    } catch {
      return false;
    }
    const first = decoded.split("/").filter(Boolean)[0] ?? "";
    return /^activeledger[A-Za-z0-9_-]{1,64}$/.test(first);
  }

  /** localhost, 127.0.0.1 and ::1 are one host */
  private static readonly LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

  private static hostKey(host: string | undefined): string {
    const h = (host || "localhost").toLowerCase();
    return ContractScope.LOOPBACK.has(h) ? "loopback" : h;
  }

  /**
   * Whether a destination is on a list of `host:port` or `host:port/path`
   * entries. No path means any path on that port. A path matches whole
   * segments (`/wallets` allows `/wallets` and `/wallets/x`, not
   * `/wallets_old`), and the request path is resolved first, so `..` and
   * `%2e%2e` segments cannot climb out of it.
   *
   * @param {string[]} entries
   * @param {IContractDestination} destination
   */
  public static listed(entries: string[], destination: IContractDestination): boolean {
    let path: string | undefined;
    if (destination.path !== undefined) {
      try {
        path = ContractScope.normalPath(destination.path);
      } catch {
        return false;
      }
    }
    for (const entry of entries) {
      let url: URL;
      try {
        url = new URL("http://" + entry);
      } catch {
        continue;
      }
      if (Number(url.port || 80) !== destination.port) continue;
      if (ContractScope.hostKey(url.hostname) !== ContractScope.hostKey(destination.host)) continue;
      const prefix = url.pathname.replace(/\/+$/, "");
      if (!prefix) return true;
      // A bare socket has no path to compare, so a path-limited entry does not cover it
      if (path === undefined) continue;
      if (path === prefix || path.startsWith(prefix + "/")) return true;
    }
    return false;
  }
}
