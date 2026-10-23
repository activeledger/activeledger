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
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { revPosition, spiConsensus } from "@activeledger/activesync";
import { ContractBuilder, applyExecutionOptions } from "./contracts";
import { writeDivergence } from "./divergence";
import { readDoc, writeAtRev } from "./lookup";
import type {
  ApplyAction,
  ApplyOutcome,
  EventSink,
  HybridStore,
  ItemProcessor,
  LocalVote,
  Sources,
  StreamLookup,
} from "./types";
import type { Upstream } from "./upstream";
import { docHash, quorum, reaches, verifyFeedItem, type VerifyContext } from "./verify";

type IFeedItem = ActiveDefinitions.IFeedItem;
type IRevOut = ActiveDefinitions.IRevOut;
type TDivergenceKind = ActiveDefinitions.TDivergenceKind;
type IExecutionResult = ActiveProtocol.IExecutionResult;
type IDryRunOptions = ActiveProtocol.IDryRunOptions;
type RevsOut = { [id: string]: IRevOut };
type Docs = { [id: string]: any };

/** Runs a transaction as a hybrid without writing (Process.dryRunHybrid) */
export type ExecuteFn = (
  entry: ActiveDefinitions.LedgerEntry,
  db: any,
  options: IDryRunOptions
) => Promise<IExecutionResult>;

export interface ProcessorOptions {
  store: HybridStore;
  /** Where documents and attestations come from. A function, so a changing peer set is seen. */
  sources: Sources | (() => Sources);
  lookup: StreamLookup;
  events: EventSink;
  /** The verification context from the setup stream; undefined before bootstrap */
  context: () => VerifyContext | undefined;
  /** The setup stream document: its `security` is applied before executing */
  setup?: () => any;
  /** Builds contract files. Default one over the store, sources and lookup; null disables. */
  contracts?: ContractBuilder | null;
  /** Default Process.dryRunHybrid */
  execute?: ExecuteFn;
  /** True when this hybrid holds a stream's (shared) volatile */
  volatileHeld?: (streamId: string) => boolean;
  /** SPI: how many hybrid peers to ask. Default 5. */
  spiPeers?: number;
  /** Clock for divergence records */
  now?: () => Date;
}

const canonical = (v: unknown) => ActiveCrypto.canonicalJson(v);
const errorText = (e: unknown) => (e as Error)?.message || String(e);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** `<id>:stream` -> `<id>`, the stream `/h/streams` serves it with */
const baseId = (id: string) => id.split(":")[0];

/**
 * Applies feed items, "Processing a feed item" steps 1-4. Ordering (step 5)
 * is the ItemOrderer's job: items sharing streams must reach apply() in
 * `$revs` order and never concurrently.
 */
export class Processor implements ItemProcessor {
  private readonly execute: ExecuteFn;
  private readonly contracts: ContractBuilder | null;
  /** Recently settled items, `<outcome>:<umid>` */
  private readonly done = new Set<string>();

  constructor(private readonly options: ProcessorOptions) {
    this.execute =
      options.execute ??
      ((entry, db, opts) => ActiveProtocol.Process.dryRunHybrid(entry, db, opts));
    this.contracts =
      options.contracts === undefined
        ? new ContractBuilder({ store: options.store, sources: options.sources, lookup: options.lookup })
        : options.contracts;
  }

  private sources(): Sources {
    const s = this.options.sources;
    return typeof s === "function" ? s() : s;
  }

  private get data() {
    return this.options.store.data;
  }

  public async apply(item: IFeedItem, from: Upstream): Promise<ApplyOutcome> {
    try {
      return await this.applyItem(item, from);
    } catch (e) {
      // Never block the feed on one item
      ActiveLogger.error(e, `Hybrid apply ${item?.umid} failed`);
      return outcome(item?.umid, "dropped", "no", [`apply failed: ${errorText(e)}`]);
    }
  }

  private async applyItem(item: IFeedItem, from: Upstream): Promise<ApplyOutcome> {
    const ctx = this.options.context();
    if (!ctx) return outcome(item?.umid, "dropped", "no", ["not bootstrapped"]);

    // 1. Verify
    const check = verifyFeedItem(item, ctx);
    if (!check.ok) {
      ActiveLogger.warn(`Dropped feed item ${item?.umid} from ${from?.id}: ${check.reasons.join("; ")}`);
      return outcome(item?.umid, "dropped", "no", check.reasons);
    }
    if (this.done.has(`${item.outcome}:${item.umid}`)) {
      return outcome(item.umid, "settled", item.outcome === "committed" ? "yes" : "no", ["already applied"]);
    }
    const tallied = { yes: check.yes, no: check.no };
    const result =
      item.outcome === "committed"
        ? await this.committed(item, ctx, tallied)
        : await this.failed(item, ctx, tallied, from);
    if (result.action !== "dropped") this.remember(`${item.outcome}:${item.umid}`);
    return result;
  }

  private remember(key: string): void {
    this.done.add(key);
    if (this.done.size > 10000) {
      const first = this.done.values().next().value;
      if (first !== undefined) this.done.delete(first);
    }
  }

  // #region committed

  private async committed(
    item: IFeedItem,
    ctx: VerifyContext,
    tallied: { yes: number; no: number }
  ): Promise<ApplyOutcome> {
    const umid = item.umid;
    const att = item.attestation as ActiveDefinitions.ICommitAttestation;
    const revsOut: RevsOut = att.revsOut || {};
    if (docHash(item.umidDoc) !== att.umidDocHash) {
      return outcome(umid, "dropped", "no", ["umid doc does not match the attestation's umidDocHash"]);
    }

    // Already applied: its :umid doc is here, or every output is already at the attested revision
    if (await readDoc(this.data, `${umid}:umid`)) {
      return outcome(umid, "settled", "yes", ["already applied"]);
    }
    if (Object.keys(revsOut).length && (await this.mismatched(revsOut, [])).length === 0) {
      await this.writeUmidDoc(item);
      return outcome(umid, "settled", "yes", ["outputs already at the attested revisions"]);
    }

    // 2. Prepare inputs
    const missing = await this.prepare(item);
    if (missing.length) {
      return outcome(umid, "dropped", "no", [`streams not available at $revs: ${missing.join(", ")}`]);
    }
    const before = await this.snapshot(item, revsOut);
    const entry = item.umidDoc.umid as ActiveDefinitions.LedgerEntry;

    // 3. Execute (an error is retried once)
    let result: IExecutionResult | undefined;
    let execError = "";
    try {
      result = await this.run(entry);
    } catch (e1) {
      ActiveLogger.warn(`Execution of ${umid} failed, retrying: ${errorText(e1)}`);
      try {
        result = await this.run(entry);
      } catch (e2) {
        execError = errorText(e2);
      }
    }
    if (!result) {
      return this.repair(item, ctx, tallied, before, [], "execution-error", { error: execError });
    }

    // Save with the store's own revision assignment, then read back
    const touched = result.committed ? await this.saveLocal(result) : [];
    const wrong = result.committed ? await this.mismatched(revsOut, touched) : ["not committed locally"];
    const localSummary = await this.summary(result, touched);

    if (!wrong.length) {
      const reasons: string[] = [];
      let divergence: ActiveDefinitions.IDivergenceRecord | undefined;
      // The :umid doc is never built locally; its execution parts are compared
      if (
        result.umidDoc &&
        !result.supernodeDependent &&
        canonical(executionParts(result.umidDoc)) !== canonical(executionParts(item.umidDoc))
      ) {
        reasons.push("local :umid doc streams/events differ from the received doc");
        divergence = await this.diverge(item, "umid-doc-mismatch", tallied, localSummary.result, localSummary.revs);
      }
      await this.finishCommitted(item, revsOut, result);
      return { ...outcome(umid, "saved", "yes", reasons), ...(divergence ? { divergence } : {}) };
    }

    // Mismatch
    if (result.supernodeDependent) {
      return this.adopt(item, ctx, tallied, result, before, touched, localSummary);
    }
    return this.repair(item, ctx, tallied, before, touched, "output-mismatch", {
      ...localSummary.result,
      mismatched: wrong,
    }, localSummary.revs);
  }

  /**
   * Adopt mode: the execution was supernode-dependent, so the attested
   * outputs are saved in place of the local ones once a quorum of matching
   * commit attestations backs them and the safety net passes.
   */
  private async adopt(
    item: IFeedItem,
    ctx: VerifyContext,
    tallied: { yes: number; no: number },
    result: IExecutionResult,
    before: Docs,
    touched: string[],
    local: { result: any; revs: ActiveDefinitions.LedgerRevs }
  ): Promise<ApplyOutcome> {
    const umid = item.umid;
    const revsOut: RevsOut = (item.attestation as ActiveDefinitions.ICommitAttestation).revsOut;
    const q = await this.gatherQuorum(item, ctx);
    if (!q.reached) {
      await this.rollback(before, touched);
      return outcome(umid, "dropped", "no", [
        `adopt needs ${ctx.reachedPercent}% matching commit attestations, have ${q.count}/${ctx.networkSize}`,
      ]);
    }
    const fetched = await this.fetchSigned(revsOut);
    if (fetched.missing.length) {
      await this.rollback(before, touched);
      return outcome(umid, "dropped", "no", [
        `attested outputs not available: ${fetched.missing.join(", ")}`,
      ]);
    }
    const verdict = ActiveProtocol.checkAdopt({
      umid,
      signed: fetched.docs,
      local: result.documents,
      before,
      declarations: result.adopt || [],
      supernodeDependent: true,
    });

    if (!(await this.writeDocs(fetched.docs, before, touched))) {
      await this.rollback(before, touched);
      return outcome(umid, "dropped", "no", ["writing the attested outputs failed"]);
    }

    if (verdict.ok) {
      const warnings: string[] = [];
      if (verdict.mode === "undeclared") {
        warnings.push("adopt.undeclared");
        await this.emit({
          type: "adopt.undeclared",
          contract: entryOf(item)?.$tx?.$contract,
          umid,
          payload: {
            contract: entryOf(item)?.$tx?.$contract,
            entry: entryOf(item)?.$tx?.$entry ?? null,
            dependence: result.dependence || [],
          },
        });
      }
      await this.finishCommitted(item, revsOut, result, fetched.docs);
      return { ...outcome(umid, "adopted", "yes", []), warnings };
    }

    // A real divergence: the outputs are quorum-signed, so the fetched
    // documents already satisfy SPI from a single source
    const divergence = await this.diverge(
      item,
      "adopt-rejected",
      tallied,
      { ...local.result, adoptReasons: verdict.reasons },
      local.revs
    );
    await this.finishCommitted(item, revsOut, undefined, fetched.docs);
    return { ...outcome(umid, "repaired", "yes", verdict.reasons), divergence };
  }

  /**
   * SPI repair (section 3, "SPI across hybrids"): adopt the attested state
   * and write a divergence record in every case. Vote yes once repaired.
   */
  private async repair(
    item: IFeedItem,
    ctx: VerifyContext,
    tallied: { yes: number; no: number },
    before: Docs,
    touched: string[],
    kind: TDivergenceKind,
    localResult: unknown,
    localRevs?: ActiveDefinitions.LedgerRevs
  ): Promise<ApplyOutcome> {
    const umid = item.umid;
    const revsOut: RevsOut = (item.attestation as ActiveDefinitions.ICommitAttestation).revsOut;
    const q = await this.gatherQuorum(item, ctx);
    const spi = await this.spi(revsOut, q.reached);

    if (spi.missing.length || !(await this.writeDocs(spi.docs, before, touched))) {
      await this.rollback(before, touched);
      const reasons = [`SPI could not repair: ${spi.missing.join(", ") || "write failed"}`];
      const divergence = await this.diverge(item, kind, tallied, { ...(localResult as any), spi: reasons }, localRevs);
      return { ...outcome(umid, "dropped", "no", reasons), divergence };
    }
    const divergence = await this.diverge(item, kind, tallied, localResult, localRevs);
    await this.finishCommitted(item, revsOut, undefined, spi.docs);
    return { ...outcome(umid, "repaired", "yes", [`repaired by SPI (${kind})`]), divergence };
  }

  /** Write the :umid doc, local volatile, contract files and events of a committed item */
  private async finishCommitted(
    item: IFeedItem,
    revsOut: RevsOut,
    result?: IExecutionResult,
    written?: Docs
  ): Promise<void> {
    await this.writeUmidDoc(item);
    if (result && result.volatile && Object.keys(result.volatile).length) {
      // Per-node by design; never attested
      await this.data.bulkDocs(Object.values(clone(result.volatile)), { new_edits: true });
    }
    if (this.contracts) {
      const ids = Object.keys(written ?? revsOut).filter((id) => !id.includes(":"));
      const docs: any[] = [];
      for (const id of ids) {
        const doc = await readDoc(this.data, id);
        if (doc) docs.push(doc);
      }
      await this.contracts.onWritten(docs);
    }
    // The contract's events as agreed (the :umid doc carries them)
    const events = Array.isArray(item.umidDoc?.events) ? item.umidDoc.events : result?.events || [];
    await this.emitContractEvents(item, events);
    await this.emit({
      type: "tx.committed",
      umid: item.umid,
      contract: entryOf(item)?.$tx?.$contract,
    });
  }

  /** The received :umid doc, byte-for-byte, after checking its hash */
  private async writeUmidDoc(item: IFeedItem): Promise<void> {
    const doc = item.umidDoc;
    if (!doc || docHash(doc) !== item.attestation?.umidDocHash) {
      throw new Error(`${item.umid}: umid doc does not match umidDocHash`);
    }
    if (!(await writeAtRev(this.data, clone(doc)))) {
      throw new Error(`${item.umid}: writing the :umid doc failed`);
    }
  }

  // #endregion

  // #region failed

  private async failed(
    item: IFeedItem,
    ctx: VerifyContext,
    tallied: { yes: number; no: number },
    from: Upstream
  ): Promise<ApplyOutcome> {
    const umid = item.umid;
    if (!item.tx || typeof item.tx !== "object" || !item.tx.$tx) {
      return outcome(umid, "dropped", "no", ["failed item carries no transaction"]);
    }

    // A failed item whose valid yes votes reach consensus contradicts
    // itself. Ask another upstream before trusting it.
    if (reaches(tallied.yes, ctx.reachedPercent, ctx.networkSize)) {
      const { supernodes, peers } = this.sources();
      let asked = false;
      for (const source of [...supernodes, ...peers]) {
        if (source === from || source.id === from?.id) continue;
        try {
          const doc = await source.umid(umid);
          asked = true;
          if (doc?.umid?.$umid === umid) {
            return outcome(umid, "dropped", "no", [
              `failed item reaches consensus and ${source.id} shows it committed`,
            ]);
          }
          break;
        } catch {
          // Try the next
        }
      }
      if (!asked) {
        return outcome(umid, "dropped", "no", [
          "failed item reaches consensus and no other upstream could confirm it",
        ]);
      }
    }

    const missing = await this.prepare(item);
    if (missing.length) {
      return outcome(umid, "dropped", "no", [`streams not available at $revs: ${missing.join(", ")}`]);
    }

    const entry = { ...item.tx, $revs: item.$revs } as ActiveDefinitions.LedgerEntry;
    let result: IExecutionResult | undefined;
    let execError = "";
    try {
      result = await this.run(entry);
    } catch (e1) {
      try {
        result = await this.run(entry);
      } catch (e2) {
        execError = errorText(e2);
      }
    }
    await this.emit({ type: "tx.failed", umid, contract: item.tx.$tx.$contract });

    if (!result) {
      const divergence = await this.diverge(item, "execution-error", tallied, { error: execError });
      return { ...outcome(umid, "recorded", "no", [`execution error: ${execError}`]), divergence };
    }
    const passed = result.vote && result.committed;
    if (passed && !result.supernodeDependent) {
      const divergence = await this.diverge(item, "failed-but-passed", tallied, (await this.summary(result, [])).result);
      return { ...outcome(umid, "recorded", "yes", ["passed locally"]), divergence };
    }
    return outcome(
      umid,
      "recorded",
      result.supernodeDependent ? "conditional" : "no",
      result.supernodeDependent ? ["supernode-dependent; not judged"] : []
    );
  }

  // #endregion

  // #region helpers

  /** Every input and output stream at exactly the item's `$revs` */
  private async prepare(item: IFeedItem): Promise<string[]> {
    const wanted: { id: string; rev?: string }[] = [];
    for (const side of [item.$revs?.$i, item.$revs?.$o]) {
      for (const id of Object.keys(side || {})) wanted.push({ id, rev: (side as any)[id] });
    }
    if (!wanted.length) return [];
    return (await this.options.lookup.ensure(wanted)).missing;
  }

  /** Local documents an item may change, before it runs */
  private async snapshot(item: IFeedItem, revsOut: RevsOut): Promise<Docs> {
    const ids = new Set<string>(Object.keys(revsOut));
    for (const side of [item.$revs?.$i, item.$revs?.$o]) {
      for (const id of Object.keys(side || {})) {
        ids.add(id);
        ids.add(`${id}:stream`);
      }
    }
    const out: Docs = {};
    for (const id of ids) {
      const doc = await readDoc(this.data, id);
      if (doc) out[id] = doc;
    }
    return out;
  }

  private async run(entry: ActiveDefinitions.LedgerEntry): Promise<IExecutionResult> {
    if (this.options.setup) applyExecutionOptions(this.options.setup());
    if (this.contracts) await this.contracts.ensureFor(entry);
    return this.execute(entry, this.data, { volatileHeld: this.options.volatileHeld });
  }

  /** Save the local result with normal revision assignment; resolves with the ids written */
  private async saveLocal(result: IExecutionResult): Promise<string[]> {
    const docs = Object.values(clone(result.documents || {})).filter((d: any) => d && d._id);
    if (!docs.length) return [];
    const r = await this.data.bulkDocs(docs, { new_edits: true });
    if (r?.ok !== true) ActiveLogger.warn(`Saving local result failed`);
    return docs.map((d: any) => d._id);
  }

  /** Ids whose stored document is not the attested one, plus local writes nothing attests */
  private async mismatched(revsOut: RevsOut, written: string[]): Promise<string[]> {
    const wrong: string[] = [];
    for (const id of Object.keys(revsOut)) {
      const stored = await readDoc(this.data, id);
      if (!ActiveProtocol.matchesRevOut(stored, revsOut[id])) wrong.push(id);
    }
    for (const id of written) if (!revsOut[id]) wrong.push(id);
    return wrong;
  }

  /** What the local execution produced, for a divergence record */
  private async summary(
    result: IExecutionResult,
    touched: string[]
  ): Promise<{ result: any; revs: ActiveDefinitions.LedgerRevs }> {
    const outputs: RevsOut = {};
    const $o: { [id: string]: string } = {};
    for (const id of touched) {
      const doc = await readDoc(this.data, id);
      if (doc) {
        outputs[id] = { rev: doc._rev, sha256: docHash(doc) };
        $o[id] = doc._rev;
      }
    }
    return {
      result: {
        vote: result.vote,
        committed: result.committed,
        ...(result.error ? { error: result.error } : {}),
        supernodeDependent: result.supernodeDependent,
        dependence: result.dependence || [],
        outputs,
      },
      revs: { $i: {}, $o },
    };
  }

  /** Put documents back as they were before the item ran */
  private async rollback(before: Docs, touched: string[]): Promise<void> {
    for (const id of touched) {
      try {
        if (before[id]) await writeAtRev(this.data, before[id]);
        else if (await readDoc(this.data, id)) await this.data.purge({ _id: id });
      } catch (e) {
        ActiveLogger.error(e, `Rollback of ${id} failed`);
      }
    }
  }

  /**
   * Write documents at their network revisions; local writes that are not
   * among them are put back as they were.
   */
  private async writeDocs(docs: Docs, before: Docs, touched: string[]): Promise<boolean> {
    let ok = true;
    // Meta before state, so a reader that finds the state finds its meta
    const ids = Object.keys(docs).sort((a, b) => Number(b.includes(":")) - Number(a.includes(":")));
    for (const id of ids) {
      if (!(await writeAtRev(this.data, clone(docs[id])))) ok = false;
    }
    await this.rollback(before, touched.filter((id) => !docs[id]));
    return ok;
  }

  /**
   * `consensus.reached` matching commit attestations: the item's own, those
   * a relaying hybrid gathered, then `GET /h/attest/:umid` from supernodes
   * until a quorum agrees with the item's claim. One is never enough.
   */
  private async gatherQuorum(
    item: IFeedItem,
    ctx: VerifyContext
  ): Promise<{ reached: boolean; count: number }> {
    const att = item.attestation as ActiveDefinitions.ICommitAttestation;
    const all: ActiveDefinitions.ICommitAttestation[] = [att, ...(Array.isArray(item.attestations) ? item.attestations : [])];
    const agrees = () => {
      const q = quorum(all, item.$revs, ctx.keys, ctx.reachedPercent, ctx.networkSize);
      const same =
        q.agreed.length > 0 &&
        canonical(q.agreed[0].revsOut) === canonical(att.revsOut) &&
        q.agreed[0].umidDocHash === att.umidDocHash &&
        q.agreed[0].outcome === "committed";
      return { reached: q.reached && same, count: same ? q.count : 0 };
    };
    let q = agrees();
    for (const source of this.sources().supernodes) {
      if (q.reached) break;
      try {
        const a = await source.attest(item.umid);
        if (a) {
          all.push(a);
          q = agrees();
        }
      } catch {
        // Try the next
      }
    }
    return q;
  }

  /** Requests that fetch every attested document (`:stream` meta comes with its state) */
  private static requests(revsOut: RevsOut, atRev: boolean): { id: string; rev?: string }[] {
    const reqs = new Map<string, { id: string; rev?: string }>();
    for (const id of Object.keys(revsOut)) {
      const base = baseId(id);
      if (reqs.has(base)) continue;
      reqs.set(base, atRev && revsOut[base] ? { id: base, rev: revsOut[base].rev } : { id: base });
    }
    return [...reqs.values()];
  }

  private static index(docs: unknown): Map<string, any[]> {
    const out = new Map<string, any[]>();
    for (const d of Array.isArray(docs) ? docs : []) {
      if (d && typeof d._id === "string") out.set(d._id, [...(out.get(d._id) ?? []), d]);
    }
    return out;
  }

  /** Each attested output by {id, rev} from peers, then supernodes, checked against revsOut */
  private async fetchSigned(revsOut: RevsOut): Promise<{ docs: Docs; missing: string[] }> {
    const docs: Docs = {};
    const { peers, supernodes } = this.sources();
    for (const source of [...peers, ...supernodes]) {
      const left = Object.keys(revsOut).filter((id) => !docs[id]);
      if (!left.length) break;
      const want: RevsOut = {};
      for (const id of left) want[id] = revsOut[id];
      try {
        const r = await source.streams(Processor.requests(want, true));
        const byId = Processor.index(r?.docs);
        for (const id of left) {
          const doc = (byId.get(id) ?? []).find((d) => ActiveProtocol.matchesRevOut(d, revsOut[id]));
          if (doc) docs[id] = doc;
        }
      } catch (e) {
        ActiveLogger.warn(`Fetch of attested outputs from ${source.id} failed: ${errorText(e)}`);
      }
    }
    return { docs, missing: Object.keys(revsOut).filter((id) => !docs[id]) };
  }

  /**
   * SPI across hybrids:
   * 1. ask up to 5 peers for {id, rev};
   * 2. accept what a majority of them agree on when it matches the signed
   *    revsOut, or a single match when revsOut is quorum-signed;
   * 3. otherwise escalate to the supernodes and take the majority by
   *    revision (spiConsensus), as restore does.
   */
  private async spi(revsOut: RevsOut, quorumSigned: boolean): Promise<{ docs: Docs; missing: string[] }> {
    const docs: Docs = {};
    const ids = Object.keys(revsOut);
    const { peers, supernodes } = this.sources();

    const ask = (sources: Upstream[], atRev: boolean) =>
      Promise.all(
        sources.map((s) =>
          s
            .streams(Processor.requests(revsOut, atRev))
            .then((r) => (Array.isArray(r?.docs) ? r.docs : undefined))
            .catch(() => undefined)
        )
      ).then((all) => all.filter((a): a is any[] => Array.isArray(a)));

    const asked = peers.slice(0, this.options.spiPeers ?? 5);
    if (asked.length) {
      const answers = (await ask(asked, true)).map((a) => Processor.index(a));
      for (const id of ids) {
        const matching = answers.filter((a) =>
          (a.get(id) ?? []).some((d) => ActiveProtocol.matchesRevOut(d, revsOut[id]))
        );
        if (matching.length && (quorumSigned || matching.length > answers.length / 2)) {
          docs[id] = (matching[0].get(id) as any[]).find((d) => ActiveProtocol.matchesRevOut(d, revsOut[id]));
        }
      }
    }

    let left = ids.filter((id) => !docs[id]);
    if (left.length && supernodes.length) {
      const answers = await ask(supernodes, false);
      const indexed = answers.map((a) => Processor.index(a));
      if (quorumSigned) {
        for (const id of left) {
          for (const a of indexed) {
            const d = (a.get(id) ?? []).find((x) => ActiveProtocol.matchesRevOut(x, revsOut[id]));
            if (d) {
              docs[id] = d;
              break;
            }
          }
        }
        left = left.filter((id) => !docs[id]);
      }
      if (left.length && answers.length) {
        const { winners } = spiConsensus(answers, Math.floor(answers.length / 2) + 1);
        for (const id of left) {
          const w = winners[id];
          if (!w) continue;
          if (w.rev === revsOut[id].rev) {
            // Same revision: the content must be the attested one
            for (const a of indexed) {
              const d = (a.get(id) ?? []).find((x) => ActiveProtocol.matchesRevOut(x, revsOut[id]));
              if (d) {
                docs[id] = d;
                break;
              }
            }
          } else if (revPosition(w.rev) > revPosition(revsOut[id].rev)) {
            // The network has moved on; its majority revision is the repair
            docs[id] = w.doc;
          }
        }
      }
    }
    return { docs, missing: ids.filter((id) => !docs[id]) };
  }

  private async diverge(
    item: IFeedItem,
    kind: TDivergenceKind,
    tallied: { yes: number; no: number },
    localResult: unknown,
    localRevs?: ActiveDefinitions.LedgerRevs
  ): Promise<ActiveDefinitions.IDivergenceRecord> {
    const record: ActiveDefinitions.IDivergenceRecord = {
      umid: item.umid,
      kind,
      supernodeTally: tallied,
      localResult,
      $revs: item.$revs,
      ...(item.attestation?.revsOut ? { revsOut: item.attestation.revsOut } : {}),
      ...(localRevs ? { localRevs } : {}),
      at: (this.options.now ? this.options.now() : new Date()).toISOString(),
    };
    try {
      await writeDivergence(this.options.store, record);
    } catch (e) {
      ActiveLogger.error(e, `Divergence record for ${item.umid} not written`);
    }
    await this.emit({
      type: "divergence",
      umid: item.umid,
      contract: entryOf(item)?.$tx?.$contract,
      payload: { kind },
    });
    return record;
  }

  private async emitContractEvents(item: IFeedItem, events: any[]): Promise<void> {
    for (const ev of events) {
      if (!ev || typeof ev.name !== "string") continue;
      await this.emit({
        type: ev.name,
        contract: ev.contract ?? entryOf(item)?.$tx?.$contract,
        umid: item.umid,
        payload:
          ev.data && typeof ev.data === "object" && !Array.isArray(ev.data)
            ? ev.data
            : { data: ev.data },
      });
    }
  }

  private async emit(event: Parameters<EventSink["emit"]>[0]): Promise<void> {
    try {
      await this.options.events.emit(event);
    } catch (e) {
      ActiveLogger.error(e, `Event ${event.type} for ${event.umid} not emitted`);
    }
  }

  // #endregion
}

/**
 * The parts of a :umid doc the execution decides: its streams and events.
 * An event's `_id` carries the emitting node's clock (EventEngine), so it
 * is left out.
 */
const executionParts = (umidDoc: any) => ({
  streams: umidDoc?.streams,
  events: Array.isArray(umidDoc?.events)
    ? umidDoc.events.map((e: any) => {
        if (!e || typeof e !== "object") return e;
        const { _id, ...rest } = e;
        return rest;
      })
    : umidDoc?.events,
});

/** The transaction entry of an item: the :umid doc's for committed, `tx` for failed */
const entryOf = (item: IFeedItem): any => item?.umidDoc?.umid ?? item?.tx;

function outcome(umid: string, action: ApplyAction, vote: LocalVote, reasons: string[]): ApplyOutcome {
  return { umid, action, vote, warnings: [], reasons };
}
