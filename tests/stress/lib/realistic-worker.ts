/**
 * One load-generating thread of the realistic-users tool. Each worker owns a
 * slice of the user population (its own keys, onboarded through the network),
 * and on command runs an open-loop stage: transactions arrive as a Poisson
 * process at the stage's rate whether or not earlier ones have been answered.
 * There is no per-user rate limit; a user simply is not picked again while its
 * previous transaction is still in flight (two at once on one stream would
 * conflict with each other, which no real single-user client does). Signing and HTTP are spread over several threads so the generator
 * is not the bottleneck it would be on one.
 */

import { parentPort, workerData } from "worker_threads";
import { ActiveCrypto } from "../../../packages/crypto/src";
import * as http from "http";
import { requestJson } from "../../network/http";
import { isCommitted, reasonOf } from "./workload";

/** Committed: streams were written, or (a contract that writes no state) the summary shows a commit and no errors. */
const wasCommitted = (r: any): boolean =>
  isCommitted(r) || !!(r && r.$summary && r.$summary.commit > 0 && !(r.$summary.errors && r.$summary.errors.length));

export interface WorkerInit {
  urls: string[];
  namespace: string;
  contractId: string;
  users: number;
  index: number;
}

export interface PrepareCommand {
  type: "prepare";
  /** this worker's share of the offered rate, tx/s */
  rate: number;
  durationSec: number;
  activeUsers: number;
  joinShare: number;
}

export interface StageCommand {
  type: "stage";
  /** this worker's share of the offered rate, tx/s */
  rate: number;
  durationSec: number;
  warmupSec: number;
  /** users taking part in this stage (this worker's share) */
  activeUsers: number;
  /** share of arrivals that are a new user joining instead of an existing user acting, 0..1 */
  joinShare: number;
}

export interface StageResult {
  sent: number;
  /** answered within the measured window */
  measured: number;
  committed: number;
  failed: number;
  latenciesMs: number[];
  reasons: Record<string, number>;
  /** how late the generator's own timer fired, ms (p99 and max) over the stage */
  lagP99Ms: number;
  lagMaxMs: number;
  peakInFlight: number;
  /** arrivals dropped because every user in the pool already had a transaction in flight */
  poolExhausted: number;
  /** transactions that had to be signed during the stage because the pre-signed ones ran out */
  signedInline: number;
  measuredSec: number;
}

interface User {
  streamId: string;
  keyPair: any;
  busy: boolean;
  /** transactions signed in advance, used in order */
  ready: unknown[];
}

const init: WorkerInit = workerData;

/**
 * Connections are kept alive and reused, as a load balancer or any real client
 * library would, with a cap per node so a node that stalls makes requests wait
 * rather than opening connections without end (every timed-out request throws
 * its socket away, and a storm of replacements exhausts the local ports). A fresh TCP connection per request leaves thousands in
 * TIME_WAIT and runs a machine out of local ports (EADDRNOTAVAIL) at a few
 * hundred requests a second, which measures the generator, not the network.
 */
const agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 });
const submit = (baseUrl: string, tx: unknown): Promise<any> => requestJson(baseUrl + "/", "POST", tx, 20000, agent);
const users: User[] = [];
let seq = 0;

const joinsReady: unknown[] = [];

const hotTx = (u: User) => {
  const body = {
    $namespace: init.namespace,
    $contract: init.contractId,
    $i: { [u.streamId]: {} },
    $o: { [u.streamId]: { message: `w${init.index}s${seq++}` } },
  };
  return { $tx: body, $sigs: { [u.streamId]: u.keyPair.sign(body) } };
};

/**
 * Signs, ahead of the clock, every transaction a stage is expected to need
 * (with headroom): a real client signs on its own hardware, so signing is not
 * part of what the network is measured on. Each transaction is unique and is
 * still fully verified by the nodes.
 */
function prepare(cmd: PrepareCommand): void {
  const active = Math.min(cmd.activeUsers, users.length);
  const total = cmd.rate * cmd.durationSec * 1.25 + 50;
  const perUser = Math.ceil((total * (1 - cmd.joinShare)) / active) + 3;
  for (let i = 0; i < active; i++) {
    const u = users[i];
    u.ready.length = 0;
    for (let k = 0; k < perUser; k++) u.ready.push(hotTx(u));
  }
  joinsReady.length = 0;
  for (let k = 0; k < Math.ceil(total * cmd.joinShare) + 5; k++) joinsReady.push(newIdentity().tx);
}

const pick = <T>(xs: T[], i: number): T => xs[i % xs.length];

function onboardBody(pub: string) {
  return { $namespace: "default", $contract: "onboard", $i: { identity: { type: "secp256k1", publicKey: pub } }, $o: {} };
}

function newIdentity(): { keyPair: any; tx: unknown } {
  const keyPair = new ActiveCrypto.KeyPair("secp256k1");
  const keys = keyPair.generate(256, true);
  const body = onboardBody(keys.pub.pkcs8pem);
  return { keyPair, tx: { $tx: body, $selfsign: true, $sigs: { identity: keyPair.sign(body) } } };
}

async function join(i: number): Promise<void> {
  const { keyPair, tx } = newIdentity();
  const r = await submit(pick(init.urls, i), tx);
  const id = r && r.$streams && r.$streams.new && r.$streams.new[0] && r.$streams.new[0].id;
  if (!id) throw new Error(`onboard failed: ${reasonOf(r)}`);
  users.push({ streamId: id, keyPair, busy: false, ready: [] });
}

async function onboardAll(): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: 24 }, async () => {
    while (next < init.users) {
      const i = next++;
      for (let attempt = 0; ; attempt++) {
        try {
          await join(i + init.index);
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
        }
      }
    }
  });
  await Promise.all(lanes);
}

/** Knuth's method; the means here are tiny (rate x a few ms). */
function poisson(mean: number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function runStage(cmd: StageCommand): Promise<StageResult> {
  const active = Math.min(cmd.activeUsers, users.length);
  const stats: StageResult = {
    sent: 0, measured: 0, committed: 0, failed: 0, latenciesMs: [], reasons: {},
    lagP99Ms: 0, lagMaxMs: 0, peakInFlight: 0, poolExhausted: 0, signedInline: 0, measuredSec: 0,
  };
  const lags: number[] = [];
  let inFlight = 0;
  let cursor = Math.floor(Math.random() * active);
  const t0 = Date.now();
  const warmEnd = t0 + cmd.warmupSec * 1000;
  const stopAt = t0 + cmd.durationSec * 1000;
  const pending: Promise<void>[] = [];

  const fire = (now: number) => {
    let tx: unknown;
    let url: string;
    let user: User | undefined;
    if (Math.random() < cmd.joinShare) {
      const j = joinsReady.pop();
      if (!j) stats.signedInline++;
      tx = j || newIdentity().tx;
      url = pick(init.urls, seq++);
    } else {
      let u: User | undefined;
      for (let tries = 0; tries < active; tries++) {
        const c = users[cursor++ % active];
        if (!c.busy) {
          u = c;
          break;
        }
      }
      if (!u) {
        stats.poolExhausted++;
        return;
      }
      u.busy = true;
      user = u;
      const pre = user.ready.pop();
      if (!pre) stats.signedInline++;
      tx = pre || hotTx(user);
      url = pick(init.urls, seq);
    }
    stats.sent++;
    inFlight++;
    if (inFlight > stats.peakInFlight) stats.peakInFlight = inFlight;
    const started = process.hrtime.bigint();
    const measure = now >= warmEnd;
    pending.push(
      submit(url, tx)
        .then((r) => ({ ok: wasCommitted(r), reason: wasCommitted(r) ? undefined : reasonOf(r) }))
        .catch((e) => ({ ok: false, reason: reasonOf(e) }))
        .then((res) => {
          inFlight--;
          if (user) user.busy = false;
          if (!measure) return;
          stats.measured++;
          stats.latenciesMs.push(Number(process.hrtime.bigint() - started) / 1e6);
          if (res.ok) stats.committed++;
          else {
            stats.failed++;
            const key = (res.reason || "unknown").slice(0, 120);
            stats.reasons[key] = (stats.reasons[key] || 0) + 1;
          }
        })
    );
  };

  const TICK = 5;
  let last = Date.now();
  let due = last + TICK;
  while (last < stopAt) {
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
    const now = Date.now();
    lags.push(Math.max(0, now - due));
    const n = poisson((cmd.rate * (now - last)) / 1000);
    for (let i = 0; i < n; i++) fire(now);
    last = now;
    due = now + TICK;
  }
  await Promise.all(pending);
  stats.measuredSec = (stopAt - warmEnd) / 1000;
  stats.lagP99Ms = percentile(lags, 99);
  stats.lagMaxMs = lags.length ? Math.max(...lags) : 0;
  return stats;
}

onboardAll()
  .then(() => parentPort!.postMessage({ type: "ready", users: users.length }))
  .catch((e) => parentPort!.postMessage({ type: "error", message: String(e && e.message ? e.message : e) }));

parentPort!.on("message", (cmd: StageCommand | PrepareCommand) => {
  if (cmd.type === "prepare") {
    try {
      prepare(cmd);
      parentPort!.postMessage({ type: "prepared" });
    } catch (e: any) {
      parentPort!.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    }
    return;
  }
  if (cmd.type !== "stage") return;
  runStage(cmd)
    .then((result) => parentPort!.postMessage({ type: "result", result }))
    .catch((e) => parentPort!.postMessage({ type: "error", message: String(e && e.message ? e.message : e) }));
});
