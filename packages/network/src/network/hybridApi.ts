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

/** What the registry stream of one hybrid holds, as the API needs it */
export interface RegisteredHybrid {
  /** The hybrid's public key, PEM */
  key: string;
  type: string;
  endpoints: ActiveDefinitions.IHybridEndpoint[];
  label?: string;
  retired?: boolean;
}

export interface HybridRegistry {
  lookup(keyHash: string): Promise<RegisteredHybrid | undefined>;
  list(): Promise<(RegisteredHybrid & { keyHash: string })[]>;
}

/** The slice of a database the hybrid API reads */
export interface HybridDb {
  get(id: string): Promise<any>;
  allDocs(options: {
    startkey?: string;
    endkey?: string;
    limit?: number;
    include_docs?: boolean;
    keys?: string[];
  }): Promise<any>;
}

/** Pages of feed keys one `feedSince` call may walk while looking for an item */
const FEED_SCAN_PAGES = 20;

export interface HybridApiDeps {
  db: HybridDb;
  events: HybridDb;
  registry: HybridRegistry;
  /** On-ledger `hybrid` section, read live so a reassert is noticed */
  ledgerConfig: () => Partial<ActiveDefinitions.IHybridLedgerConfig>;
  /** The setup stream id, `network` option without its revision */
  setupStreamId: () => string;
  /** Key hashes refused on this supernode only */
  banned: () => Set<string>;
  /** Seconds either side of now a signed request may be */
  authWindowSeconds?: number;
  /** Seconds after a feed key's time before a missing attestation is final */
  attestGraceSeconds?: number;
  now?: () => number;
}

export interface AuthOk {
  ok: true;
  keyHash: string;
  hybrid: RegisteredHybrid;
}
export interface AuthFail {
  ok: false;
  status: number;
  reason: string;
}

/**
 * Parse a document from a `get`, treating the storage engine's error object
 * (which it resolves with instead of throwing) as not found
 */
const found = (doc: any): any | undefined =>
  doc && doc._id && !doc.error ? doc : undefined;

const safeGet = async (db: HybridDb, id: string): Promise<any | undefined> => {
  try {
    return found(await db.get(id));
  } catch {
    return undefined;
  }
};

/** `umid:<ms>,<umid>` or `fail:<ms>,<umid>` -> `<ms>,<umid>` */
export const cursorSuffix = (cursor: string): string =>
  cursor.replace(/^(umid|fail):/, "");

/**
 * The supernode side of `/h/*`. Transport free: the HTTP layer authenticates
 * with `authenticate`, then calls one method per endpoint.
 */
export class HybridApi {
  /** `key:timestamp` already accepted, until its window closes, so none works twice */
  private used = new Map<string, number>();

  constructor(private deps: HybridApiDeps) {}

  /**
   * Signed-request auth: headers carry the key hash, a timestamp and a
   * signature over `${keyHash}:${timestamp}` made with the registered key.
   */
  public async authenticate(headers: {
    key?: string;
    timestamp?: string;
    signature?: string;
  }): Promise<AuthOk | AuthFail> {
    const { key, timestamp, signature } = headers;
    if (!key || !timestamp || !signature) {
      return { ok: false, status: 401, reason: "missing auth headers" };
    }
    if (this.deps.banned().has(key)) {
      return { ok: false, status: 403, reason: "key is banned on this node" };
    }
    const hybrid = await this.deps.registry.lookup(key);
    if (!hybrid) {
      return { ok: false, status: 403, reason: "key is not registered" };
    }
    if (hybrid.retired) {
      return { ok: false, status: 403, reason: "key is retired" };
    }
    const verified = ActiveCrypto.verifyRequest(
      hybrid.key,
      hybrid.type,
      { key, timestamp: Number(timestamp), signature },
      this.deps.authWindowSeconds ?? 60
    );
    if (!verified) {
      return { ok: false, status: 401, reason: "bad signature or timestamp" };
    }
    // Once only: a captured header replayed inside its window must not
    // authenticate (it could otherwise evict the real owner's feed).
    //
    // Keyed on what was signed, not on the signature: the same signature
    // has more than one valid encoding (base64 variants, ECDSA high-S), so
    // a re-encoded copy would slip past a check on the signature text.
    // That makes one accepted request per key per timestamp, so a client
    // must not sign two requests with the same millisecond.
    //
    // Held one tick past the last instant verifyRequest still accepts. This
    // is per process: a replay sent to a different supernode is not seen
    // here, which is what the timestamp window and TLS are for.
    const now = Date.now();
    const windowMs = (this.deps.authWindowSeconds ?? 60) * 1000;
    for (const [id, expiry] of this.used) {
      if (expiry >= now) break;
      this.used.delete(id);
    }
    const id = `${key}:${Number(timestamp)}`;
    if (this.used.has(id)) {
      return { ok: false, status: 401, reason: "replayed request" };
    }
    this.used.set(id, Math.max(now, Number(timestamp)) + windowMs + 1);
    return { ok: true, keyHash: key, hybrid };
  }

  /** Is this key still allowed? Checked while a long-lived feed is open. */
  public async stillAllowed(keyHash: string): Promise<boolean> {
    if (this.deps.banned().has(keyHash)) return false;
    const hybrid = await this.deps.registry.lookup(keyHash);
    return !!hybrid && !hybrid.retired;
  }

  /** The on-ledger `hybrid.minVersion`, sent with heartbeats so a running hybrid learns a raised one */
  public minVersion(): string | undefined {
    return this.deps.ledgerConfig().minVersion;
  }

  /** `GET /h/bootstrap` */
  public async bootstrap(): Promise<any> {
    const cfg = this.deps.ledgerConfig();
    const setup = await safeGet(this.deps.db, this.deps.setupStreamId());
    return {
      setup,
      required: cfg.required ?? [],
      window: cfg.window,
      minVersion: cfg.minVersion,
      contracts: await this.contractIds(),
      cursor: await this.head(),
    };
  }

  /**
   * The newest feed cursor, or "" on an empty ledger.
   *
   * allDocs only reads forward, so this widens a time window until it finds
   * a key rather than scanning the whole index: the keys start with their
   * millisecond time, so a window is just a start key.
   */
  public async head(now: number = Date.now()): Promise<string> {
    const windows = [3600e3, 86400e3, 30 * 86400e3, now];
    for (const span of windows) {
      let last = "";
      for (const prefix of ["umid", "fail"]) {
        let start = `${prefix}:${Math.max(0, now - span)}`;
        for (;;) {
          const r = await this.deps.events.allDocs({
            startkey: start,
            endkey: `${prefix}:x`,
            limit: 1000,
          });
          const ids: string[] = (r?.rows ?? []).map((x: any) => x._id ?? x.id);
          if (!ids.length) break;
          const tail = ids[ids.length - 1];
          if (cursorSuffix(tail) > cursorSuffix(last)) last = tail;
          if (ids.length < 1000) break;
          start = tail;
        }
      }
      if (last) return last;
    }
    return "";
  }

  /** Contract stream ids: state documents that carry a compiled contract */
  private async contractIds(): Promise<string[]> {
    const ids: string[] = [];
    let start: string | undefined;
    for (;;) {
      const r = await this.deps.db.allDocs({
        ...(start ? { startkey: start } : {}),
        limit: 500,
        include_docs: true,
      });
      const rows: any[] = r?.rows ?? [];
      for (const row of rows) {
        const d = row.doc ?? row;
        if (row.id === start || d._id === start) continue;
        if (d?.namespace && d?.contract && d?.compiled) ids.push(d._id);
      }
      if (rows.length < 500) break;
      start = rows[rows.length - 1].id ?? rows[rows.length - 1]._id;
    }
    return ids;
  }

  /**
   * `POST /h/streams`: state and meta for the requested streams. Volatile is
   * per node and is never served.
   */
  public async streams(
    requests: { id: string; rev?: string }[]
  ): Promise<{ docs: any[]; missing: { id: string; rev?: string }[] }> {
    const docs: any[] = [];
    const missing: { id: string; rev?: string }[] = [];
    for (const req of requests) {
      // A stream id only. A suffix (":volatile", ":stream", ":umid") would
      // read a different document, and a leading "_" reaches the database's
      // own documents.
      // The one suffix allowed is a contract's own data document, which is
      // in revsOut and so has to be fetchable; it has no meta
      const isData = typeof req.id === "string" && req.id.endsWith(":data");
      const base = isData ? req.id.slice(0, -":data".length) : req.id;
      if (!HybridApi.isStreamId(base)) {
        missing.push(req);
        continue;
      }
      const state = await safeGet(this.deps.db, req.id);
      if (!state || (req.rev && state._rev !== req.rev)) {
        missing.push(req);
        continue;
      }
      docs.push(state);
      if (isData) continue;
      const meta = await safeGet(this.deps.db, `${req.id}:stream`);
      if (meta) docs.push(meta);
    }
    return { docs, missing };
  }

  /** Stream ids are hashes or 0x addresses: no ":" suffix, no "_" internals */
  public static isStreamId(id: unknown): id is string {
    return (
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= 128 &&
      /^[A-Za-z0-9.@-][A-Za-z0-9._@-]*$/.test(id)
    );
  }

  /** `GET /h/umid/:umid` */
  public async umid(umid: string): Promise<any | undefined> {
    if (!HybridApi.isStreamId(umid)) return undefined;
    return safeGet(this.deps.db, `${umid}:umid`);
  }

  /** `GET /h/attest/:umid`: this supernode's commit attestation */
  public async attest(umid: string): Promise<any | undefined> {
    if (!HybridApi.isStreamId(umid)) return undefined;
    const doc = await safeGet(this.deps.events, `attest:${umid}`);
    if (!doc) return undefined;
    const { _id, _rev, nodes, ...attestation } = doc;
    return attestation;
  }

  /** `GET /h/peers`: the registered, non-retired hybrids */
  public async peers(): Promise<any[]> {
    return (await this.deps.registry.list())
      .filter((h) => !h.retired)
      .map((h) => ({
        keyHash: h.keyHash,
        key: h.key,
        type: h.type,
        endpoints: h.endpoints,
        label: h.label,
      }));
  }

  /**
   * Feed items after a cursor, oldest first. Committed and failed items share
   * one ordering by `<ms>,<umid>`, so one cursor covers both.
   */
  private readonly deadRuns = new Map<string, string>();

  public async feedSince(
    cursor: string,
    limit = 50
  ): Promise<{ cursor: string; item: ActiveDefinitions.IFeedItem }[]> {
    const out: { cursor: string; item: ActiveDefinitions.IFeedItem }[] = [];
    const start = cursorSuffix(cursor || "");
    // A run of dead keys found from here before is not walked again
    let after = this.deadRuns.get(start) ?? start;
    let pages = 0;
    // A page made only of keys that will never have an item is walked past
    for (;;) {
      // Bounded per call, so a long run of dead keys costs a few pages a poll
      // and is crossed over successive polls rather than all at once
      if (++pages > FEED_SCAN_PAGES) return this.rememberDead(start, after, out);
      const keys: string[] = [];
      for (const prefix of ["umid", "fail"]) {
        const r = await this.deps.events.allDocs({
          startkey: `${prefix}:${after}`,
          // allDocs swaps the last character for a high one, so this spans the prefix
          endkey: `${prefix}:x`,
          limit: limit + 1,
        });
        for (const row of r?.rows ?? []) {
          const id: string = row._id ?? row.id;
          if (id && cursorSuffix(id) > after) keys.push(id);
        }
      }
      keys.sort((a, b) => (cursorSuffix(a) < cursorSuffix(b) ? -1 : 1));
      if (!keys.length) return this.rememberDead(start, after, out);

      for (const key of keys.slice(0, limit - out.length)) {
        const item = await this.buildItem(key);
        if (item) {
          out.push({ cursor: key, item });
          after = cursorSuffix(key);
          continue;
        }
        // Documents not written yet are the end of what is ready, but a key
        // that has stayed without them (a restored umid, a commit from before
        // attestations, a failed attestation write) never will: step past it
        // rather than hold every hybrid behind it for good
        if (!this.unattestable(key)) return this.rememberDead(start, after, out);
        after = cursorSuffix(key);
      }
      if (out.length >= limit) return out;
    }
  }

  /**
   * Where a walk from `start` got to without finding an item, so the next poll
   * from the same cursor begins there.
   */
  private rememberDead(
    start: string,
    after: string,
    out: { cursor: string; item: ActiveDefinitions.IFeedItem }[]
  ): { cursor: string; item: ActiveDefinitions.IFeedItem }[] {
    if (!out.length && after > start) {
      if (this.deadRuns.size >= 256) this.deadRuns.delete(this.deadRuns.keys().next().value as string);
      this.deadRuns.set(start, after);
    }
    return out;
  }

  /** True once a feed key is old enough that its missing documents are not coming */
  private unattestable(key: string): boolean {
    const ms = Number(cursorSuffix(key).split(",")[0]);
    const grace = (this.deps.attestGraceSeconds ?? 120) * 1000;
    return Number.isFinite(ms) && (this.deps.now ?? Date.now)() - ms > grace;
  }

  private async buildItem(
    key: string
  ): Promise<ActiveDefinitions.IFeedItem | undefined> {
    const umid = cursorSuffix(key).split(",").slice(1).join(",");
    if (key.startsWith("fail:")) {
      const failed = await safeGet(this.deps.events, `failed:${umid}`);
      if (!failed) return undefined;
      return {
        umid,
        outcome: "failed",
        tx: failed.tx,
        $revs: failed.$revs,
        nodes: failed.nodes ?? {},
      };
    }
    const umidDoc = await safeGet(this.deps.db, `${umid}:umid`);
    const attest = await safeGet(this.deps.events, `attest:${umid}`);
    if (!umidDoc || !attest) return undefined;
    return {
      umid,
      outcome: "committed",
      umidDoc,
      $revs: umidDoc.umid?.$revs,
      revsOut: attest.revsOut,
      streams: umidDoc.streams,
      nodes: attest.nodes ?? {},
      attestation: {
        node: attest.node,
        umid,
        outcome: attest.outcome,
        revsOut: attest.revsOut,
        umidDocHash: attest.umidDocHash,
        sig: attest.sig,
      },
    };
  }
}

/**
 * Keep a failed transaction for hybrids. Only failures with at least one
 * true vote are kept: with none, no hybrid could disagree with the result.
 * Idempotent, and never throws: the client already has its answer.
 */
export async function recordFailed(
  events: { post(doc: any): Promise<any> },
  db: { exists(id: string): Promise<Boolean> },
  entry: ActiveDefinitions.LedgerEntry,
  build: number
): Promise<boolean> {
  if (build < 40300 || !entry?.$umid || !entry.$nodes) return false;
  try {
    const nodes: { [ref: string]: ActiveDefinitions.IFeedNodeVote } = {};
    let yes = 0;
    for (const ref of Object.keys(entry.$nodes)) {
      const n = entry.$nodes[ref];
      if (n && typeof n.vote === "boolean") {
        nodes[ref] = { vote: n.vote, ...(n.sig ? { sig: n.sig } : {}) };
        if (n.vote) yes++;
      }
    }
    if (!yes) return false;
    // A transaction another node committed is a feed item already
    if (await db.exists(`${entry.$umid}:umid`)) return false;

    const ms = new Date(entry.$datetime).getTime();
    await events.post({
      _id: `failed:${entry.$umid}`,
      tx: {
        $umid: entry.$umid,
        $tx: entry.$tx,
        $sigs: entry.$sigs,
        $selfsign: entry.$selfsign ? entry.$selfsign : false,
        $datetime: entry.$datetime,
        $origin: entry.$origin,
        $remoteAddr: entry.$remoteAddr,
        ...((entry as any).$relay ? { $relay: (entry as any).$relay } : {}),
      },
      $revs: entry.$revs,
      nodes,
    });
    await events.post({ _id: `fail:${ms},${entry.$umid}` });
    return true;
  } catch {
    // Already recorded (same id), or the events database is unavailable
    return false;
  }
}

/**
 * Registered hybrids, read from their registry streams (`default/hybrid`).
 * There is no shared index stream, so `list` scans for registry-typed state
 * documents and keeps the answer briefly.
 */
export class LedgerHybridRegistry implements HybridRegistry {
  private cached?: { at: number; list: (RegisteredHybrid & { keyHash: string })[] };

  constructor(
    private db: HybridDb,
    private listTtlMs = 30_000
  ) {}

  private static fromState(state: any): RegisteredHybrid | undefined {
    if (state?.type !== "default.activeledger.hybrid" || !state.key) return undefined;
    return {
      key: state.key,
      type: state.keyType ?? "rsa",
      endpoints: state.endpoints ?? [],
      label: state.label,
      retired: !!state.retired,
    };
  }

  /**
   * Was this stream created by `default/hybrid`? Any contract can create a
   * stream with this deterministic id and write whatever state it likes, so
   * the state alone proves nothing: the transaction that created the stream
   * (named by its meta) must be a `default/hybrid` one.
   */
  private async createdByRegistry(id: string): Promise<boolean> {
    const meta = await safeGet(this.db, `${id}:stream`);
    if (!meta?.origin) return false;
    const origin = await safeGet(this.db, `${meta.origin}:umid`);
    const tx = origin?.umid?.$tx;
    return tx?.$namespace === "default" && tx?.$contract === "hybrid";
  }

  public async lookup(hash: string): Promise<RegisteredHybrid | undefined> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const id = ActiveCrypto.hybridStreamIdFromKeyHash(hash);
    const entry = LedgerHybridRegistry.fromState(await safeGet(this.db, id));
    // The stream id is derived from the hash, so it must hold that key
    if (!entry || ActiveCrypto.keyHash(entry.key) !== hash) return undefined;
    return (await this.createdByRegistry(id)) ? entry : undefined;
  }

  public async list(): Promise<(RegisteredHybrid & { keyHash: string })[]> {
    if (this.cached && Date.now() - this.cached.at < this.listTtlMs) {
      return this.cached.list;
    }
    const list: (RegisteredHybrid & { keyHash: string })[] = [];
    let start: string | undefined;
    for (;;) {
      const r = await this.db.allDocs({
        ...(start ? { startkey: start } : {}),
        limit: 500,
        include_docs: true,
      });
      const rows: any[] = r?.rows ?? [];
      for (const row of rows) {
        const doc = row.doc ?? row;
        if (doc?._id === start) continue;
        const entry = LedgerHybridRegistry.fromState(doc);
        if (
          entry &&
          ActiveCrypto.hybridStreamId(entry.key) === doc._id &&
          (await this.createdByRegistry(doc._id))
        ) {
          list.push({ ...entry, keyHash: ActiveCrypto.keyHash(entry.key) });
        }
      }
      if (rows.length < 500) break;
      start = rows[rows.length - 1]._id ?? rows[rows.length - 1].id;
    }
    this.cached = { at: Date.now(), list };
    return list;
  }
}
