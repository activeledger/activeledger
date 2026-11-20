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
import * as Sync from "@activeledger/activesync";

/** One row of a neighbour's umid index */
export interface UmidRow {
  umid: string;
  /** Milliseconds since the epoch, on the neighbour's clock, as a string */
  timestamp: string;
}

/**
 * What the catch-up needs from the node. Host supplies the real ones; a test
 * passes fakes and moves time by hand.
 */
export interface CatchupDeps {
  /** A page of one neighbour's umid index after `from` (ms), or null when none can answer */
  umidsSince(from: number, limit: number): Promise<{ rows: UmidRow[]; more: boolean } | null>;
  /** Whether this node holds the umid document */
  holds(umid: string): Promise<boolean>;
  /**
   * Fetch the umid document from the network and keep it (with its events), and
   * say which streams it created or updated. Null when it could not be had.
   */
  adopt(umid: string): Promise<string[] | null>;
  /** Every reachable node's copy of the streams (the shape of knockAll("stream")) */
  networkStreams(streams: string[], umid: string): Promise<any[]>;
  /** How many matching copies the majority needs */
  consensusNeeded(): number;
  /** This node's copy of a document, or undefined */
  local(id: string): Promise<any | undefined>;
  /** Write a document at exactly its revision. False when the write failed */
  rewrite(doc: any): Promise<boolean>;
  /** Hold the streams against live transactions. False when any is busy (nothing is held then) */
  lock(streams: string[], owner: string): boolean;
  unlock(streams: string[], owner: string): void;
  /** Fill in the umids behind the stream's current one (stops at one already held) */
  repairHistory(streamId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface CatchupOptions {
  /** Look this far before the starting point, for clocks that differ (ms) */
  margin: number;
  /** Most missing umids one run will take on; past this a full restore is the right tool */
  cap: number;
  /** Rows asked for per page */
  pageSize: number;
  /** Streams repaired at once */
  concurrency: number;
}

export const CATCHUP_DEFAULTS: CatchupOptions = {
  margin: 30000,
  cap: 5000,
  pageSize: 500,
  concurrency: 4,
};

export interface CatchupResult {
  /** Rows looked at */
  scanned: number;
  /** Umids this node did not hold */
  missing: number;
  /** Streams those umids touched */
  streams: number;
  /** Streams rewritten to the network's revision */
  rewritten: number;
  /** Streams already at, or ahead of, the network's revision */
  current: number;
  /** Streams not decided this run (no majority, a node could not report, busy, a failed write) */
  undecided: number;
  /** Streams the network disagrees on (left alone) */
  forks: number;
  /** The cap stopped the run */
  capped: boolean;
  /** No neighbour could list its umids */
  unavailable: boolean;
  /** Everything in the window is settled (nothing left for a later run) */
  settled: boolean;
}

/**
 * The catch-up: a node that missed commits (it was down, frozen, or started
 * late) asks a neighbour what it committed after a point, and for each stream
 * those commits touched adopts the network's current revision once (as SPI
 * does) and then fills in the umids behind it. See
 * docs/design/2026-11-20-catch-up.md.
 *
 * Idempotent: a umid already held and a stream already at the tip are
 * skipped, so a run can stop anywhere and be run again from the same point.
 */
export class Catchup {
  private running = false;
  private owner = 0;

  constructor(
    private deps: CatchupDeps,
    private options: CatchupOptions = CATCHUP_DEFAULTS
  ) {}

  /** True while a run is in progress; a second never starts beside it */
  public get busy(): boolean {
    return this.running;
  }

  /**
   * Catch up from a point.
   *
   * @param {number} since Milliseconds: the newest umid row this node wrote while it was in sync
   * @returns {Promise<CatchupResult | null>} Null when a run was already going
   */
  public async run(since: number): Promise<CatchupResult | null> {
    if (this.running) return null;
    this.running = true;
    const result: CatchupResult = {
      scanned: 0,
      missing: 0,
      streams: 0,
      rewritten: 0,
      current: 0,
      undecided: 0,
      forks: 0,
      capped: false,
      unavailable: false,
      settled: false,
    };
    try {
      // 1. Which umids this node does not hold, and which streams they touched
      const touched = new Map<string, string>(); // stream -> a umid that touched it
      let from = Math.max(0, since - this.options.margin);
      let seen = new Set<string>();
      for (;;) {
        const page = await this.deps.umidsSince(from, this.options.pageSize);
        if (!page) {
          result.unavailable = result.scanned === 0;
          break;
        }
        let newest = from;
        for (const row of page.rows) {
          const at = parseInt(row.timestamp, 10);
          if (Number.isFinite(at)) newest = Math.max(newest, at);
          if (seen.has(row.umid)) continue;
          seen.add(row.umid);
          result.scanned++;
          if (await this.deps.holds(row.umid)) continue;
          if (result.missing >= this.options.cap) {
            result.capped = true;
            break;
          }
          result.missing++;
          const streams = await this.deps.adopt(row.umid);
          if (!streams) {
            // Could not be had now; the window is not settled
            result.undecided++;
            continue;
          }
          for (const stream of streams) if (!touched.has(stream)) touched.set(stream, row.umid);
        }
        if (result.capped || !page.more || newest <= from) break;
        // The next page starts at the newest time seen (rows at that time come
        // again and are skipped by `seen`)
        from = newest;
        if (seen.size > this.options.cap * 4) seen = new Set();
      }
      result.streams = touched.size;
      if (result.capped) {
        ActiveLogger.warn(
          `Catch-up stopped at ${this.options.cap} missing umids, a full restore is the right tool for a gap this size`
        );
      }

      // 2. Each stream once, a few at a time
      const queue = [...touched.entries()];
      const workers = Array.from(
        { length: Math.max(1, Math.min(this.options.concurrency, queue.length)) },
        async () => {
          for (;;) {
            const next = queue.shift();
            if (!next) return;
            await this.stream(next[0], next[1], result);
          }
        }
      );
      await Promise.all(workers);

      result.settled = !result.capped && !result.unavailable && result.undecided === 0;
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Bring one stream (its state and its :stream meta) to the network's
   * revision, if it is behind.
   */
  private async stream(streamId: string, umid: string, result: CatchupResult): Promise<void> {
    const ids = [streamId, `${streamId}:stream`];
    try {
      const network = await this.deps.networkStreams(ids, umid);
      const needed = this.deps.consensusNeeded();
      if (network.filter((n) => n && !n.error).length < needed) {
        result.undecided++;
        return;
      }
      const agreed = Sync.spiConsensus(network, needed);
      if (ids.some((id) => agreed.forks[id])) {
        ActiveLogger.warn(`Catch-up ${streamId}: the network disagrees on it, left alone`);
        result.forks++;
        return;
      }
      if (ids.some((id) => agreed.abstained[id]) || !ids.every((id) => agreed.winners[id])) {
        result.undecided++;
        return;
      }

      // Only a stream that is behind is touched; never backwards, never over a different revision at the same position
      const behind: any[] = [];
      for (const id of ids) {
        const winner = agreed.winners[id].doc;
        const mine = await this.deps.local(id);
        if (mine?._rev === winner._rev) continue;
        const mineAt = mine?._rev ? Sync.revPosition(mine._rev) : 0;
        const winnerAt = Sync.revPosition(winner._rev);
        if (mineAt > winnerAt) continue;
        if (mineAt === winnerAt && mine?._rev) {
          ActiveLogger.warn(`Catch-up ${id}: same position, different revision, left alone`);
          result.forks++;
          return;
        }
        behind.push(winner);
      }
      if (!behind.length) {
        result.current++;
        return;
      }

      const owner = `catchup:${++this.owner}`;
      if (!this.deps.lock([streamId], owner)) {
        // A transaction holds it; the next run
        result.undecided++;
        return;
      }
      try {
        // The state first, then the meta that names its umid
        behind.sort((a, b) => (String(a._id).endsWith(":stream") ? 1 : 0) - (String(b._id).endsWith(":stream") ? 1 : 0));
        for (const doc of behind) {
          if (!(await this.deps.rewrite(doc))) {
            result.undecided++;
            return;
          }
        }
      } finally {
        this.deps.unlock([streamId], owner);
      }
      result.rewritten++;
      await this.deps.repairHistory(streamId);
      await this.deps.sleep(0);
    } catch (error) {
      ActiveLogger.error(error, `Catch-up ${streamId} failed`);
      result.undecided++;
    }
  }
}

/** What the driver leaves in the events database while a catch-up is needed */
export interface CatchupMarker {
  /** Where the catch-up starts (ms): the newest row this node wrote while in sync */
  since: number;
  chain: unknown;
  network: string;
  written: number;
}

export interface CatchupDriverDeps {
  run(since: number): Promise<CatchupResult | null>;
  readMarker(): Promise<CatchupMarker | undefined>;
  writeMarker(marker: CatchupMarker): Promise<void>;
  clearMarker(): Promise<void>;
  /** Time (ms) of the newest umid row older than `before`; 0 when there is none */
  newestRowBefore(before: number): Promise<number>;
  /** Time (ms) of the newest umid row; 0 when there is none */
  newestRow(): Promise<number>;
  /** Neighbours other than this node that are configured */
  peers(): number;
  quorumReached(): boolean;
  now(): number;
  /** Chain id and network reference, kept in the marker so a stale one is not trusted */
  identity(): { chain: unknown; network: string };
}

export interface CatchupDriverOptions {
  /** A marker older than this is dropped (ms) */
  markerMaxAge: number;
  /** First wait before trying again after a run that did not settle, doubling up to retryMax (ms) */
  retryFirst: number;
  retryMax: number;
  /** Quiet check while in sync (ms) */
  backstop: number;
}

export const CATCHUP_DRIVER_DEFAULTS: CatchupDriverOptions = {
  markerMaxAge: 7 * 24 * 3600 * 1000,
  retryFirst: 30000,
  retryMax: 5 * 60000,
  backstop: 10 * 60000,
};

/**
 * Decides when the catch-up runs and where it starts. Called every few
 * seconds from the host (tick); does nothing unless the situation changed.
 *
 * - once after start, when the quorum is reached;
 * - again when the quorum is regained after it was lost;
 * - again, with waits growing, while a run has not settled;
 * - a quiet check now and then while in sync.
 *
 * It writes nothing while in sync. A marker (the starting point) exists only
 * while a catch-up is needed, so a node that crashes during one starts from
 * the same point and not from rows its own repair wrote.
 */
export class CatchupDriver {
  /** When this node last went out of sync: start, or the quorum last lost */
  private outSince: number;
  private pending = true;
  private reached = false;
  private retryAt = 0;
  private retryStep: number;
  private nextBackstop: number;
  private working = false;

  constructor(
    private deps: CatchupDriverDeps,
    private options: CatchupDriverOptions = CATCHUP_DRIVER_DEFAULTS
  ) {
    this.outSince = deps.now();
    this.retryStep = options.retryFirst;
    this.nextBackstop = deps.now() + options.backstop;
  }

  /** Whether a catch-up is still wanted for the current out-of-sync period */
  public get wanted(): boolean {
    return this.pending;
  }

  public async tick(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const reached = this.deps.quorumReached();
      if (!reached) {
        if (this.reached) {
          // Lost it: from here on this node may miss commits
          this.outSince = this.deps.now();
          this.pending = true;
          this.retryStep = this.options.retryFirst;
          this.retryAt = 0;
        }
        this.reached = false;
        return;
      }
      this.reached = true;
      const now = this.deps.now();
      if (this.pending) {
        if (now >= this.retryAt) await this.catchUp();
      } else if (now >= this.nextBackstop) {
        await this.quiet();
      }
    } finally {
      this.working = false;
    }
  }

  private async catchUp(): Promise<void> {
    if (this.deps.peers() === 0) {
      this.pending = false;
      return;
    }
    const identity = this.deps.identity();
    let marker = await this.deps.readMarker();
    if (
      marker &&
      (this.deps.now() - marker.written > this.options.markerMaxAge ||
        marker.network !== identity.network ||
        JSON.stringify(marker.chain) !== JSON.stringify(identity.chain))
    ) {
      await this.deps.clearMarker();
      marker = undefined;
    }
    let since: number;
    if (marker) {
      since = marker.since;
    } else {
      since = await this.deps.newestRowBefore(this.outSince);
      // Before the first adopted row, so a crash from here resumes at this point
      await this.deps.writeMarker({
        since,
        chain: identity.chain,
        network: identity.network,
        written: this.deps.now(),
      });
    }
    const result = await this.deps.run(since);
    if (!result) return;
    if (result.settled || result.capped) {
      // Settled: done. Capped: a full restore is the right tool, so the marker goes too
      await this.deps.clearMarker();
      this.pending = false;
      this.retryStep = this.options.retryFirst;
      this.nextBackstop = this.deps.now() + this.options.backstop;
    } else {
      this.retryAt = this.deps.now() + this.retryStep;
      this.retryStep = Math.min(this.retryStep * 2, this.options.retryMax);
    }
  }

  /** In sync: look at the last stretch only, and run properly if anything is missing */
  private async quiet(): Promise<void> {
    this.nextBackstop = this.deps.now() + this.options.backstop;
    if (this.deps.peers() === 0) return;
    const since = await this.deps.newestRow();
    const result = await this.deps.run(since);
    if (result && !result.settled && !result.capped && !result.unavailable) {
      // Something was missing and is not fully repaired: treat it as out of sync
      this.outSince = this.deps.now() - this.options.backstop;
      this.pending = true;
      this.retryAt = this.deps.now() + this.retryStep;
    }
  }
}
