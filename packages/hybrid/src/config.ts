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
import { ActiveDefinitions } from "@activeledger/activedefinitions";

type IHybridConfig = ActiveDefinitions.IHybridConfig;
type IHybridEndpoint = ActiveDefinitions.IHybridEndpoint;

/** One or more problems with a config, each naming the key at fault */
export class ConfigError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid hybrid config:\n  - ${errors.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export const defaultConfig = (): IHybridConfig => ({
  upstreams: [],
  peers: [],
  bind: "127.0.0.1",
  port: 5270,
  window: { days: 30 },
  maxLagSeconds: null,
  refuseOnboard: true,
});

const TOP_KEYS = [
  "upstreams",
  "peers",
  "bind",
  "port",
  "token",
  "window",
  "maxLagSeconds",
  "refuseOnboard",
  "events",
  "submit",
  "pin",
];
const TRANSPORTS = ["p2p", "http"];

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const describe = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

const unknownKeys = (
  obj: Record<string, any>,
  allowed: string[],
  path: string,
  errors: string[]
) => {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      errors.push(`${path ? path + "." : ""}${k}: unknown key`);
    }
  }
};

const checkEndpoint = (
  v: unknown,
  path: string,
  errors: string[]
): IHybridEndpoint | undefined => {
  if (!isObject(v)) {
    errors.push(`${path}: expected an object {host, port, transport}, got ${describe(v)}`);
    return;
  }
  unknownKeys(v, ["host", "port", "transport", "tls"], path, errors);
  const before = errors.length;
  if (typeof v.host !== "string" || !v.host.trim()) {
    errors.push(`${path}.host: expected a non-empty string`);
  }
  if (!isPort(v.port)) {
    errors.push(`${path}.port: expected an integer from 1 to 65535, got ${JSON.stringify(v.port)}`);
  }
  const transport = v.transport ?? "http";
  if (!TRANSPORTS.includes(transport)) {
    errors.push(`${path}.transport: expected "p2p" or "http", got ${JSON.stringify(v.transport)}`);
  }
  if (v.tls !== undefined && typeof v.tls !== "boolean") {
    errors.push(`${path}.tls: expected true or false, got ${describe(v.tls)}`);
  }
  if (errors.length > before) return;
  return { host: v.host, port: v.port, transport, ...(v.tls ? { tls: true } : {}) };
};

const checkEndpoints = (
  v: unknown,
  path: string,
  errors: string[]
): IHybridEndpoint[] => {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected an array, got ${describe(v)}`);
    return [];
  }
  const out: IHybridEndpoint[] = [];
  v.forEach((e, i) => {
    const ep = checkEndpoint(e, `${path}[${i}]`, errors);
    if (ep) out.push(ep);
  });
  return out;
};

const checkStrings = (
  v: unknown,
  path: string,
  errors: string[]
): string[] | undefined => {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected an array of strings, got ${describe(v)}`);
    return;
  }
  const bad = v.findIndex((s) => typeof s !== "string" || !s);
  if (bad >= 0) {
    errors.push(`${path}[${bad}]: expected a non-empty string, got ${JSON.stringify(v[bad])}`);
    return;
  }
  return [...v];
};

/**
 * Validate a parsed config and fill the defaults. Every problem is collected,
 * so an operator sees them all at once. Throws `ConfigError`.
 */
export function validateConfig(raw: unknown): IHybridConfig {
  const errors: string[] = [];
  if (!isObject(raw)) {
    throw new ConfigError([`config: expected an object, got ${describe(raw)}`]);
  }
  unknownKeys(raw, TOP_KEYS, "", errors);
  const cfg = defaultConfig();

  if (raw.upstreams !== undefined) {
    cfg.upstreams = checkEndpoints(raw.upstreams, "upstreams", errors);
  }
  if (raw.peers !== undefined) {
    cfg.peers = checkEndpoints(raw.peers, "peers", errors);
  }
  if (raw.bind !== undefined) {
    if (typeof raw.bind !== "string" || !raw.bind.trim()) {
      errors.push(`bind: expected a non-empty string, got ${JSON.stringify(raw.bind)}`);
    } else cfg.bind = raw.bind;
  }
  if (raw.port !== undefined) {
    if (!isPort(raw.port)) {
      errors.push(`port: expected an integer from 1 to 65535, got ${JSON.stringify(raw.port)}`);
    } else cfg.port = raw.port;
  }
  if (raw.token !== undefined) {
    if (typeof raw.token !== "string" || !raw.token) {
      errors.push(`token: expected a non-empty string, got ${describe(raw.token)}`);
    } else cfg.token = raw.token;
  }
  if (raw.window !== undefined) {
    if (!isObject(raw.window)) {
      errors.push(`window: expected an object {days}, got ${describe(raw.window)}`);
    } else {
      unknownKeys(raw.window, ["days"], "window", errors);
      const d = raw.window.days;
      if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
        errors.push(`window.days: expected a positive number, got ${JSON.stringify(d)}`);
      } else cfg.window = { days: d };
    }
  }
  if (raw.maxLagSeconds !== undefined) {
    const m = raw.maxLagSeconds;
    if (m !== null && (typeof m !== "number" || !Number.isFinite(m) || m <= 0)) {
      errors.push(`maxLagSeconds: expected a positive number or null, got ${JSON.stringify(m)}`);
    } else cfg.maxLagSeconds = m;
  }
  if (raw.refuseOnboard !== undefined) {
    if (typeof raw.refuseOnboard !== "boolean") {
      errors.push(`refuseOnboard: expected a boolean, got ${describe(raw.refuseOnboard)}`);
    } else cfg.refuseOnboard = raw.refuseOnboard;
  }
  if (raw.events !== undefined) {
    if (!isObject(raw.events)) {
      errors.push(`events: expected an object {contracts?, where?}, got ${describe(raw.events)}`);
    } else {
      unknownKeys(raw.events, ["contracts", "where"], "events", errors);
      const events: NonNullable<IHybridConfig["events"]> = {};
      if (raw.events.contracts !== undefined) {
        const c = checkStrings(raw.events.contracts, "events.contracts", errors);
        if (c) events.contracts = c;
      }
      if (raw.events.where !== undefined) {
        const w = raw.events.where;
        if (!isObject(w)) {
          errors.push(`events.where: expected an object of field: value, got ${describe(w)}`);
        } else {
          let ok = true;
          for (const k of Object.keys(w)) {
            if (typeof w[k] !== "string") {
              errors.push(`events.where.${k}: expected a string, got ${describe(w[k])}`);
              ok = false;
            }
          }
          if (ok) events.where = { ...w };
        }
      }
      cfg.events = events;
    }
  }
  if (raw.submit !== undefined) {
    if (!isObject(raw.submit)) {
      errors.push(`submit: expected an object {contracts?}, got ${describe(raw.submit)}`);
    } else {
      unknownKeys(raw.submit, ["contracts"], "submit", errors);
      const submit: NonNullable<IHybridConfig["submit"]> = {};
      if (raw.submit.contracts !== undefined) {
        const c = checkStrings(raw.submit.contracts, "submit.contracts", errors);
        if (c) submit.contracts = c;
      }
      cfg.submit = submit;
    }
  }

  if (raw.pin !== undefined) {
    if (!isObject(raw.pin)) {
      errors.push(`pin: expected an object {neighbourhoodSha256}, got ${describe(raw.pin)}`);
    } else {
      unknownKeys(raw.pin, ["neighbourhoodSha256"], "pin", errors);
      const h = raw.pin.neighbourhoodSha256;
      if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
        errors.push("pin.neighbourhoodSha256: expected 64 lowercase hex characters");
      } else {
        cfg.pin = { neighbourhoodSha256: h };
      }
    }
  }

  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

/** Read and validate a `hybrid.json`. Throws `ConfigError`. */
export function loadConfig(path: string): IHybridConfig {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (e: any) {
    throw new ConfigError([`${path}: cannot read (${e?.code ?? e?.message ?? e})`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new ConfigError([`${path}: not valid JSON (${e?.message ?? e})`]);
  }
  return validateConfig(raw);
}

/**
 * `host:port[:p2p|http]`, IPv6 in brackets (`[::1]:5260:p2p`). The transport
 * defaults to http. Throws `ConfigError`.
 */
export function parseUpstream(value: string): IHybridEndpoint {
  const fail = (why: string) =>
    new ConfigError([`upstream ${JSON.stringify(value)}: ${why}, expected host:port[:p2p|http]`]);
  if (typeof value !== "string" || !value) throw fail("empty");

  let host: string;
  let rest: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) throw fail("unclosed [");
    host = value.slice(1, close);
    if (!host) throw fail("empty IPv6 address");
    if (value[close + 1] !== ":") throw fail("missing port");
    rest = value.slice(close + 2);
  } else {
    const i = value.indexOf(":");
    if (i < 0) throw fail("missing port");
    if (value.split(":").length > 3) {
      throw fail("too many parts (put an IPv6 address in brackets)");
    }
    host = value.slice(0, i);
    rest = value.slice(i + 1);
    if (!host) throw fail("missing host");
  }

  const parts = rest.split(":");
  if (parts.length > 2) {
    throw fail(value.startsWith("[") ? "too many parts" : "too many parts (put an IPv6 address in brackets)");
  }
  const [portText, transport = "http"] = parts;
  if (!/^\d+$/.test(portText) || !isPort(Number(portText))) {
    throw fail(`port ${JSON.stringify(portText)} is not 1 to 65535`);
  }
  if (!TRANSPORTS.includes(transport)) {
    throw fail(`transport ${JSON.stringify(transport)} is not p2p or http`);
  }
  return {
    host,
    port: Number(portText),
    transport: transport as ActiveDefinitions.HybridTransport,
  };
}

/** Command line values as minimist gives them */
export type ConfigFlags = { [flag: string]: unknown };

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

const lastOf = (v: unknown): unknown => (Array.isArray(v) ? v[v.length - 1] : v);

const flagNumber = (flag: string, v: unknown, errors: string[]): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    errors.push(`--${flag}: expected a number, got ${JSON.stringify(v)}`);
    return;
  }
  return n;
};

const flagBoolean = (flag: string, v: unknown, errors: string[]): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  errors.push(`--${flag}: expected true or false, got ${JSON.stringify(v)}`);
};

const flagString = (flag: string, v: unknown, errors: string[]): string | undefined => {
  if (typeof v === "string" && v) return v;
  if (typeof v === "number") return String(v);
  errors.push(`--${flag}: expected a value`);
};

/**
 * Apply command line flags over a config. Flags are kebab-case and mirror the
 * config keys (`--max-lag-seconds` is `maxLagSeconds`); `--host` sets `bind`.
 * `--upstream` and `--peer` are repeatable and replace the file's list.
 * Flags that are not config keys (`--config`, `--debug`...) are ignored here.
 * The result is validated again. Pure: `config` is not changed.
 */
export function mergeFlags(config: IHybridConfig, flags: ConfigFlags): IHybridConfig {
  const errors: string[] = [];
  const out: any = JSON.parse(JSON.stringify(config));
  const has = (k: string) => flags[k] !== undefined;

  if (has("upstream")) {
    out.upstreams = [];
    for (const u of list(flags.upstream)) {
      try {
        out.upstreams.push(parseUpstream(String(u)));
      } catch (e: any) {
        errors.push(`--upstream: ${(e as ConfigError).errors?.[0] ?? e.message}`);
      }
    }
  }
  if (has("peer")) {
    out.peers = [];
    for (const p of list(flags.peer)) {
      try {
        out.peers.push(parseUpstream(String(p)));
      } catch (e: any) {
        errors.push(`--peer: ${(e as ConfigError).errors?.[0] ?? e.message}`);
      }
    }
  }
  for (const flag of ["host", "bind"]) {
    if (has(flag)) {
      const s = flagString(flag, lastOf(flags[flag]), errors);
      if (s !== undefined) out.bind = s;
    }
  }
  if (has("port")) {
    const n = flagNumber("port", lastOf(flags.port), errors);
    if (n !== undefined) out.port = n;
  }
  if (has("token")) {
    const s = flagString("token", lastOf(flags.token), errors);
    if (s !== undefined) out.token = s;
  }
  if (has("window-days")) {
    const n = flagNumber("window-days", lastOf(flags["window-days"]), errors);
    if (n !== undefined) out.window = { days: n };
  }
  if (has("max-lag-seconds")) {
    const v = lastOf(flags["max-lag-seconds"]);
    if (v === "null" || v === "none") out.maxLagSeconds = null;
    else {
      const n = flagNumber("max-lag-seconds", v, errors);
      if (n !== undefined) out.maxLagSeconds = n;
    }
  }
  if (has("refuse-onboard")) {
    const b = flagBoolean("refuse-onboard", lastOf(flags["refuse-onboard"]), errors);
    if (b !== undefined) out.refuseOnboard = b;
  }
  if (has("events-contract")) {
    out.events = { ...(out.events ?? {}), contracts: list(flags["events-contract"]).map(String) };
  }
  if (has("events-where")) {
    const where: { [k: string]: string } = {};
    for (const w of list(flags["events-where"])) {
      const s = String(w);
      const i = s.indexOf(":");
      if (i <= 0) errors.push(`--events-where: expected field:value, got ${JSON.stringify(s)}`);
      else where[s.slice(0, i)] = s.slice(i + 1);
    }
    out.events = { ...(out.events ?? {}), where };
  }
  if (has("submit-contract")) {
    out.submit = { ...(out.submit ?? {}), contracts: list(flags["submit-contract"]).map(String) };
  }

  if (errors.length) throw new ConfigError(errors);
  return validateConfig(out);
}
