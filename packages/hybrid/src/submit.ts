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
import type { ActiveDSConnect } from "@activeledger/activeoptions";
import type { ActiveProtocol } from "@activeledger/activeprotocol";
import type { Upstream } from "./upstream";
import type { HybridOutcome, NodeState, Sources, StreamLookup } from "./types";

type IHybridConfig = ActiveDefinitions.IHybridConfig;
type IExecutionResult = ActiveProtocol.IExecutionResult;

/** What `POST /` answers: an HTTP status and a JSON body */
export interface SubmitResult {
  status: number;
  body: any;
}

/** Built-in contracts a hybrid never forwards, whatever key signs */
const ALWAYS_REFUSED = ["contract", "namespace", "setup", "fund"];

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Case and whitespace do not get a built-in past the refusal */
const norm = (s: string) => s.trim().toLowerCase();

/**
 * Step 0 of `POST /`: why this transaction is refused before anything else,
 * or undefined. Pure, and used again for transactions a mesh peer forwards.
 *
 * Refused: a contract deploy, namespace claim, setup or fund transaction
 * (`default/contract`, `default/namespace`, `default/setup`, `default/fund`),
 * `default/onboard` while `refuseOnboard` is true (the default), a
 * transaction with no `$tx.$expire`, and a contract not listed in
 * `submit.contracts` when that is set. Something that is not a transaction
 * with a string `$namespace` and `$contract` is refused too (fail closed).
 */
export function refusal(
  tx: unknown,
  config: Pick<IHybridConfig, "refuseOnboard" | "submit">
): string | undefined {
  if (!isObject(tx) || !isObject(tx.$tx)) return "Not a transaction";
  const { $namespace, $contract, $expire } = tx.$tx;
  if (typeof $namespace !== "string" || !$namespace.trim()) return "Missing $namespace";
  if (typeof $contract !== "string" || !$contract.trim()) return "Missing $contract";

  const contract = norm($contract.split("@")[0]);
  if (norm($namespace) === "default") {
    if (ALWAYS_REFUSED.includes(contract)) {
      return `default/${contract} is not accepted by a hybrid`;
    }
    if (contract === "onboard" && config.refuseOnboard !== false) {
      return "default/onboard is not accepted by this hybrid";
    }
  }
  // The supernode tests $expire for truthiness, so anything falsy is missing
  if (!$expire) return "A relayed transaction must set $tx.$expire";

  const allowed = config.submit?.contracts;
  if (allowed) {
    const base = $contract.split("@")[0];
    if (!allowed.some((c) => c === $contract || c === base)) {
      return `Contract ${$contract} is not accepted by this hybrid`;
    }
  }
  return;
}

/**
 * The `$umid` the entry supernode gives this transaction
 * (`Endpoints.ExternalInitalise`): `$relay` removed, then the hash of the
 * JSON body before `$datetime` is stamped. That order holds only when
 * `$expire` is set, which is why relaying needs it.
 */
export function computeUmid(tx: any): string {
  const { $relay, ...rest } = tx;
  return ActiveCrypto.Hash.getHash(JSON.stringify(rest));
}

/** Connect-phase failures: the request never reached the upstream */
const UNDELIVERED_CODES =
  /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN|ERR_INVALID_URL)\b/;

type ForwardResult =
  | { kind: "answered"; status: number; body: any }
  | { kind: "undelivered" }
  | { kind: "unanswered" };

/**
 * How a failed submit is read. Only a failure that certainly never reached
 * the upstream lets the hybrid try the next one; anything that may have
 * reached it is "unanswered", because the hybrid never sends a transaction
 * twice. An upstream that answered with an error status and a JSON body
 * produced that answer, so it is passed through.
 */
export function classifyFailure(e: any): ForwardResult {
  if (e?.undelivered === true) return { kind: "undelivered" };
  const kind = e?.kind;
  if (kind === "http" || kind === "refused") {
    if (isObject(e.body) && typeof e.status === "number") {
      return { kind: "answered", status: e.status, body: e.body };
    }
    // Refused without processing it (a proxy, a wrong path)
    if (typeof e.status === "number" && e.status >= 400 && e.status < 500) {
      return { kind: "undelivered" };
    }
    return { kind: "unanswered" };
  }
  const text = `${e?.code ?? ""} ${e?.cause?.code ?? ""} ${e?.message ?? ""}`;
  if ((kind === "network" || kind === undefined) && UNDELIVERED_CODES.test(text)) {
    return { kind: "undelivered" };
  }
  return { kind: "unanswered" };
}

export interface SubmitterOptions {
  config: Pick<IHybridConfig, "refuseOnboard" | "submit">;
  /** Live node state; not ready or outdated answers "unavailable" */
  state: NodeState;
  /** Supernodes then peers; read on every submit so it can change */
  sources: Sources;
  lookup: StreamLookup;
  /** The hybrid's identity: the key pair and its public PEM as registered */
  identity: { pair: ActiveCrypto.KeyPair; publicPem: string };
  /** The local store, for the default dry run */
  db?: ActiveDSConnect;
  /** The local vote. Default `Process.dryRunHybrid(entry, db)`. */
  dryRun?: (entry: ActiveDefinitions.LedgerEntry) => Promise<IExecutionResult>;
  /** How long to wait for an upstream's answer. Default 30s. */
  answerTimeoutMs?: number;
  now?: () => number;
}

const hybrid = (status: number, outcome: HybridOutcome, extra: Record<string, unknown>): SubmitResult => ({
  status,
  body: { $hybrid: outcome, ...extra },
});

/**
 * `POST /`: refuse, check, refresh, vote locally, then relay to a supernode
 * (or a peer that has one) and hand back its answer unchanged. Every
 * response the hybrid makes itself carries `$hybrid`.
 */
export class Submitter {
  private readonly answerTimeoutMs: number;
  private readonly now: () => number;
  private readonly dryRun: (entry: ActiveDefinitions.LedgerEntry) => Promise<IExecutionResult>;

  constructor(private readonly opts: SubmitterOptions) {
    this.answerTimeoutMs = opts.answerTimeoutMs ?? 30000;
    this.now = opts.now ?? Date.now;
    if (opts.dryRun) {
      this.dryRun = opts.dryRun;
    } else {
      const db = opts.db;
      if (!db) throw new Error("Submitter: db or dryRun is required");
      // Loaded on first use: the protocol package brings the whole VM
      this.dryRun = async (entry) => {
        const { ActiveProtocol: P } = await import("@activeledger/activeprotocol");
        return P.Process.dryRunHybrid(entry, db);
      };
    }
  }

  public async submit(tx: unknown): Promise<SubmitResult> {
    // 0. Refusals, before anything else
    const denied = refusal(tx, this.opts.config);
    if (denied) return hybrid(403, "denied", { error: denied });
    const body = tx as any;

    const state = this.opts.state;
    if (!state.ready) {
      return hybrid(503, "unavailable", {
        error: state.reason === "outdated" ? "This hybrid is outdated" : "This hybrid is not ready",
      });
    }

    // 1. $umid, as the entry supernode will compute it, and basic checks
    const clean: any = { ...body };
    delete clean.$relay;
    const umid = computeUmid(clean);
    const basic = this.basicCheck(clean);
    if (basic) return hybrid(422, "refused", { error: basic });

    // 2. Streams to their tips, so a stale copy cannot vote no. Best
    // effort: with no upstream the vote runs on the local copy.
    const ids = this.streamIds(clean);
    if (ids.length) {
      try {
        await this.opts.lookup.refreshToTip(ids);
      } catch {
        // stale copy; the vote below may be stale, which "refused" allows
      }
    }

    // 3. Local dry-run vote, on a copy stamped with the hybrid's clock
    const entry: any = JSON.parse(JSON.stringify(clean));
    entry.$umid = umid;
    entry.$datetime = new Date(this.now());
    let result: IExecutionResult;
    try {
      result = await this.dryRun(entry);
    } catch (e: any) {
      return hybrid(422, "refused", { error: errorText(e) || "Execution failed" });
    }
    const yes = !!result.vote && !!result.committed && !result.error;
    const conditional = !yes && !!result.supernodeDependent;

    // 4. No: the contract's reason, nothing forwarded
    if (!yes && !conditional) {
      return hybrid(422, "refused", { error: result.error || "Vote failed" });
    }

    // 5. Yes or conditional yes: relay
    const forwarded = {
      ...clean,
      $relay: {
        key: this.opts.identity.publicPem,
        sig: ActiveCrypto.signDigest(this.opts.identity.pair, umid),
      },
    };
    const { supernodes, peers } = this.opts.sources;
    for (const up of [...supernodes, ...peers]) {
      const r = await this.forward(up, forwarded);
      if (r.kind === "undelivered") continue;
      if (r.kind === "unanswered") {
        return hybrid(504, "unanswered", { $umid: umid, error: "No answer in time" });
      }
      // 6. The upstream's answer, unchanged
      return { status: r.status, body: r.body };
    }
    return hybrid(503, "unavailable", { error: "No supernode or peer reachable" });
  }

  /** Entry shape, signatures present, `$expire` a date still ahead */
  private basicCheck(tx: any): string | undefined {
    if (!ActiveDefinitions.LedgerTypeChecks.isEntry(tx)) return "Invalid transaction";
    if (!isObject(tx.$sigs)) return "$sigs not found";
    const raw: any = tx.$tx.$expire;
    const expire = new Date(raw);
    if (isNaN(expire.getTime())) return `Invalid $expire : ${raw}`;
    if (expire.getTime() <= this.now()) return `Transaction Expired : ${raw}`;
    return;
  }

  /** Input, output and read-only streams named by the transaction */
  private streamIds(tx: any): string[] {
    const ids = new Set<string>();
    for (const k of ["$i", "$o", "$r"]) {
      if (isObject(tx.$tx[k])) for (const id of Object.keys(tx.$tx[k])) ids.add(id);
    }
    return [...ids];
  }

  private forward(up: Upstream, tx: any): Promise<ForwardResult> {
    return new Promise<ForwardResult>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "unanswered" }), this.answerTimeoutMs);
      let sending: Promise<any>;
      try {
        sending = up.submit(tx);
      } catch (e) {
        sending = Promise.reject(e);
      }
      sending.then(
        (body) => {
          clearTimeout(timer);
          resolve({ kind: "answered", status: 200, body });
        },
        (e) => {
          clearTimeout(timer);
          resolve(classifyFailure(e));
        }
      );
    });
  }
}

const errorText = (e: any): string =>
  typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "";
