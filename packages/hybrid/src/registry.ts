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

import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { HybridIdentity } from "./http-upstream";

/**
 * Transactions for the `default/hybrid` registry contract. Pure: they build
 * and sign, and the caller submits. A registry transaction carries `$expire`,
 * so a resend is detected as a duplicate instead of running twice.
 */

const EXPIRE_MS = 5 * 60 * 1000;

export const registryStreamId = (identity: HybridIdentity): string =>
  ActiveCrypto.hybridStreamId(identity.publicPem);

const body = (
  tx: Record<string, unknown>,
  refs: string[],
  identity: HybridIdentity,
  selfsign: boolean,
  now: number
) => {
  const $tx = { ...tx, $namespace: "default", $contract: "hybrid", $expire: new Date(now + EXPIRE_MS).toISOString() };
  // The signature is over the transaction, under each input it covers
  const signature = identity.pair.sign($tx);
  return {
    $tx,
    $sigs: Object.fromEntries(refs.map((r) => [r, signature])),
    ...(selfsign ? { $selfsign: true } : {}),
  };
};

/** `p2p://host:port` or `http://host:port` -> an endpoint */
export const parseEndpoint = (value: string): ActiveDefinitions.IHybridEndpoint => {
  const m = /^(p2p|http):\/\/(\[[^\]]+\]|[^:/\s]+):(\d{1,5})$/.exec(value);
  if (!m) throw new Error(`endpoint "${value}": expected p2p://host:port or http://host:port`);
  const port = Number(m[3]);
  if (port < 1 || port > 65535) throw new Error(`endpoint "${value}": port out of range`);
  return { transport: m[1] as ActiveDefinitions.HybridTransport, host: m[2].replace(/^\[|\]$/g, ""), port };
};

export const registerTx = (
  identity: HybridIdentity,
  endpoints: ActiveDefinitions.IHybridEndpoint[],
  label?: string,
  now: number = Date.now()
) =>
  body(
    {
      $entry: "register",
      $i: {
        [identity.keyHash]: {
          type: identity.type,
          publicKey: identity.publicPem,
          endpoints,
          ...(label ? { label } : {}),
        },
      },
    },
    [identity.keyHash],
    identity,
    true,
    now
  );

export const updateTx = (
  identity: HybridIdentity,
  endpoints: ActiveDefinitions.IHybridEndpoint[],
  now: number = Date.now()
) => {
  const id = registryStreamId(identity);
  return body({ $entry: "update", $i: { [id]: { endpoints } } }, [id], identity, false, now);
};

export const retireTx = (identity: HybridIdentity, now: number = Date.now()) => {
  const id = registryStreamId(identity);
  return body({ $entry: "retire", $i: { [id]: {} } }, [id], identity, false, now);
};

/**
 * What a supernode's answer to a transaction means. The ledger reports
 * problems in `$summary.errors`; a 1530 collision on register means the key
 * is already registered.
 */
export const interpret = (
  response: any
): { ok: boolean; alreadyRegistered: boolean; errors: string[] } => {
  const errors: string[] = [
    ...(Array.isArray(response?.$summary?.errors) ? response.$summary.errors : []),
    ...(typeof response?.error === "string" ? [response.error] : []),
  ].map(String);
  const alreadyRegistered = errors.some((e) => /1530|collision|already/i.test(e));
  return { ok: errors.length === 0, alreadyRegistered, errors };
};
