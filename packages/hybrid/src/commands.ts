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

import * as crypto from "crypto";
import * as fs from "fs";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Cli } from "@activeledger/activeoptions";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { ConfigError, defaultConfig, loadConfig, mergeFlags, parseUpstream, validateConfig } from "./config";
import { HttpUpstream, HybridIdentity, UpstreamError, loadIdentity } from "./http-upstream";
import { Upstream } from "./upstream";
import { interpret, parseEndpoint, registerTx, registryStreamId, retireTx, updateTx } from "./registry";

/**
 * The commands that work without a running node: they read the config and
 * identity files and talk to a supernode. Each returns an exit code and
 * prints through `out`, so they can be driven from tests.
 */

export interface Out {
  log(text: string): void;
  error(text: string): void;
}

export const consoleOut: Out = {
  log: (t) => console.log(t),
  error: (t) => console.error(t),
};

export interface CommandContext {
  flags: Record<string, any>;
  out: Out;
  /** Builds the supernode client; replaced in tests */
  upstream?: (endpoint: ActiveDefinitions.IHybridEndpoint, identity: HybridIdentity) => Upstream;
}

const json = (ctx: CommandContext) => !!ctx.flags.json;
const configPath = (ctx: CommandContext) => String(ctx.flags.config ?? "./hybrid.json");
const identityPath = (ctx: CommandContext) => String(ctx.flags.identity ?? "./.identity");

const emit = (ctx: CommandContext, data: Record<string, unknown>, text: string) =>
  ctx.out.log(json(ctx) ? JSON.stringify(data) : text);

const fail = (ctx: CommandContext, message: string, code: number = Cli.ExitCode.FAIL): number => {
  json(ctx) ? ctx.out.error(JSON.stringify({ error: message })) : ctx.out.error(message);
  return code;
};

const asList = (v: unknown): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(String));

/** `init`: identity and flat config. Refuses to overwrite either without --force. */
export function init(ctx: CommandContext): number {
  const cfgFile = configPath(ctx);
  const idFile = identityPath(ctx);
  const force = !!ctx.flags.force;
  const existing = [cfgFile, idFile].filter((f) => fs.existsSync(f));
  if (existing.length && !force) {
    return fail(ctx, `${existing.join(" and ")} already exist${existing.length === 1 ? "s" : ""}; use --force to overwrite`);
  }
  let config;
  try {
    config = mergeFlags(defaultConfig(), ctx.flags);
  } catch (e: any) {
    return fail(ctx, e.message);
  }

  // 0600: the identity file holds the private key
  const identity = new ActiveCrypto.KeyPair("rsa").generate();
  fs.writeFileSync(idFile, JSON.stringify(identity), { mode: 0o600 });
  fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2) + "\n");
  const keyHash = ActiveCrypto.keyHash(identity.pub.pkcs8pem);
  emit(ctx, { config: cfgFile, identity: idFile, keyHash }, `Wrote ${cfgFile} and ${idFile}\nkey ${keyHash}`);
  return Cli.ExitCode.OK;
}

/** `token`: a new random bearer token to put in the config */
export function token(ctx: CommandContext): number {
  const value = crypto.randomBytes(32).toString("hex");
  emit(ctx, { token: value }, value);
  return Cli.ExitCode.OK;
}

/** `check-config`: validate hybrid.json (with flags applied) */
export function checkConfig(ctx: CommandContext): number {
  const file = configPath(ctx);
  try {
    mergeFlags(loadConfig(file), ctx.flags);
  } catch (e: any) {
    const reasons = e instanceof ConfigError ? e.errors : [e.message];
    json(ctx)
      ? ctx.out.log(JSON.stringify({ valid: false, file, reasons }))
      : ctx.out.error(`${file} is not valid:\n  ${reasons.join("\n  ")}`);
    return Cli.ExitCode.STATE;
  }
  emit(ctx, { valid: true, file }, `${file} is valid`);
  return Cli.ExitCode.OK;
}

const connect = (ctx: CommandContext) => {
  const config = mergeFlags(loadConfig(configPath(ctx)), ctx.flags);
  const identity = loadIdentity(identityPath(ctx));
  const endpoint = config.upstreams.find((u) => u.transport === "http");
  if (!endpoint) {
    throw new Error(
      config.upstreams.length
        ? "no http upstream configured (p2p upstreams are not supported by this command yet)"
        : "no upstream configured; set one with --upstream host:port"
    );
  }
  const upstream = ctx.upstream
    ? ctx.upstream(endpoint, identity)
    : new HttpUpstream({ host: endpoint.host, port: endpoint.port, identity, tls: endpoint.tls });
  return { config, identity, upstream };
};

/** Is this key registered, and retired? `undefined` when the supernode does not know it. */
const registration = async (upstream: Upstream, identity: HybridIdentity) => {
  try {
    const r = await upstream.streams([{ id: registryStreamId(identity) }]);
    const state = r.docs.find((d) => d._id === registryStreamId(identity));
    return state ? { retired: !!state.retired, endpoints: state.endpoints } : undefined;
  } catch (e) {
    // A key that is not registered is refused: that is the answer, not a failure
    if (e instanceof UpstreamError && e.refused) return undefined;
    throw e;
  }
};

const endpointsFrom = (ctx: CommandContext): ActiveDefinitions.IHybridEndpoint[] =>
  asList(ctx.flags.endpoint).map(parseEndpoint);

/** `register`: idempotent, a registered key reports it and exits 0 */
export async function register(ctx: CommandContext): Promise<number> {
  try {
    const { upstream, identity } = connect(ctx);
    const existing = await registration(upstream, identity);
    if (existing) {
      return existing.retired
        ? fail(ctx, "this key was registered and then retired; create a new identity with init --force")
        : (emit(ctx, { registered: true, already: true, keyHash: identity.keyHash }, `already registered (${identity.keyHash})`),
          Cli.ExitCode.OK);
    }
    const endpoints = endpointsFrom(ctx);
    if (!endpoints.length) return fail(ctx, "at least one --endpoint is needed, e.g. --endpoint p2p://host:5271");
    const answer = interpret(await upstream.submit(registerTx(identity, endpoints, ctx.flags.label)));
    if (!answer.ok && !answer.alreadyRegistered) return fail(ctx, `register failed: ${answer.errors.join("; ")}`);
    emit(ctx, { registered: true, already: answer.alreadyRegistered, keyHash: identity.keyHash }, `registered ${identity.keyHash}`);
    return Cli.ExitCode.OK;
  } catch (e: any) {
    return fail(ctx, e.message);
  }
}

/** `update --endpoint ...` */
export async function update(ctx: CommandContext): Promise<number> {
  try {
    const endpoints = endpointsFrom(ctx);
    if (!endpoints.length) return fail(ctx, "at least one --endpoint is needed");
    const { upstream, identity } = connect(ctx);
    const existing = await registration(upstream, identity);
    if (!existing) return fail(ctx, "this key is not registered", Cli.ExitCode.STATE);
    if (existing.retired) return fail(ctx, "this registration is retired", Cli.ExitCode.STATE);
    const answer = interpret(await upstream.submit(updateTx(identity, endpoints)));
    if (!answer.ok) return fail(ctx, `update failed: ${answer.errors.join("; ")}`);
    emit(ctx, { updated: true, endpoints }, `updated ${endpoints.length} endpoint(s)`);
    return Cli.ExitCode.OK;
  } catch (e: any) {
    return fail(ctx, e.message);
  }
}

/** `retire`: asks for --yes, because a retired key can never register again */
export async function retire(ctx: CommandContext): Promise<number> {
  if (!ctx.flags.yes) {
    return fail(ctx, "retiring is permanent for this key; run again with --yes to confirm");
  }
  try {
    const { upstream, identity } = connect(ctx);
    const existing = await registration(upstream, identity);
    if (!existing) return fail(ctx, "this key is not registered", Cli.ExitCode.STATE);
    if (existing.retired) {
      emit(ctx, { retired: true, already: true }, "already retired");
      return Cli.ExitCode.OK;
    }
    const answer = interpret(await upstream.submit(retireTx(identity)));
    if (!answer.ok) return fail(ctx, `retire failed: ${answer.errors.join("; ")}`);
    emit(ctx, { retired: true }, "retired");
    return Cli.ExitCode.OK;
  } catch (e: any) {
    return fail(ctx, e.message);
  }
}

/** `peers`: the registered hybrids a supernode knows */
export async function peers(ctx: CommandContext): Promise<number> {
  try {
    const { upstream } = connect(ctx);
    const list = await upstream.peers();
    emit(
      ctx,
      { peers: list },
      list.length
        ? list.map((p) => `${p.keyHash}  ${p.label ?? ""}  ${(p.endpoints ?? []).map((e: any) => `${e.transport}://${e.host}:${e.port}`).join(" ")}`).join("\n")
        : "no hybrids registered"
    );
    return Cli.ExitCode.OK;
  } catch (e: any) {
    return fail(ctx, e.message);
  }
}

// Used by tests to build upstream endpoints from text
export const upstreamFrom = parseUpstream;
export { validateConfig };
