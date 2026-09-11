/**
 * Transaction profiler for a real, live Activeledger network.
 *
 * Answers "where does the time in a transaction actually go" with
 * measurements rather than reading, by varying one thing at a time
 * against the same harness the live tests use:
 *
 *   - network size (1/2/4 nodes)   isolates consensus round-trips from
 *                                  everything a node does on its own
 *   - key type (rsa/secp256k1)     isolates signature verification
 *   - concurrency (1..32 in flight) separates per-transaction latency from
 *                                  the network's actual throughput ceiling
 *
 * Run: npm run profile:tx     (add --quick for a shorter sweep)
 */

import * as path from "path";
import { ActiveCrypto } from "../../packages/crypto/src";
import { NetworkHarness, NetworkNode } from "./harness";
import { submit } from "./http";
import { registerNamespace, deployContract, Identity } from "./actions";

const QUICK = process.argv.includes("--quick");
/** --only=1,4 runs just those sections - each boots its own networks, so they are independent. */
const ONLY = (process.argv.find(a => a.startsWith("--only=")) || "").replace("--only=", "");
const wants = (section: number) => !ONLY || ONLY.split(",").includes(String(section));

/** Onboards an identity of a given key type - actions.ts's onboard() is rsa-only. */
async function onboardAs(baseUrl: string, type: string): Promise<Identity> {
  const keyPair = new ActiveCrypto.KeyPair(type);
  // secp256k1 defaults to raw 0x-hex keys, which sign() cannot use - it reads
  // prv.pkcs8pem. Ask for the PEM form explicitly.
  const keys = type === "rsa" ? keyPair.generate() : keyPair.generate(256, true);
  const txBody = {
    $namespace: "default",
    $contract: "onboard",
    $i: { identity: { type, publicKey: keys.pub.pkcs8pem } },
    $o: {},
  };
  const tx = { $tx: txBody, $selfsign: true, $sigs: { identity: keyPair.sign(txBody) } };
  const result = await submit(baseUrl, tx);
  if (!result.$streams?.new?.[0]?.id) {
    throw new Error(`Onboard (${type}) failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return { streamId: result.$streams.new[0].id, keyPair };
}

/** One returner-contract transaction against the identity's own stream. */
function runTx(
  baseUrl: string,
  identity: Identity,
  namespace: string,
  contractStreamId: string,
  message: string,
  extra: Record<string, unknown> = {}
): Promise<any> {
  const txBody = {
    $namespace: namespace,
    $contract: contractStreamId,
    $i: { [identity.streamId]: {} },
    $o: { [identity.streamId]: { message, ...extra } },
  };
  const tx = { $tx: txBody, $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) } };
  return submit(baseUrl, tx);
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: at(0.5), p90: at(0.9), max: s[s.length - 1], mean };
}

function fmt(label: string, st: ReturnType<typeof stats>, extra = "") {
  console.log(
    `  ${label.padEnd(26)} n=${String(st.n).padStart(3)}  ` +
    `min=${st.min.toFixed(0).padStart(5)}  p50=${st.p50.toFixed(0).padStart(5)}  ` +
    `p90=${st.p90.toFixed(0).padStart(5)}  max=${st.max.toFixed(0).padStart(5)}  ` +
    `mean=${st.mean.toFixed(1).padStart(6)}ms ${extra}`
  );
}

/**
 * Every harness currently holding ports, so a failure anywhere tears them
 * down. Without this a crashed run leaves four nodes listening on 5510-5540
 * and the *next* run silently measures them instead - which produced a
 * nonsense 1-node p50 of 1521ms with 6 of 10 not committing, until the
 * leftovers were found and killed.
 */
const live = new Set<NetworkHarness>();

async function shutdown(harness: NetworkHarness) {
  live.delete(harness);
  try { await harness.stop(); } catch { /* best effort - cleanup still matters */ }
  try { harness.cleanup(); } catch { /* ditto */ }
}

async function shutdownAll() {
  // Array.from, not [...live] - the repo's tsconfig sets no target (so ES5)
  // and no downlevelIteration, under which spreading a Set yields an empty
  // array instead of failing. That is why an early crash in this script left
  // eight nodes still holding ports: this function ran and iterated nothing.
  const all = Array.from(live);
  for (const harness of all) await shutdown(harness);
}

/** Boots a network, deploys the returner contract, and hands back a ready context. */
async function setup(nodeCount: number, keyType: string, contract = "returner") {
  const harness = new NetworkHarness({ nodeCount });
  live.add(harness);
  const nodes = await harness.start();
  const baseUrl = nodes[0].baseUrl;
  const identity = await onboardAs(baseUrl, keyType);
  const namespace = `prof${Date.now().toString(36)}`;
  await registerNamespace(baseUrl, identity, namespace);
  const contractStreamId = await deployContract(
    baseUrl, identity, namespace, contract,
    path.join(__dirname, "contracts", `${contract}-contract.ts`)
  );
  // Warm up properly before anything is measured. One transaction is not
  // enough: contract compilation, V8's JIT and the connection pools all settle
  // over the first handful, and with a short sample count those stragglers land
  // on the p50 rather than the tail. Warming once put --quick at 15/36ms
  // against the full run's 5/23ms for the same build - a profiler reporting
  // three times the real number is worse than no profiler.
  for (let i = 0; i < 8; i++) {
    await runTx(baseUrl, identity, namespace, contractStreamId, `warm${i}`);
  }
  return { harness, nodes, baseUrl, identity, namespace, contractStreamId, keyType };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Sequential transactions against one stream: pure per-transaction latency. */
async function measureSequential(ctx: Ctx, count: number, label: string, extra: Record<string, unknown> = {}) {
  const samples: number[] = [];
  let failed = 0;
  for (let i = 0; i < count; i++) {
    const t = process.hrtime.bigint();
    const r = await runTx(ctx.baseUrl, ctx.identity, ctx.namespace, ctx.contractStreamId, `m${i}`, extra);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (!r.$streams?.updated?.length) failed++;
  }
  fmt(label, stats(samples), failed ? `(${failed} did not commit)` : "");
  return stats(samples);
}

/**
 * K independent identities transacting at once. Independent streams matter -
 * the same stream would serialise on its own lock and measure contention
 * rather than capacity.
 */
async function measureConcurrent(ctx: Ctx, identities: Identity[], inFlight: number) {
  const chosen = identities.slice(0, inFlight);
  const t = process.hrtime.bigint();
  const results = await Promise.all(
    chosen.map((id, i) => runTx(ctx.baseUrl, id, ctx.namespace, ctx.contractStreamId, `c${inFlight}-${i}`)
      .catch(() => null))
  );
  const wall = Number(process.hrtime.bigint() - t) / 1e6;
  const ok = results.filter(r => r?.$streams?.updated?.length).length;
  console.log(
    `  ${String(inFlight).padStart(3)} in flight  wall=${wall.toFixed(0).padStart(6)}ms  ` +
    `committed=${String(ok).padStart(3)}/${inFlight}  ` +
    `throughput=${(ok / (wall / 1000)).toFixed(1).padStart(6)} tx/s  ` +
    `per-tx=${(wall / Math.max(ok, 1)).toFixed(1).padStart(6)}ms`
  );
  return { inFlight, wall, ok, tps: ok / (wall / 1000) };
}

(async () => {
  const seqCount = QUICK ? 10 : 25;
  console.log(`\nActiveledger transaction profile${QUICK ? " (quick)" : ""}\n${"=".repeat(60)}`);

  const bySize: Record<number, any> = {};
  const byKey: Record<string, any> = {};

  // --- 1. Network size: how much of a transaction is consensus? -----------
  if (wants(1)) {
  console.log(`\n[1] Latency by network size (sequential, one stream, rsa)`);
  for (const nodeCount of QUICK ? [1, 4] : [1, 2, 4]) {
    const ctx = await setup(nodeCount, "rsa");
    try {
      bySize[nodeCount] = await measureSequential(ctx, seqCount, `${nodeCount} node${nodeCount > 1 ? "s" : ""}`);
    } finally {
      await shutdown(ctx.harness);
    }
  }
  }

  // --- 2. Key type: how much is signature verification? -------------------
  if (wants(2)) {
  console.log(`\n[2] Latency by key type (sequential, one stream, 4 nodes)`);
  for (const keyType of ["rsa", "secp256k1"]) {
    const ctx = await setup(4, keyType);
    try {
      byKey[keyType] = await measureSequential(ctx, seqCount, keyType);
    } finally {
      await shutdown(ctx.harness);
    }
  }
  }

  // --- 3. Concurrency: latency vs actual capacity -------------------------
  if (wants(3)) {
  console.log(`\n[3] Throughput by concurrency (4 nodes, independent streams, rsa)`);
  {
    const ctx = await setup(4, "rsa");
    try {
      const levels = QUICK ? [1, 8] : [1, 4, 16, 32, 64, 128];
      const most = Math.max(...levels);
      process.stdout.write(`  onboarding ${most} identities...`);
      const identities: Identity[] = [];
      for (let i = 0; i < most; i++) identities.push(await onboardAs(ctx.baseUrl, "rsa"));
      console.log(" done");
      const curve: any[] = [];
      for (const level of levels) curve.push(await measureConcurrent(ctx, identities, level));

      const best = curve.reduce((a, b) => (b.tps > a.tps ? b : a));
      console.log(`\n  peak: ${best.tps.toFixed(1)} tx/s at ${best.inFlight} in flight`);
    } finally {
      await shutdown(ctx.harness);
    }
  }
  }

  // --- 4. Is consensus transport, or the other nodes repeating the work? ---
  //
  // Adding contract work to a 4-node transaction has two possible shapes. If
  // consensus overlaps the origin's own work, the gap over a 1-node network
  // stays flat as the work grows. If the other nodes only start once the
  // origin has finished, the gap grows with it.
  if (wants(4)) {
  console.log(`\n[4] Does the consensus gap grow with contract work? (sequential, burn contract)`);
  {
    const burns = QUICK ? [0, 20000000] : [0, 5000000, 20000000, 60000000];
    const rows: { burn: number; one: number; four: number }[] = [];
    for (const nodeCount of [1, 4]) {
      const ctx = await setup(nodeCount, "rsa", "burn");
      try {
        for (const iterations of burns) {
          const st = await measureSequential(
            ctx, QUICK ? 8 : 15,
            `${nodeCount} node${nodeCount > 1 ? "s" : ""}, burn=${iterations}`,
            { iterations }
          );
          let row = rows.find(r => r.burn === iterations);
          if (!row) rows.push(row = { burn: iterations, one: 0, four: 0 });
          if (nodeCount === 1) row.one = st.p50; else row.four = st.p50;
        }
      } finally {
        await shutdown(ctx.harness);
      }
    }
    console.log(`\n  burn        1 node    4 nodes    gap`);
    for (const r of rows) {
      console.log(
        `  ${String(r.burn).padStart(9)}  ${r.one.toFixed(0).padStart(6)}ms  ` +
        `${r.four.toFixed(0).padStart(7)}ms  ${(r.four - r.one).toFixed(0).padStart(5)}ms`
      );
    }
    const first = rows[0], last = rows[rows.length - 1];
    const gapGrowth = (last.four - last.one) - (first.four - first.one);
    const workGrowth = last.one - first.one;
    console.log(
      `\n  work added on one node: ${workGrowth.toFixed(0)}ms, ` +
      `gap grew by: ${gapGrowth.toFixed(0)}ms ` +
      `(${workGrowth > 1 ? (gapGrowth / workGrowth).toFixed(2) : "n/a"}x)`
    );
    console.log(
      `  ~1x means the other nodes repeat the work after the origin finishes;` +
      `\n  ~0x means consensus already overlaps it and the gap is fixed overhead.`
    );
  }
  }

  // --- Summary ------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}\nWhat this says`);
  if (bySize[1]?.p50 !== undefined && bySize[4]?.p50 !== undefined) {
    const consensus = bySize[4].p50 - bySize[1].p50;
    console.log(
      `  consensus (4 nodes - 1 node, p50) : ${consensus.toFixed(0)}ms ` +
      `(${((consensus / bySize[4].p50) * 100).toFixed(0)}% of a 4-node transaction)`
    );
    console.log(`  single-node floor (p50)           : ${bySize[1].p50.toFixed(0)}ms`);
  }
  if (byKey.rsa?.p50 !== undefined && byKey.secp256k1?.p50 !== undefined) {
    const d = byKey.rsa.p50 - byKey.secp256k1.p50;
    console.log(`  rsa over secp256k1 (p50)          : ${d >= 0 ? "+" : ""}${d.toFixed(0)}ms`);
  }
  console.log("");
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  await shutdownAll();
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await shutdownAll();
    process.exit(130);
  });
}
