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

import * as path from "path";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveOptions } from "@activeledger/activeoptions";
import {
  ContractFiles,
  ContractSource,
} from "@activeledger/activecontracts/lib/source";
import type { HybridStore, Sources, StreamLookup } from "./types";
import { readDoc, writeAtRev } from "./lookup";

/**
 * Keeps the compiled contract files Process runs (`contracts/<ns>/<id>.js`
 * and `<id>@<version>.js`, see Process.start setupLocation) in step with
 * the contract streams this hybrid holds.
 */

/** True when a document is a contract stream's state */
export function isContractStream(doc: any): boolean {
  return (
    !!doc &&
    typeof doc._id === "string" &&
    !doc._id.includes(":") &&
    typeof doc.namespace === "string" &&
    !!doc.namespace &&
    !!doc.compiled &&
    typeof doc.contract === "object" &&
    doc.contract !== null
  );
}

/** Semver-ish order, as Process sorts contract files for "latest" */
const byVersion = (a: string, b: string) => {
  const pad = (v: string) =>
    v
      .split(".")
      .map((p) => "00000000".substring(0, 8 - p.length) + p)
      .join(".");
  return pad(a).localeCompare(pad(b));
};

export interface ContractBuilderOptions {
  store: Pick<HybridStore, "data">;
  sources: Sources | (() => Sources);
  /** Kept for callers; a stream this hybrid does not hold is fetched through `verify` instead */
  lookup?: StreamLookup;
  /**
   * Proves a fetched contract stream is what the network agreed (its state
   * hash is in a quorum-signed commit attestation). Without it a contract
   * this hybrid does not hold is not fetched at all: compiling code that
   * nothing signed would let an upstream run its own code here.
   */
  verify?: (state: any, meta: any) => Promise<boolean>;
  /** Default `<cwd>/contracts/`, where Process looks */
  rootDir?: string;
}

export class ContractBuilder {
  private readonly files: ContractFiles;
  /** Contract stream id -> state revision last built */
  private readonly built = new Map<string, string>();

  constructor(private readonly options: ContractBuilderOptions) {
    this.files = new ContractFiles(
      options.rootDir ?? path.join(process.cwd(), "contracts") + "/"
    );
  }

  private sources(): Sources {
    const s = this.options.sources;
    return typeof s === "function" ? s() : s;
  }

  /** A `<umid>:umid` doc: the local data db first, then the upstreams */
  private fetchUmid = async (umid: string): Promise<any | undefined> => {
    const local = await readDoc(this.options.store.data, `${umid}:umid`);
    if (local) return local;
    const { supernodes, peers } = this.sources();
    for (const source of [...supernodes, ...peers]) {
      try {
        const doc = await source.umid(umid);
        if (doc?.umid?.$umid === umid) return doc;
      } catch {
        // Try the next
      }
    }
    return undefined;
  };

  /**
   * Write every version of a contract stream that can be recovered, latest
   * last so `<id>.js` is the highest version. Skipped when this revision was
   * already built.
   */
  public async rebuild(state: any): Promise<{ built: string[]; failed: { version: string; reason: string }[] }> {
    const out = { built: [] as string[], failed: [] as { version: string; reason: string }[] };
    if (!isContractStream(state)) return out;
    if (state._rev && this.built.get(state._id) === state._rev) return out;
    for (const version of Object.keys(state.contract).sort(byVersion)) {
      try {
        const source = await ContractSource.resolve(state, version, this.fetchUmid);
        this.files.write(
          state.namespace,
          state._id,
          version,
          ContractSource.transpile(source.base64, source.target)
        );
        out.built.push(version);
      } catch (e) {
        const reason = (e as Error)?.message || String(e);
        out.failed.push({ version, reason });
        ActiveLogger.warn(`Cannot build contract ${state._id}@${version}: ${reason}`);
      }
    }
    if (!out.failed.length && state._rev) this.built.set(state._id, state._rev);
    return out;
  }

  /** Rebuild any contract streams among documents just written */
  public async onWritten(docs: any[]): Promise<void> {
    for (const doc of docs) {
      if (!isContractStream(doc)) continue;
      // Build from what was stored, which carries the final revision
      await this.rebuild((await readDoc(this.options.store.data, doc._id)) ?? doc);
    }
  }

  /**
   * Make sure the contract an entry runs is on disk: a first-seen contract
   * is fetched (when a lookup is given) and built. Default contracts ship
   * with the node and need nothing.
   */
  /** Fetch a contract stream from the supernodes and keep it only if it verifies */
  private async fetchVerified(id: string): Promise<any | undefined> {
    const verify = this.options.verify;
    if (!verify) {
      ActiveLogger.warn(`Contract ${id} is not held and no verifier is set; not fetched`);
      return undefined;
    }
    const sources = this.options.sources;
    const { supernodes } = typeof sources === "function" ? sources() : sources;
    for (const up of supernodes) {
      try {
        const r = await up.streams([{ id }]);
        const state = r.docs.find((d: any) => d?._id === id);
        const meta = r.docs.find((d: any) => d?._id === `${id}:stream`);
        if (!state || !meta || !(await verify(state, meta))) continue;
        const db = this.options.store.data;
        if ((await writeAtRev(db, meta)) && (await writeAtRev(db, state))) return state;
      } catch (e) {
        ActiveLogger.warn(`Contract ${id}: ${up.id}: ${(e as Error)?.message || e}`);
      }
    }
    return undefined;
  }

  public async ensureFor(entry: any): Promise<void> {
    const ns = entry?.$tx?.$namespace;
    const contract = entry?.$tx?.$contract;
    if (typeof ns !== "string" || typeof contract !== "string" || ns === "default") return;
    const id = contract.split("@")[0];
    if (!id || id.includes("/") || id.includes("..")) return;
    let state = await readDoc(this.options.store.data, id);
    if (state && this.files.exists(ns, id) && this.built.get(id) === state._rev) return;
    if (!state) state = await this.fetchVerified(id);
    // A label (symlink) is not a stream; Process resolves it on disk
    if (state) await this.rebuild(state);
  }
}

/**
 * Options Process reads from ActiveOptions. A hybrid takes them from the
 * on-ledger setup stream so it checks transactions as the supernodes do:
 * `security` (namespaces, signedOutputs, hardenedKeys, contractIsolation).
 * `build` is not on-ledger; a hybrid requires supernodes at 40300 or later,
 * so it runs at least that build (contract deploys store references from
 * 40100, for instance).
 */
export function applyExecutionOptions(setupDoc: any, build = 40300): void {
  if (setupDoc && typeof setupDoc.security === "object" && setupDoc.security) {
    ActiveOptions.set("security", setupDoc.security);
  } else if (!ActiveOptions.get<any>("security", null)) {
    ActiveOptions.set("security", { namespace: {}, signedOutputs: false, hardenedKeys: false });
  }
  if (ActiveOptions.get<number>("build", 0) < build) ActiveOptions.set("build", build);
}
