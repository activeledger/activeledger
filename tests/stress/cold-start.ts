/**
 * Cold-start stress tool: boots a fresh network from empty data directories
 * with nodes started at random offsets (sometimes one held back much
 * longer), runs the bootstrap transactions through different nodes, then
 * checks that EVERY node holds the result in its own storage and can take a
 * transaction at its own door. See docs/guide/operate/stress-tests.md.
 *
 *   npm run stress:cold-start -- --runs 20
 */

import * as fs from "fs";
import * as path from "path";
import { Flags, COMMON_FLAGS, FlagSpec, formatTable, runTool } from "./lib/cli";
import { appendRecord, defaultOut, environment } from "./lib/results";
import { fisherExact, pct, wilson } from "./lib/stats";
import { rateResolution } from "./lib/resolution";
import { planColdStart, COLD_PROFILES } from "./lib/plans";
import { NetworkHarness } from "../network/harness";
import { storageGet } from "../network/http";
import { deployContract, onboard, registerNamespace, runContract } from "../network/actions";
import { contractPath, gate, isCommitted, loadNow, reasonOf, sleep } from "./lib/workload";

const SPECS: FlagSpec[] = [
  { name: "runs", type: "number", default: 20, description: "fresh networks to boot and check (the profile sets it: quick 20, standard 100, full 400)" },
  { name: "nodes", type: "number", default: 4, description: "nodes per network" },
  { name: "max-stagger-ms", type: "number", default: 1500, description: "each node starts after a random 0..this many ms" },
  { name: "extra-delay-ms", type: "number", default: 2500, description: "in an extra-delay run, one random node starts this much later still" },
  { name: "extra-probability", type: "number", default: 0.5, description: "chance (0-1) that a run is an extra-delay run" },
  { name: "view-timeout-ms", type: "number", default: 15000, description: "how long a node gets to show each bootstrap stream in its own storage" },
  { name: "seed", type: "number", description: "seed for the stagger choices, to repeat a sequence (default random, printed)" },
  { name: "keep-logs", type: "string", description: "directory to copy every node.log of a failed run into" },
  { name: "max-failure-rate", type: "number", description: "fail (exit 1) if the failure rate (0-1) is above this" },
  ...COMMON_FLAGS,
];

const HELP = `A run fails if a bootstrap transaction fails, if any node does not show the
onboarded identity, the namespace and the deployed contract in its OWN storage
within --view-timeout-ms, or if a transaction entering at any node fails. A
node that missed a stream is recorded as lagged.

Exit status: 0 whenever the tool ran and printed its report, whatever the failure
rate; 1 only if you pass --max-failure-rate and it is exceeded; 2 if it could
not run. A plain build fails roughly 6-12% of runs in the default
(harsh) setting, so use the rate to compare builds, not to demand zero.

Example:
  npm run stress:cold-start -- --runs 30 --max-stagger-ms 1500 --out /tmp/cold.jsonl`;

/** mulberry32: a small seedable generator, so a failing sequence can be replayed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MISSING = /Namespace not found|ENOENT|not found|StreamNotFound|Contract not found/i;

/** The network being run now, so Ctrl-C can take it down. */
let active: NetworkHarness | undefined;

interface Failure {
  stage: string;
  node: number | null;
  msg: string;
}

async function oneRun(f: Flags, random: () => number, runIndex: number, seed: number) {
  const started = Date.now();
  const loadBefore = loadNow();
  const nodeCount: number = f.nodes;
  const offsets = Array.from({ length: nodeCount }, () => Math.floor(random() * (f.maxStaggerMs + 1)));
  const extra = random() < f.extraProbability;
  const extraNode = extra ? Math.floor(random() * nodeCount) : -1;
  if (extra) offsets[extraNode] += f.extraDelayMs;
  const rot = Math.floor(random() * nodeCount);

  const failures: Failure[] = [];
  const lagged: number[] = [];
  const fail = (stage: string, node: number | null, msg: string, lag = false) => {
    failures.push({ stage, node, msg });
    if (node !== null && (lag || MISSING.test(msg)) && !lagged.includes(node)) lagged.push(node);
  };

  const harness = new NetworkHarness({ nodeCount, basePort: f.basePort, readyTimeoutMs: 90000, startOffsetsMs: offsets });
  active = harness;
  let readySecs: number | undefined;
  let logsKept: string | undefined;
  try {
    const nodes = await harness.start();
    readySecs = (Date.now() - started) / 1000;
    const url = (i: number) => nodes[((i % nodeCount) + nodeCount) % nodeCount].baseUrl;
    const attempt = async <T>(stage: string, node: number, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        fail(stage, node, reasonOf(e));
        return undefined;
      }
    };

    // Bootstrap, each step entering at a different node.
    const admin = await attempt("onboard", rot % nodeCount, () => onboard(url(rot)));
    const ns = `c${Date.now().toString(36)}`;
    let namespaceId: string | undefined;
    let contract: string | undefined;
    if (admin) {
      const r = await attempt("namespace", (rot + 1) % nodeCount, () => registerNamespace(url(rot + 1), admin, ns));
      if (r && !isCommitted(r)) fail("namespace", (rot + 1) % nodeCount, reasonOf(r));
      else if (r) namespaceId = r.$streams?.new?.[0]?.id;
      contract = await attempt("deploy", (rot + 2) % nodeCount, () => deployContract(url(rot + 2), admin, ns, "returner", contractPath("returner")));
    }

    // Every node's own storage must show what the network committed.
    const wanted: { what: string; id: string }[] = [];
    if (admin) wanted.push({ what: "onboard", id: admin.streamId });
    if (namespaceId) wanted.push({ what: "namespace", id: namespaceId });
    if (contract) wanted.push({ what: "contract", id: contract });
    const present = async (i: number, id: string) => {
      try {
        const d = await storageGet(nodes[i].storageUrl, id);
        return !!(d && !d.error && (d._id || d._rev));
      } catch {
        return false;
      }
    };
    // Guard against a check that always says yes.
    if (await present(0, "stress-does-not-exist")) fail("local-view", null, "storage view check is not trustworthy: a stream that cannot exist was reported present");
    const missing: string[][] = nodes.map(() => []);
    await Promise.all(
      nodes.map(async (_n, i) => {
        for (const w of wanted) {
          const end = Date.now() + f.viewTimeoutMs;
          let ok = false;
          while (!(ok = await present(i, w.id)) && Date.now() < end) await sleep(250);
          if (!ok) missing[i].push(w.what);
        }
      })
    );
    missing.forEach((m, i) => {
      if (m.length) fail("local-view", i, `node ${i} missing ${m.join(",")} after ${f.viewTimeoutMs}ms`, true);
    });

    // A transaction entering at each node.
    if (admin && contract) {
      for (let k = 0; k < nodeCount; k++) {
        const i = (rot + k) % nodeCount;
        await attempt("entry-onboard", i, () => onboard(url(i)));
        const r = await attempt("entry-run", i, () => runContract(url(i), admin, ns, contract!, { message: `n${i}k${k}` }));
        if (r && !isCommitted(r)) fail("entry-run", i, reasonOf(r), true);
      }
    }
  } catch (e) {
    fail("harness", null, reasonOf(e));
  } finally {
    if (failures.length && f.keepLogs) {
      const keep = path.join(f.keepLogs, `run${runIndex}-${Date.now()}`);
      try {
        fs.mkdirSync(keep, { recursive: true });
        for (let i = 0; i < nodeCount; i++) {
          const log = path.join(harness.root, `instance-${i}`, "node.log");
          if (fs.existsSync(log)) fs.copyFileSync(log, path.join(keep, `node-${i}.log`));
        }
        logsKept = keep;
      } catch {
        // best effort
      }
    }
    await harness.stop().catch(() => undefined);
    try {
      harness.cleanup();
    } catch {
      // already gone
    }
  }

  return {
    tool: "cold-start",
    kind: "run",
    ts: new Date().toISOString(),
    label: f.label,
    profile: f.profile,
    group: `nodes=${nodeCount} stagger=${f.maxStaggerMs} extra=${f.extraDelayMs}@${f.extraProbability}`,
    ...environment(),
    run: runIndex,
    seed,
    pass: failures.length === 0,
    nodes: nodeCount,
    offsets,
    extraNode,
    extra,
    entryRotation: rot,
    lagged: lagged.sort(),
    failures,
    readySecs,
    secs: +((Date.now() - started) / 1000).toFixed(1),
    logs: logsKept,
    loadBefore,
    loadAfter: loadNow(),
  };
}

function rateLine(label: string, runs: any[]): string {
  const failed = runs.filter((r) => !r.pass).length;
  if (!runs.length) return `  ${label.padEnd(14)} no runs`;
  const w = wilson(failed, runs.length);
  return `  ${label.padEnd(14)} ${failed}/${runs.length} failed (${pct(failed / runs.length)}, 95% Wilson CI ${pct(w.low)} to ${pct(w.high)})`;
}

runTool("stress:cold-start", "Fresh network from empty data directories with staggered node starts; verifies every node's own view.", SPECS, HELP, async (f) => {
  const out: string = f.out || defaultOut("cold-start");
  const seed: number = f.seed ?? Math.floor(Math.random() * 2 ** 31);
  const random = prng(seed);
  const onSignal = () => {
    (active ? active.stop().catch(() => undefined) : Promise.resolve()).then(() => {
      try {
        active?.cleanup();
      } catch {
        // already gone
      }
      process.exit(130);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.log(`cold-start: ${f.runs} runs of ${f.nodes} nodes, stagger 0-${f.maxStaggerMs} ms, extra ${f.extraDelayMs} ms with probability ${f.extraProbability}, seed ${seed}`);
  console.log(`results in ${out}`);

  const runs: any[] = [];
  await gate(f);
  for (let i = 0; i < f.runs; i++) {
    const r = await oneRun(f, random, i, seed);
    appendRecord(out, r);
    runs.push(r);
    console.log(
      `  run ${i + 1}/${f.runs}: ${r.pass ? "PASS" : "FAIL"} in ${r.secs}s  offsets ${JSON.stringify(r.offsets)}${r.extra ? ` (node ${r.extraNode} held back)` : ""}` +
        (r.pass ? "" : `  lagged ${JSON.stringify(r.lagged)}  ${r.failures[0].stage}: ${r.failures[0].msg.slice(0, 100)}`)
    );
  }

  const failed = runs.filter((r) => !r.pass);
  const stagger = runs.filter((r) => !r.extra);
  const extra = runs.filter((r) => r.extra);
  const laggedByNode: Record<string, number> = {};
  for (const r of runs) for (const n of r.lagged) laggedByNode[n] = (laggedByNode[n] || 0) + 1;
  const messages = new Map<string, number>();
  for (const r of failed) for (const x of r.failures as Failure[]) {
    const key = `${x.stage}: ${x.msg.slice(0, 120)}`;
    messages.set(key, (messages.get(key) || 0) + 1);
  }
  const fisher =
    stagger.length && extra.length
      ? fisherExact(
          extra.filter((r) => !r.pass).length,
          extra.filter((r) => r.pass).length,
          stagger.filter((r) => !r.pass).length,
          stagger.filter((r) => r.pass).length
        )
      : undefined;
  const w = wilson(failed.length, runs.length);
  appendRecord(out, {
    tool: "cold-start",
    kind: "summary",
    ts: new Date().toISOString(),
    label: f.label,
    group: runs[0]?.group,
    seed,
    runs: runs.length,
    failures: failed.length,
    failureRate: runs.length ? failed.length / runs.length : NaN,
    wilson95: [w.low, w.high],
    staggerOnly: { runs: stagger.length, failures: stagger.filter((r) => !r.pass).length },
    extraDelay: { runs: extra.length, failures: extra.filter((r) => !r.pass).length },
    extraVsStaggerFisherP: fisher,
    laggedByNode,
    failureMessages: Object.fromEntries(messages),
  });

  console.log("");
  console.log(`cold-start results (${f.profile} profile)`);
  console.log(
    formatTable(
      ["set", "runs", "failed", "rate", "95% interval"],
      ([["all runs", runs], ["stagger only", stagger], ["extra delay", extra]] as [string, any[]][]).map(([name, set]) => {
        const k = set.filter((r) => !r.pass).length;
        const w2 = wilson(k, set.length);
        return [name, String(set.length), String(k), set.length ? pct(k / set.length) : "-", set.length ? `${pct(w2.low)} to ${pct(w2.high)}` : "-"];
      })
    )
  );
  console.log(`results written to ${out}`);
  console.log("details");
  console.log(rateLine("all runs", runs));
  console.log(rateLine("stagger only", stagger));
  console.log(rateLine("extra delay", extra));
  if (fisher !== undefined) console.log(`  extra delay vs stagger only, Fisher exact p = ${fisher.toFixed(3)}`);
  console.log(`  lagged nodes (runs per node): ${JSON.stringify(laggedByNode)}`);
  for (const [msg, n] of [...messages].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${msg}`);

  const res = rateResolution(failed.length, runs.length);
  console.log("resolving power (" + f.profile + " profile, " + runs.length + " runs)");
  console.log(`  one failure here stands for ${pct(res.oneFailure)}; the 95% interval is ${pct(res.low)} to ${pct(res.high)}`);
  console.log(`  a second set of ${runs.length} runs could be told apart only if its failure rate were ${Number.isFinite(res.detectableIncrease) ? pct(res.detectableIncrease) + " points higher" : "impossible to tell apart at this size"}`);
  if (res.detectableIncrease > 0.05) console.log("  this run cannot resolve failure rates below about " + (Number.isFinite(res.detectableIncrease) ? pct(res.detectableIncrease) : "any level") + "; a 2% failure needs hundreds of runs (--profile standard or full)");
  appendRecord(out, { tool: "cold-start", kind: "resolution", ts: new Date().toISOString(), profile: f.profile, group: runs[0]?.group, ...res });

  if (f.maxFailureRate !== undefined && runs.length && failed.length / runs.length > f.maxFailureRate) {
    console.error(`FAIL: failure rate ${pct(failed.length / runs.length)} is above --max-failure-rate ${f.maxFailureRate}`);
    return 1;
  }
  return 0;
}, COLD_PROFILES, planColdStart);
