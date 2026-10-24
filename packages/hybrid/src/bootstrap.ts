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

import { ActiveLogger } from "@activeledger/activelogger";
import { applyExecutionOptions, ContractBuilder, isContractStream } from "./contracts";
import { readDoc, writeAtRev } from "./lookup";
import { HybridStore, StreamLookup } from "./types";
import { IBootstrap, Upstream } from "./upstream";
import { UpstreamError } from "./http-upstream";
import { checkPin, VerifyContext, verifyContext } from "./verify";

/**
 * Bootstrap: pick a supernode that will talk to us, take the setup stream it
 * serves (checked against the operator's pin), and pull what the node needs
 * to start following: the required streams and every contract.
 */

/** Raised when no upstream can bootstrap this node. `refused` means we are not (or no longer) registered. */
export class BootstrapError extends Error {
  constructor(message: string, public readonly refused = false) {
    super(message);
  }
}

/** Compare dotted numeric versions: negative, zero or positive. Pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0].split(".").map((p) => parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** True when this hybrid's release is older than the network's `hybrid.minVersion` */
export const isOutdated = (version: string, minVersion?: string): boolean =>
  !!minVersion && compareVersions(version, minVersion) < 0;

/** Stream ids named in the required list */
export const requiredIds = (required: IBootstrap["required"]): string[] =>
  (required ?? []).map((r: any) => (typeof r === "string" ? r : r?.id)).filter((id: unknown): id is string => typeof id === "string" && !!id);

export interface BootstrapDeps {
  upstreams: Upstream[];
  /** Pinned neighbourhood hash from the config, if the operator set one */
  pin?: { neighbourhoodSha256: string };
  /** This hybrid's package version */
  version: string;
  store: Pick<HybridStore, "data">;
  lookup: StreamLookup;
  contracts: ContractBuilder;
  /** Contracts built at once. Default 4. */
  concurrency?: number;
}

export interface BootstrapResult {
  upstream: Upstream;
  bootstrap: IBootstrap;
  setup: any;
  /** The setup stream's `id@rev`, which node references are computed from */
  network: string;
  verify: VerifyContext;
  minVersion?: string;
  outdated: boolean;
}

export async function bootstrapNode(deps: BootstrapDeps): Promise<BootstrapResult> {
  const failures: string[] = [];
  let refused = 0;
  for (const upstream of deps.upstreams) {
    let bootstrap: IBootstrap;
    try {
      bootstrap = await upstream.bootstrap();
    } catch (e) {
      if (e instanceof UpstreamError && e.refused) refused++;
      failures.push(`${upstream.id}: ${(e as Error).message}`);
      continue;
    }

    const setup = bootstrap.setup;
    if (!setup || typeof setup._id !== "string" || typeof setup._rev !== "string") {
      failures.push(`${upstream.id}: no setup stream in the bootstrap`);
      continue;
    }
    const pin = checkPin(setup, deps.pin);
    if (!pin.ok) {
      // A different set of voting keys than the operator pinned: never use this upstream
      failures.push(`${upstream.id}: ${pin.reason}`);
      continue;
    }
    const network = `${setup._id}@${setup._rev}`;
    const verify = verifyContext(setup, network);
    if (!verify.keys.size || !(verify.reachedPercent > 0) || !(verify.networkSize > 0)) {
      failures.push(`${upstream.id}: the setup stream has no usable neighbourhood or consensus`);
      continue;
    }

    await writeAtRev(deps.store.data, setup);
    applyExecutionOptions(setup);
    const minVersion = bootstrap.minVersion;
    const outdated = isOutdated(deps.version, minVersion);
    const result: BootstrapResult = { upstream, bootstrap, setup, network, verify, minVersion, outdated };
    // An outdated hybrid applies nothing, so it pulls nothing either
    if (outdated) return result;

    await pullStreams(deps, bootstrap);
    return result;
  }

  throw new BootstrapError(
    refused && refused === deps.upstreams.length
      ? `Every upstream refused this key. Is it registered? Run "activehybrid register". (${failures.join("; ")})`
      : `Could not bootstrap from any upstream: ${failures.join("; ") || "none configured"}`,
    refused > 0 && refused === deps.upstreams.length
  );
}

/** Required streams at their tips, then every contract built once verified */
async function pullStreams(deps: BootstrapDeps, bootstrap: IBootstrap): Promise<void> {
  const ids = requiredIds(bootstrap.required);
  if (ids.length) {
    const { missing } = await deps.lookup.refreshToTip(ids);
    if (missing.length) ActiveLogger.warn(`Bootstrap: required streams not served: ${missing.join(", ")}`);
  }

  const contractIds = bootstrap.contracts ?? [];
  if (!contractIds.length) return;
  await deps.lookup.refreshToTip(contractIds);
  const limit = Math.max(1, deps.concurrency ?? 4);
  let next = 0;
  const worker = async () => {
    while (next < contractIds.length) {
      const id = contractIds[next++];
      const state = await readDoc(deps.store.data, id);
      if (!state || !isContractStream(state)) continue;
      const r = await deps.contracts.rebuild(state);
      if (r.failed.length) {
        ActiveLogger.warn(`Bootstrap: contract ${id}: ${r.failed.map((f) => `${f.version}: ${f.reason}`).join("; ")}`);
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

/** The cursor to resume from: the stored one, else the bootstrap's */
export async function resumeCursor(
  store: Pick<HybridStore, "events">,
  fromBootstrap: string
): Promise<string> {
  const stored = await readDoc(store.events, CURSOR_DOC);
  return typeof stored?.cursor === "string" ? stored.cursor : fromBootstrap;
}

export const CURSOR_DOC = "hybrid:cursor";

/** Persist the cursor after an item is applied */
export async function saveCursor(
  store: Pick<HybridStore, "events">,
  cursor: string
): Promise<void> {
  const existing = await readDoc(store.events, CURSOR_DOC);
  await store.events.put({ _id: CURSOR_DOC, ...(existing?._rev ? { _rev: existing._rev } : {}), cursor } as { _id: string; _rev?: string });
}

