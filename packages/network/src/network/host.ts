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

//import { Server, IncomingMessage, ServerResponse, createServer } from "http";
import { readFileSync } from "fs";
import { fork, ChildProcess } from "child_process";
import * as net from "net";
import {
  ActiveDSConnect,
  ActiveOptions,
  ActiveGZip,
  ActiveClone,
} from "@activeledger/activeoptions";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveLogger, ActiveTiming } from "@activeledger/activelogger";
import { ActiveDefinitions } from "@activeledger/activedefinitions";
import { Home, leaderMarkHolds } from "./home";
import { HybridApi, LedgerHybridRegistry, recordFailed } from "./hybridApi";
import { FeedClient, registerHybridRoutes } from "./hybridRoutes";
import { startHybridP2P } from "./hybridP2P";
import { HybridBans, feedsStatus, hybridStatus, isLoopback, listHybrids } from "./hybridAdmin";
import { Neighbour } from "./neighbour";
import { ActiveInterfaces } from "./utils";
import { Endpoints, Maintain } from "./index";
import { Locker } from "./locker";
import { Catchup, CatchupDriver, CatchupDriverDeps, CatchupMarker } from "./catchup";
import { withJsonFallback } from "./ipc";
import { PhysicalCores } from "./cpus";
import { DEFAULT_WORKER_COUNT, workerCount } from "./workercount";
import { workerExecArgv } from "./workerheap";
import { reportedUpdatedStreams } from "./updatedstreams";
import { changedNodes, nodeSignature } from "./nodedelta";
import { releaseHoldMs, releaseStubMs, releaseTailMs } from "./releasetimes";
import { voteOnlyRecord } from "./voteonly";
import * as process from "process";
import {
  App,
  HttpResponse,
  TemplatedApp,
  us_listen_socket,
  us_listen_socket_close,
} from "uWebSockets.js";
import { promisify } from "util";
import { gunzip } from "zlib";

/**
 * Responses smaller than this are sent uncompressed. Matches ActiveRequest's
 * GZIP_MIN_BYTES for requests - see writeResponse().
 */
const GZIP_MIN_RESPONSE_BYTES = 16384;

const gunzipAsync = promisify(gunzip);

const TIMER_QUEUE_INTERVAL = 2 * 1000;
// How long a transaction with an $expire is held, just after a start, for the list of resent
// transactions to be read before it is told to try again (normally a few milliseconds).
const RESENT_LOAD_WAIT_MS = 5 * 1000;
/**
 * How far ahead of now a transaction's $expire may be for this node to answer
 * "was it already committed?" from memory (see Host.mayBeStored). 0 turns that off.
 */
const STORED_WINDOW_MS = Number(process.env.AL_STORED_WINDOW_MS ?? 5 * 60 * 1000);
/** Most umids held for it at once; past this the node asks its storage instead */
const STORED_MAX = Number(process.env.AL_STORED_MAX ?? 200000);
/** Most far-off $expire minutes noted at once (numbers, not umids); past it memory says "maybe" to everything until they pass */
const STORED_UNKNOWN_MAX = Number(process.env.AL_STORED_UNKNOWN_MAX ?? 10000);
const GRACEFUL_PROC_SHUTDOWN = 7 * 60 * 1000;
const KILL_PROC_SHUTDOWN = 2.5 * 1000;
// How long a transaction may wait for its streams before it is told the locks
// are busy.
//
// This used to be a retry count (35), but the count was never a measure of
// time: processQueue() runs on every pending() call, so an unrelated
// transaction arriving anywhere on the node burned one of the 35. A quiet node
// therefore waited ~7s before giving up while a busy one gave up in a fraction
// of that - the opposite of what you want, since a busy node is exactly where
// a stream is worth waiting for. The comment above the old check said as much:
// "every new transaction (unrelated) will increase the counter ... so possibly
// a safe timeout should be used".
//
// 7s preserves the old quiet-node budget (35 x the 200ms re-check) and sits
// well inside the 60s broadcast timeouts.
const QUEUE_MAX_WAIT_MS = Number(process.env.AL_QUEUE_MAX_WAIT_MS || 7_000);

// How long after a release before the lock queue is re-checked.
//
// Was 200ms. Deliberately not 0/setImmediate, which benchmarks fastest but is
// the least safe: processQueue() scans the whole queue and calls hold() on
// every entry, so each pass is O(queue length), and removing the delay removes
// the only thing throttling those scans. Measured, it pushed one transaction
// to 133 retry passes where the old cap was 35, and left unrelated work
// running at 1.3x its quiet latency during a burst.
//
// 50ms keeps almost all of the benefit - on a quiet single node two writers on
// one stream cost 24ms against setImmediate's 23ms and the old 68ms - while
// still bounding how often that scan can run. 25ms was measurably worse than
// both, reproducibly, which is reason enough not to go lower without
// understanding why.
const QUEUE_RECHECK_MS = Number(process.env.AL_QUEUE_RECHECK_MS ?? 50);

// The least time between two scans of a non-empty lock queue.
//
// A scan calls hold() on every queued entry, and one was started by every
// pending() call and every release. So the work was (arrivals + releases) per
// second times the queue length, and the queue is as long as the arrival rate
// times the wait (up to QUEUE_MAX_WAIT_MS). Past a certain load that feeds
// itself: the node gets slower, locks are held longer, the queue grows, and
// each scan costs more. A stress run at 800 tx/s reached about 1,700 queued
// transactions and 130,000 hold() attempts a second, each writing a log line,
// and the node stopped answering for 20 s.
//
// With a minimum gap, the scans cost at most queue length x (1000 / gap) a
// second however fast transactions arrive. A new transaction that arrives
// inside the gap still tries its own streams at once (as it already did while
// a scan was running); it just does not trigger another scan of the queue.
// An empty queue is never delayed. 0 turns the limit off.
const QUEUE_SCAN_MIN_MS = Number(process.env.AL_QUEUE_SCAN_MIN_MS ?? 20);

// The pre-deadline default, kept only so queue_retry keeps meaning what it did
// for anyone who explicitly configured it.
const MAX_RETRIES = 35;

/**
 * Reads the first `n` bytes across the front of a chunk array without
 * concatenating everything buffered so far - almost always just chunks[0]
 * if it's already big enough, only falling back to a (small) concat of the
 * leading chunks that actually make up those n bytes.
 *
 * @param {Buffer[]} chunks
 * @param {number} n
 * @returns {Buffer}
 */
function peekBytes(chunks: Buffer[], n: number): Buffer {
  if (chunks.length > 0 && chunks[0].length >= n) {
    return chunks[0];
  }
  let total = 0;
  let end = 0;
  while (end < chunks.length && total < n) {
    total += chunks[end].length;
    end++;
  }
  return Buffer.concat(chunks.slice(0, end));
}

/**
 * Process object used to manage an individual transaction
 *
 * @interface process
 */
interface process {
  entry: ActiveDefinitions.LedgerEntry;
  resolve: any;
  reject: any;
  pid: number;
  finished: boolean;
  responded: boolean;
  shutdown?: boolean;
  /** Only this node's answer is kept, see voteonly.ts */
  voteOnly?: boolean;
  /** Set when released, so its timers only act on this record and not a later one under the same umid */
  token?: object;
  broadcasting?: boolean;
  /** signatures of the node responses already forwarded to the worker (see nodedelta.ts) */
  sentNodes?: { [reference: string]: string };
  /** signature of this node's own response as last handed to each neighbour (p2pQuietReplies) */
  sentVote?: { [reference: string]: string };
  /** Leader transaction: nodes not marked home that it was also sent to (once each) */
  leaderExtra?: Set<string>;
}

/**
 * Setup object for a processor process
 *
 * @interface setup
 */
interface setup {
  type: string;
  data: {
    self: string;
    reference: string;
    right: Neighbour;
    neighbourhood: {
      [reference: string]: Neighbour;
    };
    pubPem: string;
    privPem: any;
    db: any;
    __base: unknown;
  };
}

/**
 * Extend  ChildProcess and add stoppable flag
 *
 * @interface StoppableChildProcess
 * @extends {ChildProcess}
 */
interface StoppableChildProcess extends ChildProcess {
  stop: boolean;
  /** Has said it finished its setup (until then it holds what it is sent) */
  ready?: boolean;
}

interface BusyLockQueue {
  running: boolean;
  entry: ActiveDefinitions.LedgerEntry;
  retry: number;
  /** When this first failed to get its locks - see hold()'s give-up test. */
  queuedAt: number;
}

/**
 * The one node a $$noreply=false frame's answer should go to, or undefined
 * when we cannot be sure who asked (the answer then goes to everyone, as it
 * always did).
 *
 * Trusted only when every check holds: the sender reference the frame
 * arrived under (P2P header / X-Activeledger) is a home neighbour other
 * than us, it passes the firewall for the address the frame came from, and
 * it is the one node the payload speaks for (a peer's own broadcast carries
 * exactly its own entry in $nodes).
 */
function replyRecipientsOf(
  host: {
    reference: string;
    neighbourhood: {
      get(ref: string): Neighbour | undefined;
      checkFirewall(remote: string, ref?: string): boolean;
    };
  },
  entry: ActiveDefinitions.LedgerEntry,
  remoteAddr: string,
  requester?: string
): string[] | undefined {
  if (!requester || requester === "NA" || requester === host.reference) {
    return undefined;
  }
  const nodes = entry.$nodes ? Object.keys(entry.$nodes) : [];
  if (nodes.length !== 1 || nodes[0] !== requester) {
    return undefined;
  }
  const neighbour = host.neighbourhood.get(requester);
  if (
    !neighbour ||
    !neighbour.isHome ||
    !host.neighbourhood.checkFirewall(remoteAddr, requester)
  ) {
    return undefined;
  }
  return [requester];
}

/**
 * Hosted process for API and Protocol management
 *
 * @export
 * @class Host
 * @extends {Home}
 */
export class Host extends Home {
  /** Hybrid key hashes refused on this supernode only (`hybrid ban`) */
  public static hybridBans = new HybridBans();

  /** The start-up check that the databases answer is not awaited, so a failure is logged here and not left unhandled */
  public static dbUnreachable(error: unknown): void {
    ActiveLogger.warn(`Database did not answer at start-up: ${(error as Error)?.message ?? error}`);
  }

  /** The registry of hybrids, read from the ledger */
  public hybridRegistry: LedgerHybridRegistry;

  /** Hybrid feeds connected right now */
  public hybridFeeds: Set<FeedClient> = new Set();

  /** `--hybrid-max-feeds`, or `hybridMaxFeeds` in config.json. Local to this supernode. */
  public static hybridMaxFeeds(): number {
    return (
      Number(
        ActiveOptions.get<any>("hybrid-max-feeds", null) ??
          ActiveOptions.get<any>("hybridMaxFeeds", 32)
      ) || 32
    );
  }

  /**
   * Called once the API is listening. Lets the CLI report real progress.
   */
  public static onListening?: () => void;

  /**
   * p2pQuietReplies: do not answer a neighbour's message with our vote when
   * that vote was already handed to it. The resend timer (see armResend)
   * covers a neighbour that never answers.
   */
  private static quietReplies(): boolean {
    return ActiveOptions.get<boolean>("p2pQuietReplies", true) !== false;
  }

  /** How long a neighbour may stay silent before our vote is sent to it again (p2pResendMs), doubling each try */
  private static resendMs(): number {
    const ms = Number(ActiveOptions.get<number>("p2pResendMs", 250));
    return Number.isFinite(ms) && ms >= 10 ? ms : 250;
  }

  private p2pServer: net.Server;

  /**
   * Holds underlying socket
   *
   * @private
   * @type {us_listen_socket}
   */
  private listenSocket: us_listen_socket | null;

  /**
   * All communications done via a single REST server
   * we will need to manage permissions and security to seperate the calls
   *
   * @type {Server}
   */
  public readonly api: TemplatedApp;

  /**
   * Server connection to the couchdb instance for this node
   *
   * @public
   * @type ActiveDSConnect
   */
  public dbConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb error instance for this node
   *
   * @public
   * @type ActiveDSConnect
   */
  public dbErrorConnection: ActiveDSConnect;

  /**
   * Server connection to the couchdb vent instance for this node
   *
   * @private
   * @type ActiveDSConnect
   */
  public dbEventConnection: ActiveDSConnect;

  /**
   * Has this node already decided it will NOT commit a transaction?
   *
   * Used to answer a peer asking about a stream this node currently holds
   * locked. Normally that is refused - a stream being written cannot be
   * sampled safely - but a node that has voted NO will never write it, so
   * its documents are stable and the read is safe by construction.
   *
   * The three states are deliberately distinct:
   *
   *   early     - voting has not concluded. postVote() deletes this flag
   *               when the node's opinion becomes real, so while it is set
   *               nothing is known and the answer must be no.
   *   vote true - it may still commit, and a commit writes the state and
   *               meta documents together. Reading between those two is
   *               how a node ends up with a mismatched
   *               meta._rev:state._rev pair, which produces position
   *               errors on that stream forever.
   *   vote false- voting concluded against. commit() gates on
   *               nodeResponse.vote, so this node cannot write for this
   *               transaction. Safe.
   *
   * @static
   * @param {ActiveDefinitions.LedgerEntry} [entry]
   * @param {string} reference this node's own reference
   * @returns {boolean}
   */
  public static hasVotedAgainst(
    entry: ActiveDefinitions.LedgerEntry | undefined,
    reference: string
  ): boolean {
    const response = entry?.$nodes?.[reference];
    if (!response || response.early) {
      return false;
    }
    return response.vote === false;
  }

  /**
   * Whether this node has voted against the transaction holding a lock,
   * and so cannot be part-way through writing its streams.
   *
   * @param {string} umid
   * @returns {boolean}
   */
  public willNotCommit(umid: string): boolean {
    const pending = this.processPending[umid];
    return Host.hasVotedAgainst(pending?.entry, Home.reference);
  }

  /**
   * Holds the processPending requests before processing
   *
   * @private
   * @type {*}
   */
  private processPending: {
    [reference: string]: process;
  } = {};

  /** The catch-up driver, once started (see startCatchup) */
  private catchupDriver?: CatchupDriver;

  /**
   * Starts the catch-up (docs/design/2026-11-20-catch-up.md) unless `catchUp` is
   * set to false: every few seconds the driver looks at whether this node is in sync and,
   * after a start or a loss of the quorum, asks a neighbour what it committed
   * that this node did not.
   */
  private startCatchup(): void {
    if (this.catchupDriver || ActiveOptions.get<boolean>("catchUp", true) === false) return;
    const events = this.dbEventConnection;
    const markerId = "catchup:since";
    const network = () => ActiveOptions.get<string>("network", "");
    const others = () =>
      Object.values(this.neighbourhood.get() as { [ref: string]: Neighbour }).filter(
        (n) => n.reference !== this.reference && !n.graceStop
      );

    const newestRowIn = async (options: any): Promise<number> => {
      try {
        const response = await events.allDocs({ ...options, descending: true, limit: 1 });
        const id: string = response?.rows?.[0]?.id ?? response?.rows?.[0]?._id ?? "";
        const at = parseInt(id.replace("umid:", "").split(",")[0], 10);
        return Number.isFinite(at) ? at : 0;
      } catch {
        return 0;
      }
    };

    const catchup = new Catchup({
      umidsSince: async (from, limit) => {
        for (const neighbour of others()) {
          if (!neighbour.isHome) continue;
          try {
            const answer = await neighbour.knock(`umids/${from}?limit=${limit}`);
            const body = answer?.data;
            if (body && Array.isArray(body.rows)) return { rows: body.rows, more: !!body.more };
          } catch {
            // An older node, or one that did not answer: the next
          }
        }
        return null;
      },
      holds: async (umid) => !!(await this.dbConnection.exists(`${umid}:umid`)),
      adopt: async (umid) => {
        if (!(await Endpoints.backfillUmid(this, umid))) return null;
        const doc: any = await this.dbConnection.get(`${umid}:umid`).catch(() => undefined);
        const ids = [...(doc?.streams?.new || []), ...(doc?.streams?.updated || [])]
          .map((entry: any) => entry?.id)
          .filter((id: unknown): id is string => typeof id === "string" && !!id);
        return [...new Set(ids)];
      },
      networkStreams: (streams, umid) =>
        this.neighbourhood.knockAll("stream", { $streams: streams, $umid: umid }),
      consensusNeeded: () =>
        Math.max(
          1,
          Math.ceil(
            (ActiveOptions.get<any>("consensus", {}).reached / 100) * this.neighbourhood.count() - 1
          )
        ),
      local: async (id) => {
        try {
          const doc = await this.dbConnection.get(id);
          return doc && doc._id ? doc : undefined;
        } catch {
          return undefined;
        }
      },
      rewrite: async (doc) => {
        try {
          // As SPI does: the document at exactly its revision
          const current = await this.dbConnection.get(doc._id);
          if (!current) return false;
          if (!current._rev) {
            try {
              await this.dbConnection.put(doc);
            } catch {
              // Created by the write below, or already there
            }
          }
          const written = await this.dbConnection.bulkDocs([doc], {
            new_edits: true,
            force_rev: doc._rev,
          });
          return !Endpoints.bulkWriteFailed(written);
        } catch (error) {
          ActiveLogger.error(error, `Catch-up could not write ${doc?._id}`);
          return false;
        }
      },
      lock: (streams, owner) => Locker.hold(streams, owner),
      unlock: (streams, owner) => void Locker.release(streams, owner),
      repairHistory: (streamId) => Endpoints.repairHistoryNow(this, streamId, "catch-up"),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    const deps: CatchupDriverDeps = {
      run: async (since) => {
        const result = await catchup.run(since);
        if (result && (result.missing || result.rewritten || result.undecided)) {
          ActiveLogger.info(
            `Catch-up: ${result.missing} umid(s) missing, ${result.streams} stream(s): ${result.rewritten} rewritten, ${result.current} current, ${result.undecided} undecided, ${result.forks} fork(s)${result.settled ? ", settled" : ""}`
          );
        }
        return result;
      },
      readMarker: async () => {
        try {
          const doc: any = await events.get(markerId);
          return doc && doc._id ? (doc as CatchupMarker) : undefined;
        } catch {
          return undefined;
        }
      },
      writeMarker: async (marker) => {
        try {
          const existing: any = await events.get(markerId).catch(() => undefined);
          await events.put({ ...marker, _id: markerId, ...(existing?._rev ? { _rev: existing._rev } : {}) } as any);
        } catch (error) {
          ActiveLogger.warn(error, "Catch-up marker not written");
        }
      },
      clearMarker: async () => {
        try {
          const existing: any = await events.get(markerId);
          if (existing?._id && existing._rev) await events.purge({ _id: existing._id, _rev: existing._rev });
        } catch {
          // Nothing to clear
        }
      },
      newestRowBefore: (before) => newestRowIn({ startkey: "umid:", endkey: `umid:${before}` }),
      newestRow: () => newestRowIn({ startkey: "umid:", endkey: "umid;" }),
      peers: () => others().length,
      quorumReached: () => this.quorum().reached,
      now: () => Date.now(),
      identity: () => ({ chain: ActiveOptions.get<any>("chain", null), network: network() }),
    };

    this.catchupDriver = new CatchupDriver(deps);
    const timer = setInterval(() => {
      this.catchupDriver?.tick().catch((error) => ActiveLogger.error(error, "Catch-up tick failed"));
    }, 5000);
    timer.unref?.();
    ActiveLogger.info("Catch-up on");
  }

  /** Transactions the self repair check was already started for (umid, when), so each runs it once */
  private spiStarted = new Map<string, number>();

  /**
   * Starts the self repair check (SPI, in Endpoints.InternalInitalise) from this
   * node's own failure, for a transaction another node originated that this
   * node voted no on because it holds an older revision (or none).
   *
   * That check used to run only when a later frame from a peer for the same
   * transaction arrived after this node's error was on the pending entry: the
   * first frame is answered at once with { ok: true } (so the worker's own result
   * is not delivered to it), and each later frame gets the entry as it is when it
   * arrives. If every peer's frame came before this node finished failing, the
   * check never ran and the stream stayed behind. This asks the same question once,
   * when the failure is known, with the entry as a peer's frame would have found it.
   *
   * No reply is broadcast ($$noreply) and nothing is added to the entry.
   */
  public spiFromOwnFailure(entry: ActiveDefinitions.LedgerEntry): void {
    if (!entry || !entry.$broadcast || !entry.$tx || entry.$origin === this.reference) return;
    const error = entry.$nodes?.[this.reference]?.error;
    if (
      typeof error !== "string" ||
      (error.indexOf("Position Incorrect") === -1 &&
        error.indexOf("Stream(s) not found") === -1)
    ) {
      return;
    }
    const now = Date.now();
    if (this.spiStarted.has(entry.$umid)) return;
    if (this.spiStarted.size > 500) {
      for (const [umid, at] of this.spiStarted) {
        if (now - at > 60000) this.spiStarted.delete(umid);
      }
    }
    this.spiStarted.set(entry.$umid, now);
    ActiveLogger.debug(`SPI from own failure : ${entry.$umid}`);
    Endpoints.InternalInitalise(
      this,
      { ...entry, $nodes: {}, $$noreply: true } as ActiveDefinitions.LedgerEntry,
      this.host,
      false,
      true
    ).catch((error) => ActiveLogger.warn(error, `SPI from own failure failed : ${entry.$umid}`));
  }

  /** Home neighbours against what consensus needs, see Endpoints.quorum */
  public quorum(): { configured: number; home: number; needed: number; reached: boolean } {
    return Endpoints.quorum(this.neighbourhood.get(), this.neighbourhood.keys());
  }

  /** How many transactions this node is holding in flight (for the local status view) */
  public pendingCount(): number {
    return Object.keys(this.processPending).length;
  }

  /**
   * How many cpu processors have said they're ready
   *
   * @private
   */
  private cpuReady = 0;

  /**
   * Holds transactions to be run as locks released.
   * Basic formation of a tx memory pool.
   *
   * @private
   * @type {[]}
   */
  private busyLocksQueue: {
    internal: BusyLockQueue[];
    external: BusyLockQueue[];
  } = { internal: [], external: [] };

  /**
   * How many queued transactions are waiting for each stream. A transaction that arrives for a stream someone
   * is already waiting for must wait behind them, not take the lock the moment it happens to be free (see hold()).
   */
  private queuedStreamCounts?: Map<string, number>;

  private get queuedStreams(): Map<string, number> {
    return (this.queuedStreamCounts ||= new Map<string, number>());
  }

  private queuedAdd(streams: string[] | undefined): void {
    for (const s of streams || []) this.queuedStreams.set(s, (this.queuedStreams.get(s) || 0) + 1);
  }

  private queuedRemove(streams: string[] | undefined): void {
    for (const s of streams || []) {
      const left = (this.queuedStreams.get(s) || 0) - 1;
      if (left > 0) this.queuedStreams.set(s, left);
      else this.queuedStreams.delete(s);
    }
  }

  // A second request to shut down is the same shut down
  private shuttingDown = false;

  public shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Not listening yet (the workers are still starting, or the port was
    // refused) is when someone is most likely to press Ctrl+C, and the exit
    // below must not depend on there being a socket to close.
    if (this.listenSocket) {
      // Close the listen socket
      us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;
    }

    // Only have a a short while before sigkill
    // Lets try let them finish up then close the app before sigkill can happen
    setTimeout(() => {
      try {
        ActiveLogger.info("Stopping HTTP Server");
        this.api.close();
      } catch (e) {
        // Still on the way out
      }
      ActiveLogger.info("Shutting down...");
      process.exit(0);
    }, 1300);
  }

  /**
   * Add process into pending
   *
   */
  public pending(
    entry: ActiveDefinitions.LedgerEntry,
    remoteAddr: string,
    internal = false,
    forceRestart = false,
    isP2P = false,
    requester?: string
  ): Promise<any> {
    return new Promise<any>(async (resolve, reject) => {
      // An async executor turns a throw into an unhandled rejection, and an
      // unhandled rejection exits the host. Reject instead, callers catch it.
      try {
        // The entry node marks a transaction it may lead ($leaderOk). Not taken
        // on trust: this node works out the owner from its own list of nodes,
        // and if it is not the entry node the mark is dropped and this node
        // votes like any other
        if (
          entry.$leaderOk === true &&
          entry.$origin !== this.reference &&
          !leaderMarkHolds(entry, entry.$origin, this.tMap)
        ) {
          // This node does not agree the entry node owns these streams (a
          // different view of which nodes are up, or a false claim). It votes
          // as a normal transaction instead; say so, because the entry node
          // has committed alone and this node will not follow.
          ActiveLogger.warn(`${entry.$umid} leader mark dropped: this node does not see ${entry.$origin} as the owner of the streams it writes`);
          delete entry.$leaderOk;
        }

        // Who asked, worked out before the merge below edits entry.$nodes
        const replyRecipients =
          entry.$broadcast && !entry.$$noreply
            ? replyRecipientsOf(this, entry, remoteAddr, requester)
            : undefined;

        // This should only matter to broadcast
        // non-broadcast are direct posts. May still need to add checks there
        // but that occurs at a different location
        //
        // $nodes is what tells a peer broadcast from a client entry below: the
        // endpoint sets $broadcast on client entries too, but only peers send
        // $nodes. A client putting $nodes in its body gains nothing: its umid
        // is hashed over the body so it can't land on another tx's pending
        // entry, and it arrives with remoteAddr = Home.host ("host:port"),
        // which the firewall (bare host <-> reference) never ties to a node,
        // so this check rejects it.
        if (entry.$broadcast && entry.$nodes) {
          // Even though IP is checked, Nothing prevents them sending multiple payloads
          const nodeSpoofCheck = Object.keys(entry.$nodes);
          if (nodeSpoofCheck.length) {
            for (let i = nodeSpoofCheck.length; i--;) {
              const nodeCheck = nodeSpoofCheck[i];
              if (!this.neighbourhood.checkFirewall(remoteAddr, nodeCheck)) {
                return reject("Bad Neighbour Payload");
              }
            }
          }
        }

        if (forceRestart && this.processPending[entry.$umid]) {
          this.destroy(entry.$umid, true);
          delete this.processPending[entry.$umid];
        }

        // Broadcasting or Territoriality Mode
        if (entry.$broadcast) {
          // We may already have the $umid in memory
          if (this.processPending[entry.$umid]) {
            // ActiveLogger.debug(
            //   this.processPending[entry.$umid],
            //   "Broadcast Recieved : " + entry.$umid
            // );
            // Process Assigned?
            if (
              !this.processPending[entry.$umid]?.finished &&
              this.processPending[entry.$umid]?.pid &&
              // If a lead/er we don't need to let sub processor know. This node's
              // own key may not exist in $nodes yet (we haven't voted/committed
              // in this entry), which optional-chains to undefined here and
              // correctly falls through to "let the sub processor know".
              !this.processPending[entry.$umid]?.entry?.$nodes?.[this.reference]
                ?.leader
            ) {
              //here needs to output inbound
              ActiveLogger.debug(
                //this.processPending[entry.$umid],
                //entry,
                `Broadcast Recieved [${isP2P ? "P2P" : "HTTP"}] : ` + entry.$umid
              );
              // Find Processor to send in the broadcast message
              const processor = this.findProcessor(
                this.processPending[entry.$umid].pid
              );
              // A client resubmission has no $nodes, it isn't a peer broadcast
              if (processor && entry.$nodes) {
                // Only what the worker has not been told already (and nothing
                // at all for a repeat of the last vote)
                const news = changedNodes(
                  entry.$nodes,
                  (this.processPending[entry.$umid].sentNodes ||= {})
                );
                if (news) {
                  processor.send({
                    type: "broadcast",
                    data: {
                      umid: entry.$umid,
                      nodes: news,
                    },
                  });
                }
              } else {
                // Not found, Lets just return the umid anyway it may confirm or will timeout
              }
            } else {
              // Add Vote information into current object!
              const pendingEntry = this.processPending[entry.$umid]?.entry;
              // A client resubmitting the same bytes also lands here (it has
              // $broadcast set by the endpoint) but carries no $nodes to merge.
              if (
                pendingEntry &&
                entry.$nodes &&
                !this.processPending[entry.$umid].voteOnly
              ) {
                // Don't overwrite self from a broadcast
                delete entry.$nodes[this.reference];
                // Merge new node data into existing entry
                pendingEntry.$nodes = { ...pendingEntry.$nodes, ...entry.$nodes };
              }

            }
            if (
              !entry.$$noreply &&
              !(Host.quietReplies() && (Host.prototype as any).quietReply.call(this, entry.$umid, replyRecipients, entry))
            ) {
              // Only the node that asked can use our answer, so send it to
              // that node alone when we can tell who it is, else to everyone.
              this.broadcast(entry.$umid, false, true, replyRecipients);
            }
            // maybe pass something so the data isn't sent twice?
            return resolve({
              status: 200,
              //data: { ok: true },
              // SPI uses this to know if the non sending entry node needs fixing
              data: this.processPending[entry.$umid].entry,
              dontRelease: true,
            });
          }
        }

        // A peer's answer for a transaction we no longer hold carries no
        // transaction to run (only the vote is kept), so there is nothing to do
        if (entry.$broadcast && !entry.$tx && !this.processPending[entry.$umid]) {
          return resolve({
            status: 200,
            data: { ok: true },
            dontRelease: true,
          });
        }

        // Check we don't have it, Process finding may have failed.
        if (!this.processPending[entry.$umid]) {
          ActiveTiming.mark(entry.$umid, "host.pending");
          // Add to pending (Using Promises instead of http request)
          this.processPending[entry.$umid] = {
            entry,
            resolve: (response: any) => {
              //this.release(entry);

              // Internal transaction if well replies early so need to release
              // if it has SPI error it should return via here anyway
              if (internal && this.processPending[entry.$umid]?.responded) {
                this.release(entry.$umid);
              }

              if (this.processPending[entry.$umid]) {
                this.processPending[entry.$umid].finished = true;
              }
              if (!this.processPending[entry.$umid]?.responded) {
                ActiveTiming.mark(entry.$umid, "host.resolve");
                resolve(response);

                try {
                  this.processPending[entry.$umid].responded = true;
                  ActiveLogger.debug("Client Response TX : " + entry.$umid);
                } catch { }
              }
            },
            reject: (response: any) => {
              //setTimeout(() => {
              //this.release(entry);
              if (this.processPending[entry.$umid]) {
                this.processPending[entry.$umid].finished = true;
              }
              if (!this.processPending[entry.$umid]?.responded) {
                reject(response);
                try {
                  this.processPending[entry.$umid].responded = true;
                } catch { }
              }
              //}, 10);
            },
            pid: 0,
            finished: false,
            responded: false,
          };
          // Need to check it doesn't exist
          // If this was the entry node it already chhecked so filter
          if (entry.$tx.$expire && remoteAddr !== this.host) {
            if (await this.dbConnection.exists(`${entry.$umid}:umid`)) {
              if (entry.$nodes) {
                entry.$nodes[this.reference] = {
                  vote: false,
                  commit: false,
                  error: `Transaction Exists : ${entry.$umid}`,
                };
              } else {
                entry.$nodes = {
                  [this.reference]: {
                    vote: false,
                    commit: false,
                    error: `Transaction Exists : ${entry.$umid}`,
                  },
                };
              }
              return this.processPending[entry.$umid].resolve({
                status: 200,
                data: entry,
              });
            }
          }

          this.processQueue(entry, internal);

          // If this is internal and broadcast should just resolve? Why hold it open for the first one.
          if (internal && entry.$broadcast) {
            this.processPending[entry.$umid].responded = true;
            return resolve({
              status: 200,
              data: { ok: true },
              dontRelease: true,
            });
          }
        } else {
          // If we have it and didn't find it, Lets return this request, However
          // do we need to manage the existing one? Possibly stuck? play safe
          // resolve with what we know
          return resolve({
            status: 200,
            data: this.processPending[entry.$umid].entry,
            dontRelease: true,
          });
        }
      } catch (error) {
        ActiveLogger.error(error, "Host pending failed : " + entry?.$umid);
        reject(error);
      }
    });
  }

  /**
   * Should this node run the P2P TCP server (`p2pStreamServer`)
   *
   * @private
   * @static
   */
  private static p2pServerWanted(): boolean {
    return ActiveOptions.get<boolean>("p2pStreamServer", false);
  }

  /**
   * One P2P connection: frames of [SenderRef (40)][Length (4)][Payload] are
   * read off the socket as they arrive and each is handed to the endpoints
   *
   * @private
   * @param {net.Socket} socket
   */
  private p2pConnection(socket: net.Socket): void {
    // See P2PClient: without this every framed reply waits on Nagle.
    socket.setNoDelay(true);
    ActiveLogger.info(`P2P TCP connection accepted from ${socket.remoteAddress}`);
    let chunks: Buffer[] = [];
    let bufferLength = 0;

    socket.on("data", async (data: Buffer) => {
      chunks.push(data);
      bufferLength += data.length;

      // Frame: [SenderRef (40)][Length (4)][Payload]
      while (bufferLength >= 44) {
        // Peek just the 44-byte header without concatenating the whole
        // buffered backlog - almost always already in chunks[0] alone.
        // A multi-chunk message (e.g. a large contract deploy) used to
        // pay a full Buffer.concat() of everything received so far on
        // every single TCP segment while still waiting for the rest of
        // the frame to arrive - O(n^2) for an n-segment message.
        const header = peekBytes(chunks, 44);
        const length = header.readUInt32BE(40);

        if (bufferLength >= 44 + length) {
          // Frame complete - now it's safe/necessary to do the one
          // full concat needed to slice out the item.
          // (a single chunk, the usual case, needs no copy at all)
          const fullBuffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          const senderRef = fullBuffer.slice(0, 40).toString().trim();
          const item = fullBuffer.slice(44, 44 + length);

          // Clean up consumed data
          const remaining = fullBuffer.slice(44 + length);
          chunks = remaining.length > 0 ? [remaining] : [];
          bufferLength = remaining.length;

          // The frame is already consumed above, so a body that cannot
          // be decoded is dropped here without desyncing the stream or
          // becoming an unhandled rejection from this async handler.
          let tx: any;
          try {
            tx = await ActiveClone.deserialize(item);
          } catch (error) {
            ActiveLogger.warn(
              error,
              `P2P dropped malformed frame from ${socket.remoteAddress} (sender ${senderRef})`
            );
            continue;
          }
          this.processEndpoints(
            {
              headers: { "X-Activeledger": senderRef },
              method: "POST",
              url: "/a/init",
              connection: { remoteAddress: socket.remoteAddress || "127.0.0.1" },
            },
            null as any,
            tx,
            senderRef,
            true
          );
        } else {
          break;
        }
      }
    });
    socket.on("error", (err: Error) => {
      ActiveLogger.error(err, "P2P socket error");
    });

  }

  /**
   * Creates an instance of Host.
   */
  constructor() {
    super();

    // A neighbour lost a frame it had accepted: what we sent it is not delivered
    Neighbour.onDropped = (reference) => this.peerDropped(reference);

    // A neighbour just became home: send it the transactions still in flight
    Neighbour.onHome = (reference) => this.peerHome(reference);

    if (Host.p2pServerWanted()) {
      // Start P2P TCP Server
      this.p2pServer = net.createServer((socket: net.Socket) =>
        this.p2pConnection(socket)
      );

      // P2P port is main port + 1
      const p2pPort = parseInt(ActiveInterfaces.getBindingDetails("port")) + 1;
      this.p2pServer.listen(p2pPort, () => {
        ActiveLogger.info(`P2P TCP server listening on port ${p2pPort}`);
      });
    }

    // Cache db from options
    let db = ActiveOptions.get<any>("db", {});

    // Create connection string
    this.dbConnection = new ActiveDSConnect(db.url + "/" + db.database);
    this.dbConnection.info().catch(Host.dbUnreachable);

    // Create connection string
    this.dbErrorConnection = new ActiveDSConnect(db.url + "/" + db.error);
    this.dbErrorConnection.info().catch(Host.dbUnreachable);

    // Create connection string
    this.dbEventConnection = new ActiveDSConnect(db.url + "/" + db.event);
    this.dbEventConnection.info().catch(Host.dbUnreachable);
    // A transaction resent before a restart can still be reposted
    void this.loadResentGuard();
    void this.loadStoredMarker();

    this.api = App();

    // Hybrid nodes follow the ledger through /h/* (build 40300 and later)
    this.hybridRegistry = new LedgerHybridRegistry(this.dbConnection);
    const hybridApi = new HybridApi({
      db: this.dbConnection,
      events: this.dbEventConnection,
      registry: this.hybridRegistry,
      ledgerConfig: () => {
        const section = ActiveOptions.get<any>("hybrid", {});
        return section && typeof section === "object" && !Array.isArray(section)
          ? section
          : {};
      },
      setupStreamId: () =>
        ActiveOptions.get<string>("network", "").split("@")[0],
      banned: () => Host.hybridBans.set(),
      // Commit attestations are signed when a hybrid asks (the commit only
      // keeps what they are made from), so this process needs the keys
      attest: (umid, revs, facts) =>
        ActiveProtocol.Attestation.attestation(this.reference, umid, revs, facts),
    });
    ActiveProtocol.Attestation.key = Home.identity;
    ActiveProtocol.Attestation.useIdentityFile(
      ActiveOptions.get("identity", "./.identity")
    );
    this.hybridFeeds = registerHybridRoutes(this.api, hybridApi, {
      maxFeeds: () => Host.hybridMaxFeeds(),
    });

    // The same messages over P2P, when the operator opens a port for them
    const hybridListen = Number(ActiveOptions.get<any>("hybrid-listen", 0));
    if (hybridListen) {
      const file = JSON.parse(
        readFileSync(ActiveOptions.get("identity", "./.identity"), "utf8")
      );
      startHybridP2P(hybridApi, this.hybridFeeds, {
        port: hybridListen,
        host: ActiveInterfaces.getBindingDetails("host") as string,
        identity: {
          type: "rsa",
          publicKey: file.pub.pkcs8pem,
          privateKey: file.prv.pkcs8pem,
        },
        maxFeeds: () => Host.hybridMaxFeeds(),
        forward: async (tx, relayer) => {
          const r = await Endpoints.ExternalInitalise(
            this,
            tx,
            `hybrid:${relayer.slice(0, 12)}`,
            this.dbConnection
          );
          return r.content;
        },
      })
        .then(() =>
          ActiveLogger.info(`Hybrid P2P listener on port ${hybridListen}`)
        )
        .catch((e) => ActiveLogger.error(e, "Hybrid P2P listener failed"));
    }

    this.api.any("/*", async (res, req) => {
      /* Can't return or yield from here without responding or attaching an abort handler */
      res.onAborted(() => {
        res.writable = false;
      });
      res.writable = true;

      const headers = {
        "Accept-Encoding": req.getHeader("accept-encoding"),
        "X-Activeledger": req.getHeader("x-activeledger"),
        "x-activeledger-chain": req.getHeader("x-activeledger-chain"),
        "x-activeledger-nonce": req.getHeader("x-activeledger-nonce"),
        "x-activeledger-encrypt": req.getHeader("x-activeledger-encrypt"),
        "content-encoding": req.getHeader("content-encoding"),
        "X-Bundle": req.getHeader("x-bundle"),
      };

      const method = req.getMethod().toUpperCase();
      const url = req.getUrl();

      let ipFrom = Buffer.from(
        res.getProxiedRemoteAddressAsText().byteLength
          ? res.getProxiedRemoteAddressAsText()
          : res.getRemoteAddressAsText()
      ).toString();

      if (ipFrom.indexOf(":") !== -1) {
        // Convert it to ip4 (this should be save as just for firewall)
        const ip6 = this.parseIp6(ipFrom);
        ipFrom =
          (ip6[6] >> 8) +
          "." +
          (ip6[6] & 0xff) +
          "." +
          (ip6[7] >> 8) +
          "." +
          (ip6[7] & 0xff);
      }

      if (method === "POST") {
        // Read from Buffer - bounded, so one request cannot exhaust memory.
        let body: Buffer;
        try {
          body = await this.readBuffer(res, Host.maxRequestBytes);
        } catch {
          // readBuffer has already answered 413, or the client went away.
          return;
        }

        // res.onAborted(()=>{
        //   ActiveLogger.fatal("ABORTED?!?!?");
        // })

        //if (body.length >= contentLength) {
        // gzipped?
        // Sometimes internal transactions fail to be decompressed
        // the header shouldn't be missing but added magic number check as a back
        // all internal transactions are supposed to be compressed failsafe check for when header isn't available?
        if (
          headers["content-encoding"] == "gzip" ||
          (body[0] == 0x1f && body[1] == 0x8b)
        ) {
          try {
            // Bounded by the same limit as the raw body: a few KB of gzip
            // can inflate to gigabytes, and zlib would allocate all of it.
            body = await gunzipAsync(body, {
              maxOutputLength: Host.maxRequestBytes,
            });
          } catch (e: any) {
            if (e?.code === "ERR_BUFFER_TOO_LARGE") {
              return this.rejectTooLarge(res);
            }
            // A body announced as gzip, without the magic number, carries on
            // as it is. One that has the magic number but will not inflate
            // can never be read, so say so rather than leave it unanswered.
            if (body[0] == 0x1f && body[1] == 0x8b) {
              return this.rejectBadBody(res);
            }
          }
        }

        // TODO
        // Fix this makesurenot buffer mess I think it is the sending client

        //const bodyString = body.toString();
        let bodyString: any;
        try {
          bodyString = await this.makeSureNotBuffer(body);
        } catch (e: any) {
          // Inflating or parsing a wrapped body failed: answer, never throw
          // out of the async handler (unhandled rejection, request left open)
          if (e?.code === "ERR_BUFFER_TOO_LARGE") {
            return this.rejectTooLarge(res);
          }
          return this.rejectBadBody(res);
        }

        // could make this nicer
        let bundles: any[]; // = [];

        // TODO we could have the double buffer problem here?
        // unless this has been solved
        if (headers["X-Bundle"]) {
          bundles = bodyString.split(":$ALB:");

          res.cork(() => {
            res.writeStatus("200");
            res.writeHeader("Content-Type", "application/json");
            res.end("{}");
          });
          res.writable = false;
        } else {
          bundles = [bodyString];
        }
        for (let i = bundles.length; i--;) {
          // An empty single body still needs an answer (rejected by the
          // parser); empty bundle parts were already answered above
          if (bundles[i] || !headers["X-Bundle"]) {
            // All posted data should be JSON
            // Convert data for potential encryption
            Endpoints.postConvertor(
              this,
              bundles[i],
              (headers["x-activeledger-encrypt"] as unknown as boolean) || false
            )
              .then((body) => {
                // Post Converted, Continue processing
                this.processEndpoints(
                  {
                    headers,
                    method,
                    url,
                    connection: {
                      remoteAddress: ipFrom,
                    },
                  },
                  res,
                  body.body,
                  body.from
                );
              })
              .catch((error) => {
                // Failed to convery respond;
                ActiveLogger.error(error, "Server POST Parser 500");
                this.writeResponse(
                  res,
                  error.statusCode || 500,
                  JSON.stringify(error.content || { error: 1 }),
                  headers["Accept-Encoding"] as string
                );
              })
              .finally(() => {
                // reuse if not closed
                // dBuf = [];
                // headersEnded = 0;
                // method = path = httpVersion = "";
                // (socket as any).bundled = false;
              });
          }
        }
        //}
      } else {
        if (method === "OPTIONS") {
          await this.writeResponse(res, 200, "{}", "", true);
        } else {
          // Simple get, Continue Processing
          // should be safe to await here to capture undefined and promises to clear below
          // TODO actually make this flow better as when undefined its an internal then
          // process which *could* still be running. Although even if it is resetting below
          // should still be safe.
          await this.processEndpoints(
            {
              headers,
              method,
              url,
              connection: {
                remoteAddress: ipFrom,
              },
            },
            res
          );
        }

        // // reuse if not closed
        // dBuf = [];
        // headersEnded = 0;
        // method = path = httpVersion = "";
      }
    });

    // How many threads (Cache so we can check on ready)
    const physicalCores = PhysicalCores.count();
    const cpuTotal = workerCount(
      ActiveOptions.get<string | number>("cpus", 0),
      physicalCores,
      DEFAULT_WORKER_COUNT(physicalCores)
    );

    // Setup Processors
    const latestSetupMsg = this.getLatestSetup();
    for (let i = 0; i < cpuTotal; i++) {
      // Add process into array
      const processor = this.createProcessor(cpuTotal);
      // Add to list
      this.processors.push(processor);
      // Setup
      processor.send(latestSetupMsg);
    }

    // Create temporary ready to swap out (So it is already set up)
    this.standbyProcess = this.createProcessor(cpuTotal);
    this.standbyProcess.send(latestSetupMsg);

    // Setup Iterator
    this.processorIterator = this.processors[Symbol.iterator]();

    // Start queue failsafe
    this.timerQueue();
  }

  /**
   * The largest request body, compressed or inflated, this node accepts:
   * `security.maxRequestBytes`, 16MB by default. Generous for contract
   * deploys, which are the largest legitimate transactions.
   */
  private static get maxRequestBytes(): number {
    const limit = Number(
      ActiveOptions.get<any>("security", {})?.maxRequestBytes ?? 16 * 1024 * 1024
    );
    return Number.isFinite(limit) && limit > 0 ? limit : 16 * 1024 * 1024;
  }

  /** Answers 413 and closes, for a request over maxRequestBytes. */
  private rejectTooLarge(res: HttpResponse): void {
    if (!res.writable) return;
    res.writable = false;
    res.cork(() => {
      res.writeStatus("413 Payload Too Large");
      res.writeHeader("Content-Type", "application/json");
      res.writeHeader("Connection", "close");
      res.end(JSON.stringify({ error: "Request too large" }), true);
    });
  }

  private rejectBadBody(res: HttpResponse): void {
    if (!res.writable) return;
    res.writable = false;
    res.cork(() => {
      res.writeStatus("400 Bad Request");
      res.writeHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Request body could not be read" }));
    });
  }

  private readBuffer(res: HttpResponse, maxBytes = Infinity): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let refused = false;

      res.onData((ab, isLast) => {
        if (refused) {
          return;
        }
        if (res.aborted) {
          reject(new Error("Request aborted"));
          return;
        }

        received += ab.byteLength;
        if (received > maxBytes) {
          // Stop buffering at once rather than after the whole body has
          // been held in memory.
          refused = true;
          chunks.length = 0;
          this.rejectTooLarge(res);
          reject(new Error("Request too large"));
          return;
        }

        // CRITICAL: Copy the data synchronously now, every return of onData neuters the ArrayBuffer
        if (ab.byteLength > 0) {
          const buffer = Buffer.allocUnsafe(ab.byteLength);
          buffer.set(new Uint8Array(ab));
          chunks.push(buffer);
        }

        if (isLast) {
          resolve(
            chunks.length === 0
              ? Buffer.alloc(0)
              : chunks.length === 1
              ? chunks[0]
              : Buffer.concat(chunks)
          );
        }
      });
    });
  }
  // https://stackoverflow.com/questions/2786632/how-can-i-convert-ipv6-address-to-ipv4-address/23147817#23147817
  private parseIp6(str: string) {
    //init
    var ar = new Array();
    for (var i = 0; i < 8; i++) ar[i] = 0;
    //check for trivial IPs
    if (str == "::") return ar;
    //parse
    var sar = str.split(":");
    var slen = sar.length;
    if (slen > 8) slen = 8;
    var j = 0;
    for (var i = 0; i < slen; i++) {
      //this is a "::", switch to end-run mode
      if (i && sar[i] == "") {
        j = 9 - slen + i;
        continue;
      }
      ar[j] = parseInt("0x0" + sar[i]);
      j++;
    }

    return ar;
  }

  private async makeSureNotBuffer(obj: unknown): Promise<unknown>;
  private async makeSureNotBuffer(obj: {
    type: string;
    data: number[];
  }): Promise<unknown> {
    if (obj.type === "Buffer" && obj.data?.length) {
      // This shouldn't be like that
      // Question is why and where this happens. This solution comes across in research
      // as a global coverage as so far "$i undefined" has has a Buffer with $i instead!
      // Appears to be compressed then turned into a buffer string that gets parsed
      // so probably writer converting but It isn't everytime?
      //ActiveLogger.error(tmp, "Buffer Found");
      if (obj.data[0] == 0x1f && obj.data[1] == 0x8b) {
        return (await gunzipAsync(Buffer.from(obj.data), { maxOutputLength: Host.maxRequestBytes })).toString();
      }
      return Buffer.from(obj.data).toString();
    }

    if (Buffer.isBuffer(obj)) {
      if (obj[0] == 0x1f && obj[1] == 0x8b) {
        return (await gunzipAsync(obj, { maxOutputLength: Host.maxRequestBytes })).toString();
      }
      const tmp = obj.toString();

      if (tmp.startsWith('{"type":"Buffer"')) {
        const asBufferObj = JSON.parse(tmp);

        if (asBufferObj.data[0] == 0x1f && asBufferObj.data[1] == 0x8b) {
          return (
            await gunzipAsync(Buffer.from(asBufferObj.data), { maxOutputLength: Host.maxRequestBytes })
          ).toString();
        }
        return Buffer.from(asBufferObj.data).toString();
      }
      return obj.toString();
    }

    // It should be normal just return!
    return obj;
  }

  /**
   * Retuns latest setup for a subprocess
   *
   * @private
   * @returns {setup}
   */
  private getLatestSetup(): setup {
    // Temp fix to circular problem on crash?
    // Problem with this is it assume right may not have changed
    // everythiung else should be static!
    return {
      type: "setup",
      data: {
        self: Home.host,
        reference: Home.reference,
        right: Home.right,
        neighbourhood: this.neighbourhood.get(),
        pubPem: Home.publicPem,
        privPem: Home.identity.pem,
        db: ActiveOptions.get<any>("db", {}),
        __base: ActiveOptions.get("__base", __dirname),
      },
    };
  }

  /**
   * Creator a processor thread (by process)
   *
   * @private
   * @returns {ChildProcess}
   */
  /**
   * How messages between the host and its workers are encoded. JSON is the
   * default. "advanced" is cheaper to encode and decode, but it keeps what JSON
   * drops (a key set to undefined, a Date as a Date) so it is a switch to try,
   * not yet the default.
   *
   * @private
   * @static
   */
  private static ipcSerialization(): "json" | "advanced" {
    return ActiveOptions.get<string>("ipcSerialization", "json") === "advanced"
      ? "advanced"
      : "json";
  }

  /**
   * Peers' broadcasts reach a worker in runs: several nodes' votes for one
   * transaction arrive in the same event loop turn, and each was its own IPC
   * message (a write, a frame, a parse). Consecutive broadcasts for one worker
   * are held to the end of the turn and sent as one `batch` message, which
   * the worker unpacks in order.
   *
   * The order the worker sees is unchanged: any other message to the same
   * worker sends what is waiting first. Experimental: off unless `ipcBatching: true` is set.
   *
   * @private
   * @param {ChildProcess} child
   */
  private batchBroadcasts(child: ChildProcess): void {
    if (ActiveOptions.get<boolean>("ipcBatching", false) !== true) return;
    const rawSend = child.send.bind(child) as (...a: any[]) => boolean;
    let queued: any[] = [];
    let scheduled = false;

    const flush = (): boolean => {
      scheduled = false;
      if (!queued.length) return true;
      const out = queued;
      queued = [];
      try {
        return out.length === 1
          ? rawSend(out[0])
          : rawSend({ type: "batch", data: { messages: out } });
      } catch (error) {
        // A worker that is going away: the same as a send to one that is gone
        ActiveLogger.warn(error, "Worker message not sent");
        return false;
      }
    };

    (child as any).send = (message: any, ...rest: any[]): boolean => {
      if (message && message.type === "broadcast" && !rest.length) {
        queued.push(message);
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
        return true;
      }
      flush();
      return rawSend(message, ...rest);
    };
  }

  private createProcessor(cpuTotal?: number): ChildProcess {
    // Create Process
    const pFork = fork(`${__dirname}/process.js`, [], {
      cwd: process.cwd(),
      // V8 flags (worker_semi_space) belong to workers only
      execArgv: workerExecArgv(),
      stdio: "inherit",
      // "advanced" sends messages by V8's binary structured clone instead of
      // JSON text (opt-in, see ipcSerialization in the configuration guide)
      serialization: Host.ipcSerialization(),
    }) as StoppableChildProcess;

    // Set useful default
    pFork.stop = false;

    // A message the binary encoding cannot carry goes as JSON would have sent it
    if (Host.ipcSerialization() === "advanced") withJsonFallback(pFork);

    // Runs of peer broadcasts for this worker travel as one message
    this.batchBroadcasts(pFork);

    // Prevent multiple runs, Could overwrite method instead
    let unloadHandled = false;

    // Reusable restart process from error with current scope
    const unloadProcessorSafely = (...error: any[]) => {
      if (unloadHandled || !this.listenSocket) {
        //ActiveLogger.fatal(error, "Processor Crashed - Already Shutting Down");
      } else {
        pFork.stop = unloadHandled = true;
        ActiveLogger.fatal(error, "Processor Crashed");

        // Push standby process
        this.processors.push(this.standbyProcess);

        // We should now create a new standby processor
        this.standbyProcess = this.createProcessor();
        //this.standbyProcess.send(this.getLatestSetup());

        setTimeout(() => {
          this.standbyProcess.send(this.getLatestSetup(), (e) => {
            if (e) {
              ActiveLogger.fatal(e as any, "Issue with new Standby Process");
              // Send it again?
            }
          });
        }, 1000);

        ActiveLogger.fatal(
          pFork,
          "Will Gracefully Shutdown in " + GRACEFUL_PROC_SHUTDOWN
        );
        // Wait for current tansactions to finish (Destroy can take up to 5 minutes)
        setTimeout(() => {
          // Look for any transactions which are in this processor
          ActiveLogger.fatal(pFork, "Starting Graceful Shutdown");
          const pendings = Object.keys(this.processPending);
          pendings.forEach((key) => {
            // Get Transaction
            let pending = this.processPending[key];
            // Was this transaction in the broken processor
            if (pending?.pid === pFork.pid) {
              // This will just resolve all pending transactions in that process pool
              // Wont be graceful but most likely other nodes will have the same conclusion
              // However enough time has passed that it *should* be safe
              // TODO make sure we don't have a single transaction forever extending timeout.
              // Or find a way to move it into another process broadcast timeout is within the 5 minutes
              // Assign general error
              pending.entry.$nodes[this.reference].error =
                "(Contract Thread Error) Unknown - Try Again";

              // Resolve to return oprhened transactions
              pending.resolve({
                status: 200,
                data: pending.entry,
              });

              // setTimeout(() => {
              //   // Remove Locks
              //   this.release(pending);
              // }, 500);
            }
          });

          // Instruct child to terminate. (Clears memory)
          // Even though we should be clear timeout to act as a buffer and
          // push to the end of the event loop
          ActiveLogger.fatal(pFork, "Will Kill in " + KILL_PROC_SHUTDOWN);
          setTimeout(() => {
            ActiveLogger.fatal(pFork, "Sending Kill Signal");
            //Find the bad process
            for (let i = this.processors.length; i--;) {
              if (this.processors[i].pid === pFork.pid) {
                this.processors.splice(i, 1);
                break;
              }
            }
            // const pos = this.processors.findIndex((processor) => {
            //   return processor.pid === pFork.pid;
            // });

            // // Remove from processors list and create new
            // if (pos !== -1) {
            //   this.processors.splice(pos, 1, this.standbyProcess);
            // }
            pFork.kill();
          }, KILL_PROC_SHUTDOWN);
          // Contracts which extend timeout will still be at risk hence the above
        }, GRACEFUL_PROC_SHUTDOWN);
      }
    };

    // Listen for message to respond to waiting http
    pFork.on("message", (m: any) => {
      // Cache Pending Reference
      const pending = this.processPending[m.data.umid];

      // Process may have been cleared by unhandleded process crashing
      if (pending) {
        // Check data for self to update
        // if its early to spread the transaction we don't know its value yet? (will default to false)
        if (m.data.nodes && !m.data.early) {
          pending.entry.$nodes = {
            ...pending.entry.$nodes,
            ...m.data.nodes,
          };
        }

        // Check for revisions if they have been added
        if (m.data.revs && !pending.entry.$revs) {
          pending.entry.$revs = {
            $i: m.data.revs.$i || {},
            $o: m.data.revs.$o || {},
          };
        }
      }

      // Switch on type of messages from processors
      switch (m.type) {
        case "failed":
          if (!pending) return; // Fail safe, May happen when process being closed
          // So if we send as resolve it should still work (Will it keep our error?)
          pending.resolve({
            status: 200,
            data: m.data.entry
              ? { ...pending.entry, ...m.data.entry }
              : pending.entry,
          });

          this.spiFromOwnFailure(pending.entry);

          // Keep it for hybrids when a supernode voted yes (build 40300)
          recordFailed(
            this.dbEventConnection,
            this.dbConnection,
            pending.entry,
            ActiveOptions.get<number>("build", 0)
          );

          break;
        case "commited":
          // The worker sends the broadcast of its own commit in this message
          // when it can, rather than as a message of its own. First, as before.
          if (m.data.broadcast) {
            this.broadcast(m.data.umid, false);
          }
          if (!pending) return; // Fail safe, May happen when process being closed
          this.noteStored(pending.entry.$umid, pending.entry.$tx?.$expire);
          // A node that voted no on a position error still reports "commited"
          // here (Process.failed), with its error on its own entry
          this.spiFromOwnFailure(pending.entry);
          // Process response back into entry for previous neighbours to know the results
          pending.resolve({
            status: 200,
            data: { ...pending.entry, ...m.data.entry },
          });
          // The client has its answer (resolve above), so this costs it
          // nothing. A node that was behind can adopt the network's state
          // through an ordinary commit without SPI ever running - correct,
          // and wanted - but it then holds one umid and none of the history
          // behind it. Check for that gap here rather than only on the SPI
          // path, which this case never touches.
          Endpoints.repairHistoryAfterCommit(
            this,
            pending.entry.$umid,
            // The worker reports which streams this commit updated, so the
            // repair need not read the umid document back to find out. Only
            // when it said so: a reply without streams is unknown, not
            // "none" (a node that is behind replies that way too, and it is
            // the one that needs the repair).
            reportedUpdatedStreams(pending.entry.$nodes?.[this.reference])
          );
          break;
        case "broadcast":
          this.broadcast(m.data.umid, m.data.early);
          break;
        case "reload":
          this.reload();
          break;
        case "ready":
          pFork.ready = true;
          // Check that we should be counting
          if (cpuTotal) {
            // Increase Ready Counter
            this.cpuReady++;
            // If not listening and have enough cpu returns (Covers crashes)
            if (!this.listeing && this.cpuReady >= cpuTotal) {
              // Listen to the Neighbourhood
              this.listeing = true;
              this.api.listen(
                ActiveInterfaces.getBindingDetails("port") as unknown as number,
                (token: us_listen_socket) => {
                  this.listenSocket = token;
                  ActiveLogger.info(
                    "Activeledger listening on port " +
                    ActiveInterfaces.getBindingDetails("port")
                  );
                  Host.onListening?.();
                  this.startCatchup();
                }
              );
              Maintain.healthTimer(true);
            }
          }
          break;
        case "unhandledrejection":
          if (pending) {
            pending.resolve({
              status: 200,
              data: { ...pending.entry, ...m.data.entry },
            });

            // setTimeout(() => {
            //   // Remove Locks
            //   this.release(pending);
            // }, 500);
          }
          if (!m.data.recoverable) {
            // End process and create new subprocess
            unloadProcessorSafely(
              "unhandledrejection - Already Handled, Tidying up processes"
            );
          }
          break;
        case "contractData":
        case "contractLatestVersion":
          // Let other processes know of new version
          this.processors.forEach((processor) => {
            processor.send(m);
          });
          // No need to send to standby it hasn't processed the transaction
          break;
        case "memory":
          // End process and create new subprocess
          unloadProcessorSafely(
            `High Memory Load (${m.data.rss / 1024 / 1024}mb)`
          );
          break;
        default:
          ActiveLogger.fatal(m, "Unknown IPC Call");
          break;
      }
    });

    // Recreate a new subprocessor
    pFork.on("error", unloadProcessorSafely);

    return pFork;
  }

  private listeing = false;

  /**
   * Reload the configuration
   *
   * @private
   */
  private reload() {
    // Reload Neighbourhood
    ActiveOptions.extendConfig()
      .then((config: any) => {
        ActiveLogger.info(
          `Configuration reloaded (network ${ActiveOptions.get<string>("network", "")}, hybrid minVersion ${ActiveOptions.get<any>("hybrid", {})?.minVersion})`
        );
        if (config.neighbourhood) {
          ActiveLogger.debug(config.neighbourhood, "Reset Request");

          // Reference would have changed
          Home.reference = this.reference = ActiveCrypto.Hash.getHash(
            this.host + this.port + ActiveOptions.get<string>("network", ""),
            "sha1"
          );

          // Prepare self for reset
          Home.left = new Neighbour(this.host, this.port);
          Home.right = new Neighbour(this.host, this.port);

          // Reset Network
          this.neighbourhood.reset(config.neighbourhood);

          // Rebuild Network Territory Map
          this.terriBuildMap();

          // The new neighbours start as not home: find them again
          Maintain.restart();
        }

        // Now to make sure all other processors reload
        const reloadMsg = {
          type: "reload",
          data: {
            reference: Home.reference,
            right: Home.right,
            neighbourhood: this.neighbourhood.get(),
          },
        };
        this.processors.forEach((processor) => {
          processor.send(reloadMsg);
        });
        this.standbyProcess.send(reloadMsg);
      })
      .catch((e: any) => {
        ActiveLogger.info(e, "Failed to reload Neighbourhood");
      });
  }

  /**
   * Let go of everything about a finished transaction except this node's
   * answer (see voteonly.ts). Safe to call more than once.
   *
   * @private
   * @param {string} umid
   */
  private keepVoteOnly(umid: string): void {
    const pending = this.processPending[umid];
    if (pending && !pending.voteOnly) {
      this.processPending[umid] = voteOnlyRecord(
        umid,
        pending.entry,
        this.reference,
        pending.pid
      );
      this.processPending[umid].token = pending.token;
    }
  }

  /**
   * Attempt to clear memory for GV
   *
   * @private
   * @param {*} umid
   */
  private destroy(umid: string, skipTimeout = false): void {
    // Make sure it hasn't ben removed already
    if (this.processPending[umid]) {
      // Set to shutdown so broadcast can stop
      this.processPending[umid].shutdown = true;

      // Pass destory message to processor
      this.findProcessor(this.processPending[umid].pid)?.send({
        type: "destory",
        data: {
          umid,
          skipTimeout,
        },
      });

      if (!skipTimeout) {
        // Keep in memory to manage inbound broadcasts, but only this node's
        // answer: a late peer needs nothing else
        this.keepVoteOnly(umid);
        setTimeout(() => {
          delete this.processPending[umid];
        }, releaseTailMs());
      }
    }
  }

  /**
   * Broadcast Transaction to the network
   *
   * @private
   * @param {string} umid
   */
  private broadcast(
    umid: string,
    early = false,
    noreply = false,
    only?: string[]
  ): void {
    // Prevent duplicate broadcast loops
    if (this.processPending[umid] && this.processPending[umid].broadcasting) {
      return;
    }

    // Final check object exists
    if (
      this.processPending[umid]?.entry &&
      this.processPending[umid].entry.$broadcast &&
      this.processPending[umid].entry.$nodes &&
      //this.processPending[umid].entry.$nodes[this.reference] && // early wont have this now
      (early ||
        (this.processPending[umid].entry.$nodes[this.reference] &&
          "vote" in this.processPending[umid].entry.$nodes[this.reference])) // only return if there is a vote or early
      //(!noreply && !this.processPending[umid].finished) // Only send if not finished, if finished we have no real interest
    ) {
      // A reply to one node does not take the in-flight flag (see below)
      if (!only) {
        this.processPending[umid].broadcasting = true;
      }
      ActiveLogger.debug(`Broadcasting TX ($$NR ${noreply}) : ` + umid);

      // Get all the neighbour nodes
      let neighbourhood = this.neighbourhood.get();
      let nodes = this.neighbourhood.keys();
      let promises: any[] = [];

      // Skip sending if leader
      // TODO detect leader!
      //this.processPending[umid].entry.$nodes

      // We only want to send our value, and only once it's resolved - an
      // unresolved early placeholder must never be sent as if it were a
      // real vote, regardless of why broadcast() was called (early flag
      // here only affects $$noreply, not whether our own data is ready).
      // Note: when early=true the outer if above allows entry even when
      // $nodes[this.reference] doesn't exist yet (see the commented-out
      // check above), so this must not assume it's set.
      const selfEntry = this.processPending[umid].entry.$nodes[this.reference];
      const data = selfEntry && !selfEntry.early
        ? Object.assign(this.processPending[umid].entry, {
            $nodes: {
              [this.reference]: selfEntry,
            },
          })
        : Object.assign(this.processPending[umid].entry, {
          $nodes: {},
        });

      // We need a proper copy to modify that way we still keep the original in memory for the tx
      // const data = ActiveClone.clone(this.processPending[umid].entry);
      // if (!early) {
      //   data.$nodes = {
      //     [this.reference]:
      //       this.processPending[umid].entry.$nodes[this.reference],
      //   };
      // } else {
      //   data.$nodes = {};
      // }

      // Experienced a blank target from above assign, Double check to prevent bad loop
      if (data) {
        data.$$noreply = noreply;
        if (early) {
          // If early we don't need a response
          data.$$noreply = true;
        }
        // Every peer gets the same data, so serialise it once (on the first
        // peer that takes the P2P path; HTTP peers never ask) and share the
        // buffer rather than encoding it per peer.
        //
        // A reply to the one node that just sent us this transaction goes
        // out as the vote alone: that node holds the transaction, and for one
        // it holds a peer's frame is only read for its $nodes, so the
        // $tx / $revs / $sigs it would carry again are about 70% of the
        // bytes. Only on the P2P path and only when asked for (the HTTP and
        // secured paths send `data` as before).
        const slim =
          only &&
          data.$$noreply &&
          ActiveOptions.get<boolean>("p2pSlimReplies", true) !== false
            ? {
                $umid: data.$umid,
                $broadcast: data.$broadcast,
                $nodes: data.$nodes,
                $$noreply: data.$$noreply,
              }
            : undefined;
        let serialised: Promise<Buffer> | undefined;
        const serialiseOnce = () =>
          serialised || (serialised = Neighbour.serialiseParams(slim ?? data));

        // What this node's own response looks like now, to tell later whether a
        // neighbour already has it
        const ourSignature =
          selfEntry && !selfEntry.early && Host.quietReplies()
            ? nodeSignature(selfEntry)
            : undefined;

        // Loop them all and broadcast the transaction
        for (let i = nodes.length; i--;) {
          let node = neighbourhood[nodes[i]];
          // TODO the entry.$nodes check only valid for leader? It can probably be reduced for non leaders

          // Make sure they're home and not us
          if (
            node.isHome &&
            node.reference !==
            this
              .reference /*&& !this.processPending[umid].entry.$nodes[node.reference]*/ &&
            (!only || only.includes(node.reference))
          ) {
            // Need to detect if we have already sent and got response for nodes for performance
            promises.push(
              node.knock("init", data, false, 0, true, serialiseOnce).then((answer: any) => {
                if (ourSignature !== undefined) {
                  const held = this.processPending[umid];
                  if (held) (held.sentVote ||= {})[node.reference] = ourSignature;
                }
                return answer;
              })
            );
          } else if (
            !only &&
            node.reference !== this.reference &&
            this.processPending[umid].entry.$leaderOk === true &&
            this.processPending[umid].entry.$origin === this.reference
          ) {
            // A leader transaction is committed here without waiting for the
            // others, and nothing later asks whether a node got it. A node
            // this one has marked unreachable (a link that stalled under load
            // and is already answering again) would skip it for good and fall
            // behind until its stream is next written. So it is also sent
            // there, once, without waiting: a node that is really down fails
            // the send and nothing else changes.
            const held = this.processPending[umid];
            const sent = (held.leaderExtra ||= new Set<string>());
            if (!sent.has(node.reference)) {
              sent.add(node.reference);
              ActiveLogger.warn(`${umid} leader transaction also sent to ${node.reference}, which is not marked home`);
              node.knock("init", data, false, 0, true, serialiseOnce).catch(() => undefined);
            }
          }
        }

        // Listen for promises
        //
        // A reply to a single requester (only) never set the broadcasting
        // flag, so it must not clear it either: a full broadcast may have
        // started since, and its flag is not ours to drop. Its failure path
        // is unchanged.
        Promise.all(promises)
          .then(() => {
            if (!only) {
              this.processPending[umid].broadcasting = false;
              // Our vote is out: give a neighbour that never answers a nudge
              if (ourSignature !== undefined) this.armResend(umid, 0);
            }
            // As it is bundled we don't get a response. We need to trigger rebroadcast
          })
          .catch(() => {
            if (!only) {
              this.processPending[umid].broadcasting = false;
            }
            // Keep broadcasting until promises fully resolve
            // Could be down nodes (So they can have 5 minute window to get back up)
            // Or connection issues. This doesn't stop commit phase as they will eventually call us.
            setTimeout(() => {
              this.broadcastResolver(umid);
            }, 250);
          });
      }
    }
  }

  /**
   * Whether to leave a reply unsent: p2pQuietReplies is on, the neighbour that
   * asked is known, our current response (vote, or commit data) was already
   * handed to it, and the transaction does not use inter node comms, whose
   * data travels in these responses and is always answered as before.
   */
  private quietReply(
    umid: string,
    recipients: string[] | undefined,
    incoming: ActiveDefinitions.LedgerEntry
  ): boolean {
    if (!Host.quietReplies() || !recipients || recipients.length !== 1) return false;
    const held = this.processPending[umid];
    const own = held?.entry?.$nodes?.[this.reference];
    if (!held || !own || own.early) return false;
    if (Host.usesInterNodeComms(held.entry) || Host.usesInterNodeComms(incoming)) {
      return false;
    }
    return held.sentVote?.[recipients[0]] === nodeSignature(own);
  }

  /** Does any response in this entry carry inter node comms data */
  private static usesInterNodeComms(entry?: ActiveDefinitions.LedgerEntry): boolean {
    const nodes: any = entry?.$nodes;
    if (!nodes) return false;
    for (const reference of Object.keys(nodes)) {
      if (nodes[reference]?.incomms) return true;
    }
    return false;
  }

  /** Has this node heard from the neighbour about the transaction (its vote, held here or already passed to the worker) */
  private heardFrom(held: process, reference: string): boolean {
    const node: any = held.entry?.$nodes?.[reference];
    return (node && node.vote !== undefined) || held.sentNodes?.[reference] !== undefined;
  }

  /**
   * The backup for the fast lane. When a neighbour has not sent its vote a
   * while after ours went out, send ours to it again (it answers with its
   * own), then again after twice the wait, up to five times. In a healthy
   * network every vote arrives within milliseconds and this does nothing.
   */
  private armResend(umid: string, attempt: number): void {
    if (!Host.quietReplies() || attempt > 4) return;
    const held = this.processPending[umid];
    const token = held?.token;
    const timer = setTimeout(() => {
      const now = this.processPending[umid];
      if (!now || now.finished || now.token !== token) return;
      const hood = this.neighbourhood.get();
      const silent = this.neighbourhood
        .keys()
        .filter((ref: string) => hood[ref].isHome && ref !== this.reference && !this.heardFrom(now, ref));
      if (!silent.length) return;
      // Whatever we thought they had, they have not answered it
      for (const ref of silent) if (now.sentVote) delete now.sentVote[ref];
      this.broadcast(umid, false, false, silent);
      this.armResend(umid, attempt + 1);
    }, Host.resendMs() * 2 ** attempt);
    timer.unref?.();
  }

  /**
   * A neighbour has just become home (first found, or back after being down).
   * A broadcast only goes to neighbours already counted as home, so a
   * transaction that was voted on while this one was up but not yet noticed
   * never reached it, and nothing else would send it (the resend timer only
   * chases neighbours that were home and went quiet). Send it every
   * transaction still in flight.
   *
   * Finished transactions are not sent: that neighbour catches up on them the
   * way a node that was down does (SPI, restore).
   */
  private peerHome(reference: string): void {
    if (reference === this.reference) return;
    for (const umid of Object.keys(this.processPending)) {
      const held = this.processPending[umid];
      if (!held || held.finished) continue;
      // Whatever we thought it had, it has not got it
      if (held.sentVote) delete held.sentVote[reference];
      this.replayTo(umid, reference, 0);
    }
  }

  /**
   * Sends one in-flight transaction to one neighbour. A full broadcast that is
   * still going out skipped this neighbour (it was not home when that one
   * began), so wait for it to finish rather than be dropped by its flag.
   */
  private replayTo(umid: string, reference: string, attempt: number): void {
    const held = this.processPending[umid];
    if (!held || held.finished) return;
    if (held.broadcasting) {
      if (attempt < 20) {
        const timer = setTimeout(() => this.replayTo(umid, reference, attempt + 1), 50);
        timer.unref?.();
      }
      return;
    }
    // Only a neighbour that is still home; broadcast() sends nothing before
    // this node has voted, and sends to everyone once it has
    if (!this.neighbourhood.get(reference)?.isHome) return;
    this.broadcast(umid, false, false, [reference]);
  }

  /** A neighbour accepted frames it could not write: nothing sent to it recently counts as delivered */
  private peerDropped(reference: string): void {
    for (const umid of Object.keys(this.processPending)) {
      const held = this.processPending[umid];
      if (held.sentVote) delete held.sentVote[reference];
    }
  }

  /**
   * Resolves broadcasted results
   *
   * @private
   * @param {string} umid
   */
  private broadcastResolver(umid: string): void {
    // Check access to the protocol
    if (this.processPending[umid] && this.processPending[umid].entry) {
      // Recast as connection errors found.
      ActiveLogger.warn("Rebroadcasting : " + umid);
      this.broadcast(umid);
    } else {
      // No longer in memory. Create a new error document outside protocol
      // We could have comitted but no idea we may have needed a rebroadcast back.
      const doc = {
        code: 1610,
        processed: false,
        umid: umid,
        // simulate tx for restore
        transaction: {
          $broadcast: true,
          $tx: {},
          $revs: {},
        },
        reason: "Failed to rebroadcast while in memory",
      };

      // Fire and forget, but post() can now reject on a real write failure
      // (see levelme.ts) - this call site has nothing awaiting it, so an
      // unhandled rejection would otherwise result.
      this.dbErrorConnection.post(doc).catch((error) => {
        ActiveLogger.error(error, "Failed to write rebroadcast-failure error document");
      });
    }
  }

  /**
   * TODO: Need to merge with labelOrKey@protocol/process.ts
   *
   * @private
   * @param {*} txIO
   * @param {boolean} [outputs=false]
   * @returns {string[]}
   */
  private labelOrKey(txIO: any): string[] {
    // Get reference for input or output
    const keys = Object.keys(txIO || {});
    const out: string[] = [];

    for (let i = keys.length; i--;) {
      // So we can have multisig without having to hold lock on same stream
      if (!txIO[keys[i]].$sigOnly) {
        // Stream label or self
        out.push(this.filterPrefix(txIO[keys[i]].$stream || keys[i]));
      }
    }
    return out;
  }

  /**
   * Filters Prefix for labelorkey locking
   *
   * @private
   * @param {string} streamId
   * @returns {string}
   */
  private filterPrefix(streamId: string): string {
    // If id length more than 64 trim the start
    if (streamId.length > 64) {
      streamId = streamId.slice(-64);
    }

    // Return just the id
    return streamId;
  }

  /**
   * Trigger a hold of the stream locks that the process wants to own
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} v
   * @param {number} retries
   */
  private hold(v: ActiveDefinitions.LedgerEntry, retries = 0, queuedAt = 0): boolean {
    // Build a list of streams to lock
    // Would be good to cache this
    // let input = Object.keys(v.$tx.$i || {});
    // let output = Object.keys(v.$tx.$o || {});

    // Ask for locks
    // Use set to filter unique then back to array (or in loop)

    if (!v.$$labelOrKey) {
      const outputs = this.labelOrKey(v.$tx.$o);
      if (!v.$selfsign) {
        v.$$labelOrKey = [
          ...new Set([...this.labelOrKey(v.$tx.$i), ...outputs]),
        ];
      } else {
        v.$$labelOrKey = outputs;
      }
    }

    // A transaction that has only just arrived waits behind the ones already queued for the same streams. Without
    // that it could take a lock in the instant between one holder letting go and the queue's next scan, and run
    // before an earlier transaction on the stream that is still waiting. A node where that happens runs a later
    // revision of the stream before an earlier one: it votes "position incorrect" on it, falls a revision behind
    // the nodes that kept the order, and has to be repaired by SPI, which under load never catches up.
    const behindQueued = retries === 0 && !v.$nolock && (v.$$labelOrKey || []).some((s) => this.queuedStreams.has(s));
    if (
      // Selfsigning and can lock on output if any
      // don't need to use set for unique
      !behindQueued &&
      Locker.hold(v.$$labelOrKey, v.$umid)
    ) {
      // Get next process from the array
      const robin = this.getRobin();
      // Make sure we have the response object
      if (!this.processPending[v.$umid].entry.$nodes)
        // Make sure it exists
        if (!this.processPending[v.$umid].entry.$nodes) {
          this.processPending[v.$umid].entry.$nodes = {};
        }

      // Setup this node response
      this.processPending[v.$umid].entry.$nodes[Home.reference] = {
        vote: false,
        commit: false,
        early: true
      };

      // Remember who got selected
      this.processPending[v.$umid].pid = robin.pid || 0;

      //setTimeout(() => {
      // Pass transaction to sub processor
      ActiveTiming.mark(v.$umid, "host.dispatch");
      robin.send({
        type: "tx",
        entry: this.processPending[v.$umid].entry,
      });
      // small scaling delay to put to back of stack
      //}, retries * 1);

      return true;
    } else {
      if (v.$nolock) {
        if (v.$broadcast) {
          // Other nodes will hang, posibly just defautl to vote no
          this.processPending[v.$umid].entry.$nodes = {
            [this.reference]: {
              vote: false,
              commit: false,
              error: "Busy Locks",
            },
          };
          this.broadcast(v.$umid, false, true);
          // How long does it stay in memory I wonder
          ActiveLogger.warn(
            this.processPending[v.$umid],
            `${v.$umid} busy lock broadcasting that fact`
          );
        }
        this.processPending[v.$umid].reject({
          status: 100,
          error: "Busy Locks",
        });
      } else {
        if (retries === 0) {
          // Push to the end of the queue
          this.queuedAdd(v.$$labelOrKey);
          (v.$revs
            ? this.busyLocksQueue.internal
            : this.busyLocksQueue.external
          ).push({
            running: false,
            entry: v,
            retry: 1,
            queuedAt: Date.now(),
          });
        } else {
          // Detect internal transaction read below for more information
          const internal = v.$revs ? true : false;
          // const maxRetries = internal
          //   ? 2
          //   : ActiveOptions.get<number>("queue_retry", 5);

          // We could set this really high as every new transaction (unrelated) will increase
          // the counter. So it will eventually send (unless crashed) no matter how high
          // so possibly a safe timeout should be used.
          // queue_retry, if someone explicitly set it, still means what it
          // always did. Left unset, how long this has waited decides - see
          // QUEUE_MAX_WAIT_MS.
          const configuredRetryCap = ActiveOptions.get<number>("queue_retry", 0);
          const waited = queuedAt ? Date.now() - queuedAt : 0;
          const giveUp = configuredRetryCap
            ? retries > configuredRetryCap
            : waited > QUEUE_MAX_WAIT_MS;
          if (giveUp) {
            // $origin check will mean if this is the entry node and is locked it will
            // still send around the network. Broadcast will fail. So for now if entry is locked
            // defaulting to queue attempt to unlock. Otherwise busy locks could be spammed. Doesn't mean
            // in the future we can enable it. For now if entry node isn't locked then it will continue regardless
            if (/*v.$origin || */ internal) {
              // Internal Request (So need to respond as expected + forward on if not broadcast)
              // Some network conditions wont have this set
              if (!v.$nodes) {
                v.$nodes = {};
              }
              v.$nodes[this.reference] = {
                vote: false,
                commit: false,
                error: "IBL01",
              };

              // Internal Busy Locks, Safe to track
              // const doc = {
              //   code: 1100,
              //   processed: false,
              //   umid: v.$umid,
              //   transaction: v,
              //   locker: Locker.getLocks(),
              //   reason: "Internal Busy Locks",
              // };

              // // Return
              // this.dbErrorConnection.post(doc);

              // Not Broadcast & Not Last
              if (!v.$broadcast && Home.right.reference != v.$origin) {
                // Forward on to the next node and compile responses back
                (async () => {
                  let next: any;
                  try {
                    next = await Home.right.knock("init", v);
                  } catch (e) {
                    // Right is unreachable, respond with our failure alone
                    next = { data: {} };
                  }
                  this.processPending[v.$umid].resolve({
                    status: 200,
                    data: { ...v, ...next.data },
                  });
                })();
              } else {
                this.broadcast(v.$umid, false, true);
                // Respond back with our failure
                this.processPending[v.$umid].resolve({
                  status: 200,
                  data: v,
                });
              }
            } else {
              // External Request
              this.processPending[v.$umid].reject({
                status: 100,
                error: "Busy Locks",
              });
            }

            // Not always safe but i/o position incorrect will help
            //this.release(this.processPending[v.$umid]);
            // True so it is "handled" and removed from the queue in a single location
            return true;
          }
        }
      }
      return false;
    }
  }

  /**
   * Gets next processor in the list (Doesn't account for load)
   *
   * @private
   * @returns {ChildProcess}
   */
  private getRobin(): ChildProcess {
    // Get next processes in queue
    let robin = this.processorIterator.next().value;

    // Do we need to reset?
    if (!robin) {
      this.processorIterator = this.processors[Symbol.iterator]();
      return this.getRobin();
    }

    // Has this processor been told to stop
    if (robin.stop) {
      return this.getRobin();
    }

    // One that is still setting up only holds what it is sent, so give the
    // work to one that is ready, when there is one
    if (
      !(robin as StoppableChildProcess).ready &&
      this.processors.some((p) => {
        const worker = p as StoppableChildProcess;
        return worker.ready && !worker.stop;
      })
    ) {
      return this.getRobin();
    }

    return robin;
  }

  /**
   * Committed umids whose $expire has not passed, kept as one set per minute of
   * $expire, so "was this transaction already committed?" (asked for every
   * transaction with an $expire) can be answered without a call to the storage.
   * A whole minute is dropped at once when it has passed. See mayBeStored().
   */
  private storedByMinute = new Map<number, Set<string>>();
  private storedCount = 0;
  /**
   * Minutes of $expire for which memory cannot say "no": a commit whose $expire was
   * too far ahead to hold, or that did not fit. Only a transaction with an $expire
   * in one of these minutes is looked up (the same bytes are the same $expire).
   * Numbers only, never umids.
   */
  private storedUnknown = new Set<number>();
  /** Past STORED_UNKNOWN_MAX minutes: until this time memory cannot say "no" to anything */
  private storedUnknownAllUntil = 0;
  /** After a start memory knows nothing of what was committed before it */
  private storedColdUntil = Date.now() + STORED_WINDOW_MS;
  private storedSwept = 0;
  /** Has the `storedfar:` list been read since this node started? Until it has memory cannot say "no" */
  private storedMarkerLoaded = false;
  private storedMarkerLoading?: Promise<void>;
  private storedMarkerTried = 0;
  /** Minutes already on disk as a `storedfar:` row, so a second commit in one writes nothing */
  private storedMarkerWritten = new Set<number>();

  private static minuteOf(ms: number): number {
    return Math.floor(ms / 60000);
  }

  /**
   * Called for every transaction this node commits (and every umid it adopts). A
   * committed transaction can only be reposted until its $expire (after that it is
   * refused as expired), so the umid is held until then and no longer: memory holds
   * only the live ones, not the history. One too far ahead, or past the cap, is
   * not held; only its minute of $expire is noted, and a `storedfar:` row keeps
   * that over a restart.
   *
   * @param {string} umid
   * @param {unknown} expire The transaction's $expire
   */
  public noteStored(umid: string, expire: unknown): void {
    if (STORED_WINDOW_MS <= 0 || !expire) return;
    const until = new Date(expire as string).getTime();
    const now = Date.now();
    if (!Number.isFinite(until) || until <= now) return;
    const minute = Host.minuteOf(until);
    if (until > now + STORED_WINDOW_MS || this.storedCount >= STORED_MAX) {
      this.markUnknown(minute, until);
      return;
    }
    if (now - this.storedSwept > 1000) {
      this.storedSwept = now;
      const current = Host.minuteOf(now);
      for (const [m, set] of this.storedByMinute) {
        if (m < current) {
          this.storedCount -= set.size;
          this.storedByMinute.delete(m);
        }
      }
      for (const m of this.storedUnknown) if (m < current) this.storedUnknown.delete(m);
    }
    let set = this.storedByMinute.get(minute);
    if (!set) this.storedByMinute.set(minute, (set = new Set()));
    if (!set.has(umid)) {
      set.add(umid);
      this.storedCount++;
    }
  }

  private markUnknown(minute: number, until: number): void {
    // The row first, whether or not memory has room: it is what a restart reads,
    // and a minute that did not fit must not be forgotten by one
    this.writeStoredMarker(minute);
    if (this.storedUnknown.size >= STORED_UNKNOWN_MAX && !this.storedUnknown.has(minute)) {
      this.storedUnknownAllUntil = Math.max(this.storedUnknownAllUntil, until);
      return;
    }
    this.storedUnknown.add(minute);
  }

  /** One `storedfar:<minute>` row per such minute, so a restart does not forget it */
  private writeStoredMarker(minute: number): void {
    if (this.storedMarkerWritten.has(minute)) return;
    this.storedMarkerWritten.add(minute);
    this.dbEventConnection
      .post({ _id: `storedfar:${minute}`, minute, until: (minute + 1) * 60000 })
      .catch((error: unknown) => {
        this.storedMarkerWritten.delete(minute);
        ActiveLogger.error({ error }, "Could not record a far-off $expire commit; a restart would forget it");
      });
  }

  /**
   * Reads the rows once at start. If the storage cannot answer, memory simply says
   * "maybe" to everything (the storage is asked, as before) and tries again later.
   */
  public loadStoredMarker(): Promise<void> {
    if (STORED_WINDOW_MS <= 0 || this.storedMarkerLoaded) return Promise.resolve();
    if (this.storedMarkerLoading) return this.storedMarkerLoading;
    if (Date.now() - this.storedMarkerTried < 5000) return Promise.resolve();
    this.storedMarkerTried = Date.now();
    this.storedMarkerLoading = (async () => {
      try {
        const list = await this.dbEventConnection.allDocs({ startkey: "storedfar:", endkey: "storedfar:x", include_docs: true });
        if (!list || !Array.isArray(list.rows)) throw new Error("no answer");
        const now = Date.now();
        for (const row of list.rows as any[]) {
          const doc = row?.doc ?? row;
          if (!doc?._id) continue;
          if (Number(doc.until) > now) {
            this.storedMarkerWritten.add(Number(doc.minute));
            if (this.storedUnknown.size < STORED_UNKNOWN_MAX) this.storedUnknown.add(Number(doc.minute));
            else this.storedUnknownAllUntil = Math.max(this.storedUnknownAllUntil, Number(doc.until));
          } else await this.dbEventConnection.purge(doc).catch(() => undefined);
        }
        this.storedMarkerLoaded = true;
      } catch (error) {
        ActiveLogger.warn(`Could not read the far-off $expire rows, asking the storage meanwhile: ${(error as Error)?.message ?? error}`);
      } finally {
        this.storedMarkerLoading = undefined;
      }
    })();
    return this.storedMarkerLoading;
  }

  /**
   * Might this transaction already be committed on this node, so that the
   * storage has to be asked? false is a definite "no" and is only given when
   * memory can know: not just after a start, not before the far-off rows have
   * been read, not for an $expire in a minute memory could not hold a commit
   * for, and only for an $expire inside the window (a later one may have been
   * committed before this process started, or so long ago it is no longer held).
   *
   * @param {string} umid
   * @param {number} expire The transaction's $expire in ms
   * @returns {boolean}
   */
  public mayBeStored(umid: string, expire: number): boolean {
    if (STORED_WINDOW_MS <= 0) return true;
    if (!this.storedMarkerLoaded) {
      // Not read yet (the storage can come up after the host): ask the storage, and try again
      void this.loadStoredMarker();
      return true;
    }
    const now = Date.now();
    if (now < this.storedColdUntil || now < this.storedUnknownAllUntil) return true;
    if (!(expire <= now + STORED_WINDOW_MS)) return true;
    const minute = Host.minuteOf(expire);
    if (this.storedUnknown.has(minute)) return true;
    return this.storedByMinute.get(minute)?.has(umid) === true;
  }

  /**
   * Until when a repost of a transaction this node resent must be refused. Zero
   * (the usual state, always, on a network that never resends) means there is
   * nothing to look up and the check costs one comparison. See rememberResent().
   */
  private resentGuardUntil = 0;
  /** Rows being written right now, so a repost in the same instant is still caught. Empty within milliseconds. */
  private resentInFlight = new Map<string, string>();
  private resentTimer?: NodeJS.Timeout;
  /** Has the `resent:` list been read since this node started? Until it has, a lookup waits for it. */
  private resentLoaded = false;
  private resentLoading?: Promise<void>;

  /**
   * The entry node resends a transaction under a new umid when it fails on every
   * node and it then repairs its own streams (SPI). The replaced umid is never
   * stored, so "Transaction Exists" cannot see it, and the same signed bytes
   * reposted before their $expire would run a second time under it.
   *
   * It is this node's own record, as everything outside consensus is: the
   * other nodes are not told, and a repost entering one of them is not caught
   * by it.
   *
   * So the umid being replaced is recorded: a `resent:<umid>` row in the events
   * database (disk, not memory), and one timestamp here, the latest $expire of
   * any live row. Nothing is held per transaction: with no resend the guard is
   * zero and a transaction is never looked up. Only a transaction with an
   * $expire is recorded, since without one the node stamps the time into the
   * umid and the same bytes can never produce it again.
   *
   * @param {string} replaced The umid being given up
   * @param {string} replacement The umid the transaction is resent under
   * @param {unknown} expire The transaction's $expire
   */
  public rememberResent(replaced: string, replacement: string, expire: unknown): void {
    const until = expire ? new Date(expire as string).getTime() : NaN;
    if (!Number.isFinite(until) || until <= Date.now()) return;
    this.resentGuardUntil = Math.max(this.resentGuardUntil, until);
    this.resentInFlight.set(replaced, replacement);
    this.dbEventConnection
      .post({ _id: `resent:${replaced}`, to: replacement, until })
      .then(
        () => void this.resentInFlight.delete(replaced),
        (error: unknown) => {
          // The row did not get written, so memory is all there is: keep it until the transaction expires
          ActiveLogger.error({ replaced, error }, "Could not record a resent transaction; refusing a repost from memory only");
          setTimeout(() => this.resentInFlight.delete(replaced), Math.max(0, until - Date.now())).unref();
        }
      );
    this.startResentHousekeeping();
  }

  /**
   * The umid a transaction was resent under, if this node resent it and the
   * transaction has not expired; otherwise undefined.
   *
   * @param {string} umid
   * @returns {Promise<string | undefined>}
   */
  public async resentAs(umid: string): Promise<string | undefined> {
    // Just after a start the list may not be read yet (the storage can come up
    // after the host), and "nothing was resent" must not be answered before it is.
    // Holds the request for up to five seconds for it, then refuses to answer: the
    // caller tells the client to try again
    if (this.resentLoading && !this.resentLoaded) await this.waitForResentList();
    if (Date.now() >= this.resentGuardUntil) return undefined;
    const inFlight = this.resentInFlight.get(umid);
    if (inFlight) return inFlight;
    const row = await this.dbEventConnection.get(`resent:${umid}`).catch(() => null);
    // An answer that is not a row is a definite "not resent". No answer at all (the
    // call failed) is not: while a resend is live it must not be taken as one
    if (row === null || row === undefined) throw new Error("could not check whether the transaction was resent");
    return typeof row.to === "string" && Number(row.until) > Date.now() ? row.to : undefined;
  }

  /**
   * Reads the list once at start, so a restart does not forget what was resent.
   * There is no loop in the background: if the storage is not up yet, a
   * transaction with an $expire that arrives before the list has been read does the
   * retrying itself (waitForResentList), and is told to try again if it cannot.
   */
  public loadResentGuard(): Promise<void> {
    this.resentLoading = this.refreshResentGuard(false).then(() => undefined);
    return this.resentLoading;
  }

  private resentWaiting?: Promise<void>;

  /**
   * Holds a request while the list is read, trying every half second for up to
   * RESENT_LOAD_WAIT_MS, shared by every request waiting at once. Throws if it
   * cannot be read, because "nothing was resent" cannot be said without it.
   */
  private waitForResentList(): Promise<void> {
    this.resentWaiting ??= (async () => {
      try {
        await this.resentLoading;
        for (let attempt = 0; !this.resentLoaded && attempt < RESENT_LOAD_WAIT_MS / 500; attempt++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500).unref());
          await this.refreshResentGuard(false);
        }
      } finally {
        this.resentWaiting = undefined;
      }
      if (!this.resentLoaded) throw new Error("the list of resent transactions has not been read yet");
    })();
    return this.resentWaiting;
  }

  /**
   * Reads the `resent:` rows: removes the ones whose transaction has expired and
   * sets the guard to the latest of the rest. Runs at start (loadResentGuard) and
   * about hourly. A failed read is tried again in 30 s unless the caller does its
   * own retrying; until it succeeds the guard from before stays. Says whether it
   * read the list.
   */
  public async refreshResentGuard(retryLater = true): Promise<boolean> {
    let latest = 0;
    try {
      const list = await this.dbEventConnection.allDocs({ startkey: "resent:", endkey: "resent:x", include_docs: true });
      if (!list || !Array.isArray(list.rows)) throw new Error("no answer");
      const now = Date.now();
      // With include_docs the storage answers each row as the document itself
      for (const row of list.rows as any[]) {
        const doc: { _id: string; _rev?: string; until?: number } | undefined = row?.doc ?? row;
        if (!doc?._id) continue;
        if (Number(doc.until) > now) latest = Math.max(latest, Number(doc.until));
        else await this.dbEventConnection.purge(doc).catch(() => undefined);
      }
    } catch (error) {
      if (retryLater) {
        ActiveLogger.warn(`Could not read the resent transactions, trying again in 30s: ${(error as Error)?.message ?? error}`);
        setTimeout(() => void this.refreshResentGuard(), 30_000).unref();
      }
      return false;
    }
    this.resentGuardUntil = Math.max(latest, this.resentInFlight.size ? this.resentGuardUntil : 0);
    this.resentLoaded = true;
    // Housekeeping only exists where there is something to look after
    if (latest > 0) this.startResentHousekeeping();
    return true;
  }

  private startResentHousekeeping(): void {
    if (this.resentTimer) return;
    this.resentTimer = setInterval(() => void this.refreshResentGuard(), 60 * 60 * 1000);
    this.resentTimer.unref();
  }

  /**
   * Trigger a release of the stream locks the process owns
   *
   * @private
   * @param {string} v
   * @param {boolean} noWait Don't wait to release
   */
  //private release(entry: ActiveDefinitions.LedgerEntry) {
  public release(umid: string, owner?: ActiveDefinitions.LedgerEntry) {
    // A caller cleaning up after its own failed pending() passes the entry it
    // submitted. If the pending entry under this umid isn't that object, it
    // belongs to another submission (e.g. the original a replay collided with,
    // possibly mid-commit) and its locks aren't ours to free.
    if (owner && this.processPending[umid] && this.processPending[umid].entry !== owner) {
      ActiveLogger.warn(umid, "Not releasing, pending entry belongs to another submission");
      return;
    }
    // Already down to the vote, there are no locks left to free
    if (this.processPending[umid]?.voteOnly) {
      return;
    }
    if (this.processPending[umid]) {
      const entry = this.processPending[umid].entry;
      // Ask for releases - hold() already computed and cached this on the
      // entry, no need to redo the $i/$o walk here (recomputing ignored the
      // $selfsign/dedupe logic hold() applies too, which is harmless for
      // release - Locker.release() is idempotent per key - but still wasted
      // work on every single transaction completion).
      Locker.release(
        entry.$$labelOrKey || [
          ...this.labelOrKey(entry.$tx.$i),
          ...this.labelOrKey(entry.$tx.$o),
        ],
        entry.$umid
      );

      // Keep the transaction in memory for a while (releaseHoldSeconds, 1 minute by
      // default) so a late peer vote still finds it
      //
      // Only the umid is captured, the timers must not keep the entry alive.
      // A little after the transaction finishes (releaseStubSeconds, once the
      // worker has had time to send everything it is going to) only this
      // node's answer is kept for the rest of the hold.
      const hold = releaseHoldMs();
      const stub = releaseStubMs();
      // A forced restart can put a new record under this umid before these
      // fire, they must leave it alone
      const token = (this.processPending[umid].token ||= {});
      const mine = () => this.processPending[umid]?.token === token;
      if (stub < hold) {
        setTimeout(() => mine() && this.keepVoteOnly(umid), stub);
      }
      setTimeout(() => {
        if (mine()) {
          this.destroy(umid);
        }
      }, hold);

      // Re-check the queue now that these locks are free.
      //
      // Locker.release() above is synchronous, so by this point nobody holds
      // them - this only has to escape the current call stack, which is what
      // setImmediate does. The 200ms timer this replaces made a queued writer
      // wait a fifth of a second for a lock that was already available, which
      // on a quiet node (where nothing else drives the queue) was most of its
      // latency: two writers on one stream cost 68ms instead of 23ms, and
      // eight cost 153ms instead of 46ms.
      //
      // Only safe alongside the deadline above. On its own, against the old
      // retry count, the faster passes burned all 35 retries before the queue
      // drained and rejected roughly half of 80 contending writers in one run
      // out of three.
      // 0 means next tick; anything else waits. Overridable without a
      // redeploy, so a deployment that dislikes either end can move.
      this.scheduleQueueRecheck(QUEUE_RECHECK_MS);

      // And do not wait for that scan to serve the one queued for these
      // streams: hand them over now (see handOff()).
      const freed = entry.$$labelOrKey;
      if (freed?.some((s) => this.queuedStreams.has(s))) {
        setImmediate(() => this.handOff(freed));
      }
    } else {
      ActiveLogger.warn(umid, "Trying to release unknown umid");
    }
  }
  private processingBLQ = false;
  private lastQueueScan = 0;

  /**
   * Gives streams that have just been released to the first transaction
   * queued for them, without waiting for the next scan.
   *
   * The scan serves one transaction per stream and runs at most every
   * QUEUE_SCAN_MIN_MS, which caps a contended stream at about 50 a second.
   * Clients on a busy stream send faster than that, so once a node queued,
   * its queue only grew, until entries waited out QUEUE_MAX_WAIT_MS and the
   * node fell behind the others. Here the pace is how fast transactions
   * commit. Order is kept: an entry is passed over if one ahead of it
   * is waiting for any of the same streams. The scan stays as the backstop,
   * for everything this does not reach.
   *
   * @private
   * @param {string[]} freed streams that were released
   */
  private handOff(freed: string[]) {
    if (this.processingBLQ) return;
    this.processingBLQ = true;
    try {
      const wanted = new Set(freed);
      for (const kind of ["internal", "external"] as const) {
        const queue = this.busyLocksQueue[kind];
        const ahead: Set<string> = new Set();
        for (let i = 0; i < queue.length; i++) {
          const streams = queue[i].entry.$$labelOrKey || [];
          const blocked = streams.some((s) => ahead.has(s));
          streams.forEach((s) => ahead.add(s));
          if (blocked || !streams.some((s) => wanted.has(s))) continue;
          if (this.hold(queue[i].entry, queue[i].retry++, queue[i].queuedAt)) {
            this.queuedRemove(streams);
            queue.splice(i--, 1);
            // These streams are handled for this release
            streams.forEach((s) => wanted.delete(s));
            if (!wanted.size) return;
          }
        }
      }
    } finally {
      this.processingBLQ = false;
    }
  }
  private queueRecheckPending = false;

  /**
   * Looks at the lock queue again after `ms`, unless a look is already
   * waiting. One waiting scan covers every release that came before it runs,
   * so a burst of releases costs one scan, not one each.
   *
   * @private
   * @param {number} ms 0 means the next tick
   */
  private scheduleQueueRecheck(ms: number) {
    if (this.queueRecheckPending) return;
    this.queueRecheckPending = true;
    const run = () => {
      this.queueRecheckPending = false;
      this.processQueue();
    };
    if (ms > 0) {
      setTimeout(run, ms);
    } else {
      setImmediate(run);
    }
  }

  /**
   * Manages the busy lock queue
   *
   * @private
   * @param {ActiveDefinitions.LedgerEntry} [next]
   */
  private processQueue(next?: ActiveDefinitions.LedgerEntry, internal = false) {
    // If Internal and not broadcast let it skip the queue
    // let skipped = false;
    // if (next && internal /* && !next.$broadcast */) {
    //   this.hold(next);
    //   skipped = true;
    // }

    // Run through the queue in order to process
    if (!this.processingBLQ) {
      // See QUEUE_SCAN_MIN_MS. Too soon after the last scan: let a new
      // transaction try its own streams and leave the queue for a scan
      // that is due; with nothing new, make sure that scan happens.
      const queued = this.busyLocksQueue.internal.length + this.busyLocksQueue.external.length;
      // Nothing waiting, which is nearly always (this runs for every new
      // transaction): there is nothing to scan, so no scan state to set up.
      if (!queued) {
        if (next) this.hold(next);
        return;
      }
      const since = Date.now() - this.lastQueueScan;
      if (QUEUE_SCAN_MIN_MS > 0 && since < QUEUE_SCAN_MIN_MS) {
        if (next) {
          this.hold(next);
        } else {
          this.scheduleQueueRecheck(QUEUE_SCAN_MIN_MS - since);
        }
        return;
      }
      this.lastQueueScan = Date.now();
      this.processingBLQ = true;

      // Checked identities. This prevents trying to lock the same stream multiple times in one queue run.
      const checked: Set<string> = new Set();

      // Process internal queue first
      if (this.busyLocksQueue.internal.length) {
        const stillPending: BusyLockQueue[] = [];
        busyQueueInternal: for (let i = 0; i < this.busyLocksQueue.internal.length; i++) {
          const labelOrKey = this.busyLocksQueue.internal[i].entry.$$labelOrKey;
          if (labelOrKey?.length) {
            if (labelOrKey.some((io) => checked.has(io))) {
              // Not tried this pass (an earlier entry owns the stream), but
              // still waiting: keep it, in order, for the next pass.
              stillPending.push(this.busyLocksQueue.internal[i]);
              continue busyQueueInternal;
            }
            labelOrKey.forEach((io) => checked.add(io));
          }

          if (!this.hold(this.busyLocksQueue.internal[i].entry, this.busyLocksQueue.internal[i].retry++, this.busyLocksQueue.internal[i].queuedAt)) {
            // If hold fails, add it to the list of items to keep for the next run.
            stillPending.push(this.busyLocksQueue.internal[i]);
          } else {
            this.queuedRemove(this.busyLocksQueue.internal[i].entry.$$labelOrKey);
          }
        }
        this.busyLocksQueue.internal = stillPending;
      }

      if (next && internal) {
        this.hold(next);
      }

      // Process external queue
      if (this.busyLocksQueue.external.length) {
        const stillPending: BusyLockQueue[] = [];
        for (let i = 0; i < this.busyLocksQueue.external.length; i++) {
          if (!this.hold(this.busyLocksQueue.external[i].entry, this.busyLocksQueue.external[i].retry++, this.busyLocksQueue.external[i].queuedAt)) {
            stillPending.push(this.busyLocksQueue.external[i]);
          } else {
            this.queuedRemove(this.busyLocksQueue.external[i].entry.$$labelOrKey);
          }
        }
        this.busyLocksQueue.external = stillPending;
      }

      if (next && !internal) {
        this.hold(next);
      }
      this.processingBLQ = false;
    } else {
      if (next) {
        this.hold(next);
      }
    }
  }

  /**
   * Checks the queue periodically to prevent timeouts
   * better to return as a busy lock
   *
   * @private
   */
  private timerQueue() {
    setTimeout(() => {
      this.processQueue();
      this.timerQueue();
    }, TIMER_QUEUE_INTERVAL);
  }

  /**
   * Process Activeledger request endpoints
   *
   * @private
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {*} [body]
   */
  private processEndpoints(
    req: {
      headers: {
        [index: string]: string;
      };
      method: string;
      url: string;
      connection: {
        remoteAddress: string;
      };
    },
    res: HttpResponse,
    body?: any,
    from?: string,
    isP2P = false,
  ) {
    // Internal or External Request
    let requester = (req.headers["X-Activeledger"] as string) || "NA";

    // Promise Response
    let response: Promise<any>;

    const started = Date.now();

    // Can we return compressed data?
    let gzipAccepted = req.headers["Accept-Encoding"] as string;

    // Diffrent endpoints VERB
    switch (req.method) {
      case "GET":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/a/locks": // Network Status Request
            return this.writeResponse(
              res,
              200,
              JSON.stringify({ L: Locker.getLocks(), Q: this.busyLocksQueue }),
              gzipAccepted
            );
          case "/a/locks/check": // Network Status Request
            Locker.checkLocks();
            return this.writeResponse(
              res,
              200,
              JSON.stringify({ checked: true }),
              gzipAccepted
            );
          case "/a/status": // Network Status Request
            response = Endpoints.status(
              this,
              requester,
              req.headers["x-activeledger-chain"] as string,
              req.connection.remoteAddress
            );
            break;
          case "/a/hello": // Signed neighbour hello
            if (!Neighbour.helloEnabled) {
              // Behaving as a node from before the hello (tests only)
              return this.writeResponse(res, 404, "Not Found", gzipAccepted);
            }
            response = Endpoints.hello(
              this,
              requester,
              req.headers["x-activeledger-chain"] as string,
              req.headers["x-activeledger-nonce"] as string,
              req.connection.remoteAddress
            );
            break;
          case "/a/hybrid/status": // activeledger hybrid status
          case "/a/hybrid/list": // activeledger hybrid list
          case "/a/hybrid/feeds": // activeledger hybrid feeds
            if (!isLoopback(req.connection.remoteAddress)) {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            if (req.url === "/a/hybrid/status") {
              const attest = ActiveProtocol.Attestation;
              response = hybridStatus(
                this.hybridRegistry,
                this.hybridFeeds,
                Host.hybridMaxFeeds(),
                {
                  build: ActiveOptions.get<number>("build", 0),
                  requiredBuild: attest.BUILD,
                  section: ActiveOptions.get<any>("hybrid", undefined),
                  signing: !attest.enabled()
                    ? "off"
                    : attest.signer() === attest.attestKey
                      ? "ed25519"
                      : "rsa",
                  attestKeyHeld: !!attest.attestKey,
                }
              ).then((content) => ({ statusCode: 200, content }));
              break;
            }
            response =
              req.url === "/a/hybrid/list"
                ? listHybrids(
                    this.hybridRegistry,
                    this.hybridFeeds,
                    Host.hybridBans.set()
                  ).then((content) => ({ statusCode: 200, content }))
                : Promise.resolve({
                    statusCode: 200,
                    content: feedsStatus(this.hybridFeeds, Host.hybridMaxFeeds()),
                  });
            break;
          case "/a/all": // All Stream Management
            if (this.firewallCheck(requester, req.connection.remoteAddress)) {
              response = Endpoints.all(this.dbConnection);
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            break;
          case "/a/admin-reload":
            // Enabling "remote" allows the reload; it does not make the
            // endpoint public. Only this node's own host or a neighbour in
            // the network may trigger it.
            if (
              ActiveOptions.get<boolean>("remote", false) &&
              !this.isLoopback(req.connection.remoteAddress) &&
              !this.firewallCheck(requester, req.connection.remoteAddress)
            ) {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            if(!ActiveOptions.get<boolean>("remote", false)) {
              return this.writeResponse(
                res,
                200,
                JSON.stringify({
                  status: "failed",
                  message: "remote disabled"
                }),
                gzipAccepted
              );
            }

            try {
              // 1. Reload the host/master's config.json
              ActiveOptions.parseConfig();
              ActiveLogger.enableDebug = ActiveOptions.get<boolean>("debug", false);

              // 2. Broadcast the reload signal to all child processes
              this.reload();

              ActiveLogger.info(
                "Host and child processes config.json reloaded successfully via admin API"
              );

              return this.writeResponse(
                res,
                200,
                JSON.stringify({
                  status: "success",
                  build: ActiveOptions.get("build", 0),
                }),
                gzipAccepted
              );
            } catch (error: any) {
              ActiveLogger.error(error, "Admin reload error");
              return this.writeResponse(
                res,
                200,
                JSON.stringify({
                  status: "failed",
                  message: error.message || "Internal Error"
                }),
                gzipAccepted
              );
            }          
          default:
            // All Stream Management with start point
            if (this.firewallCheck(requester, req.connection.remoteAddress)) {
              if (req.url) {
                // The umid index for a neighbour catching up: /a/umids/<ms>?limit=<n>
                if (req.url.startsWith("/a/umids/")) {
                  const [fromPart, query = ""] = req.url.substr(9).split("?");
                  const limit = new URLSearchParams(query).get("limit");
                  response = Endpoints.umids(
                    this.dbEventConnection,
                    fromPart,
                    limit ? Number(limit) : undefined
                  );
                  break;
                }
                let match = req.url.substr(0, 7);
                switch (match) {
                  case "/a/all/":
                    response = Endpoints.all(
                      this.dbConnection,
                      req.url.substr(7)
                    );
                    break;
                  case "/a/umid":
                    response = Endpoints.umid(
                      this.dbConnection,
                      req.url.substr(8)
                    );
                    break;
                  default:
                    // 404 Not Found
                    return this.writeResponse(
                      res,
                      404,
                      "Not Found",
                      gzipAccepted
                    );
                }
              } else {
                return this.writeResponse(res, 404, "Not Found", gzipAccepted);
              }
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
        }
        break;
      case "POST":
        // Different endpoints switched on calling path
        switch (req.url) {
          case "/": // Setup for accepting external transactions
            response = Endpoints.ExternalInitalise(
              this,
              body,
              req.connection.remoteAddress || "unknown",
              this.dbConnection
            );
            break;
          case "/a/encrypt":
            // @deprecated Kept for compatibility, encrypt client side instead
            // Make sure it was encrypted here
            response = Endpoints.ExternalEncrypt(
              this,
              body,
              (req.headers["x-activeledger-encrypt"] as unknown as boolean) ||
              false,
              this.dbConnection
            );
            // Pass db conntection
            break;
          case "/a/init": // Internal transactions
            if (this.firewallCheck(requester, req.connection.remoteAddress)) {
              response = Endpoints.InternalInitalise(this, body, req.connection.remoteAddress, false, isP2P, requester);
            } else {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            break;
          case "/a/hybrid/ban": // activeledger hybrid ban|unban <keyhash>
          case "/a/hybrid/unban": {
            if (!isLoopback(req.connection.remoteAddress)) {
              return this.writeResponse(res, 403, "Forbidden", gzipAccepted);
            }
            const hash = body?.keyHash;
            const changed =
              req.url === "/a/hybrid/ban"
                ? Host.hybridBans.ban(hash)
                : Host.hybridBans.unban(hash);
            response = Promise.resolve({
              statusCode: changed ? 200 : 400,
              content: changed ? { ok: true } : { error: "unknown or invalid key hash" },
            });
            break;
          }
          case "/a/stream": // Stream Data Management (Activerestore)
            response = Endpoints.streams(this.dbConnection, body, this);
            break;
          default:
            return this.writeResponse(res, 404, "Not Found", gzipAccepted);
        }
        break;
      default:
        return this.writeResponse(res, 404, "Not Found", gzipAccepted);
    }

    // Wait for promise to get the response
    response
      .then((response: any) => {
        let data = response.content || {};
        // Response should be encrypted?
        if (response.content && response.content.$encrypt && from) {
          data = {
            $packet: this.neighbourhood
              .get(from)
              .encryptKnock(JSON.stringify(response.content), true),
            $enc: true,
          };
        }

        // Write Header 
        // All outputs are JSON and
        // The client's answer goes first; the timing line is only a log and
        // is written (a synchronous console write) once it has been sent.
        let logRR: (() => void) | undefined;
        if (data.$umid) {
          ActiveTiming.mark(data.$umid, "http.out");
          const TT = Date.now() - started;
          if (TT > 5) {
            // Only output if umid reduce internal 0ms spam (brtoadcast has to respond now for SPI)
            logRR = () =>
              ActiveLogger.info(
                `[RR] ${data.$umid ? data.$umid : "No Umid"
                } : S=${started}, TT=${TT}ms ${TT > 30000 ? "TTLR" : " OK"
                }`
              );
          }
        }

        // writeResponse() returns immediately for a missing or already
        // finished response (a P2P frame has none; an X-Bundle request is
        // answered early with "{}" and marked unwritable) and would discard
        // the body, so don't pay to stringify it. Keep this condition
        // identical to writeResponse()'s own guard. The $encrypt branch, the
        // http.out mark and the [RR] log still run.
        if (!res || !res.writable) {
          logRR?.();
          return;
        }

        this.writeResponse(
          res,
          response.statusCode,
          JSON.stringify(data),
          gzipAccepted
        );
        logRR?.();
      })
      .catch((error: any) => {
        // Write Header
        // Basic error handling for now. As a lot of errors will still be sent as ok responses.
        ActiveLogger.error(error, "Failed to send response back");
        ActiveLogger.info(
          `[RR] ERROR : S=${started}, TT=${Date.now() - started}ms`
        );
        this.writeResponse(
          res,
          error.statusCode || 500,
          JSON.stringify(error.content || "Something has gone wrong"),
          gzipAccepted
        );
      });
  }

  /**
   * Write the response to the brwoser
   *
   * @private
   * @param {ServerResponse} res
   * @param {number} statusCode
   * @param {(string | Buffer)} content
   * @param {string} encoding
   */
  private async writeResponse(
    res: HttpResponse | null,
    statusCode: number,
    content: string | Buffer,
    encoding: string,
    cors = false
  ) {
    if (!res || !res.writable) {
      // Most likely P2P, Need to make knockright use http
      return;
    }

    // Small responses go out uncompressed even when gzip is accepted. Async
    // zlib runs on libuv's thread pool, shared with LevelDB, so compressing
    // a 1-2KB consensus reply cost more in queueing than it saved on the
    // wire - and the receiving node then paid the same again to inflate it.
    // Clients read Content-Encoding, so either form is understood.
    if (content && encoding == "gzip" && content.length < GZIP_MIN_RESPONSE_BYTES) {
      encoding = "";
    }

    if (content) {
      if (encoding == "gzip") {
        content = await ActiveGZip.gzip(content);
      }
    }

    res.cork(() => {
      res.writeStatus(`${statusCode}`);
      res.writeHeader("Access-Control-Allow-Origin", "*");
      res.writeHeader("X-Content-Type-Options", "nosniff");
      res.writeHeader("X-Frame-Options", "DENY");
      res.writeHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
      res.writeHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none';");

      if (cors) {
        res.writeHeader("Access-Control-Allow-Methods", "GET, POST");
        res.writeHeader("Access-Control-Allow-Headers", "*");
      }

      if (content) {
        res.writeHeader("Content-Type", "application/json");
        if (encoding == "gzip") {
          res.writeHeader("Content-Encoding", "gzip");
        }
        res.end(content);
        res.writable = false;
      }
    });
  }

  /**
   * Checks the local paramters to see if connection is allowed
   *
   * @private
   * @param {string} requester
   * @param {IncomingMessage} req
   * @returns {boolean}
   */
  private isLoopback(remoteAddr?: string): boolean {
    if (!remoteAddr) return false;
    const addr = remoteAddr.startsWith("::ffff:") ? remoteAddr.slice(7) : remoteAddr;
    // The listener folds IPv6 into dotted form before this runs, and "::1"
    // comes out of that as 0.0.0.1.
    return addr === "::1" || addr === "0.0.0.1" || addr.startsWith("127.");
  }

  private firewallCheck(requester: string, remoteAddr: string): boolean {
    // x-forward coulkd be spoofed for now lets not support
    return this.neighbourhood.checkFirewall(remoteAddr, requester)
  }
}
