/**
 * Stage-level breakdown of a single transaction, across every process that
 * touches it.
 *
 * profile.ts says what a transaction costs; this says where that cost sits.
 * It runs the network with ACTIVELEDGER_PROFILE=1, which makes ActiveTiming
 * emit one "[PROF] <umid> <stage> <absolute ms>" line per stage, then stitches
 * every node's log back into one timeline per transaction. Absolute
 * timestamps are what makes that possible - the host process, its forked
 * worker, and the other nodes all mark independently and are only comparable
 * because they share a wall clock.
 *
 * Run: npm run profile:stages [-- --nodes=4]
 */

import * as fs from "fs";
import * as path from "path";
import { NetworkHarness } from "./harness";
import { onboard, registerNamespace, deployContract, runContract } from "./actions";

process.env.ACTIVELEDGER_PROFILE = "1";

const NODES = Number((process.argv.find(a => a.startsWith("--nodes=")) || "--nodes=4").split("=")[1]);
const RUNS = Number((process.argv.find(a => a.startsWith("--runs=")) || "--runs=12").split("=")[1]);

interface Mark { umid: string; stage: string; at: number; node: number; }

function readMarks(logPath: string, node: number): Mark[] {
  if (!fs.existsSync(logPath)) return [];
  const out: Mark[] = [];
  for (const raw of fs.readFileSync(logPath, "utf8").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const m = /\[PROF\] (\S+) (\S+) ([0-9.]+)/.exec(line);
    if (m) out.push({ umid: m[1], stage: m[2], at: Number(m[3]), node });
  }
  return out;
}

/** The order stages happen in, so a timeline reads top to bottom. */
const ORDER = [
  "http.in", "host.pending", "host.dispatch", "worker.recv", "worker.start",
  "proto.start", "proto.contractPath", "proto.contractStat",
  "perm.iFetchBegin", "perm.iFetchEnd", "perm.iSigsDone", "proto.inputsChecked",
  "perm.oFetchBegin", "perm.oFetchEnd", "perm.oSigsDone",
  "proto.outputsChecked", "proto.contractDate", "proto.streamsReady", "proto.voted", "proto.commitBegin",
  "db.writeBegin", "db.writeEnd", "proto.commitEnd", "host.resolve", "http.out",
];
const rank = (s: string) => { const i = ORDER.indexOf(s); return i < 0 ? ORDER.length : i; };

/**
 * One stage can be marked several times for the same transaction on the same
 * node: on a multi-node network the origin answers a knock about this umid
 * from every peer, so http.out fires once per answer, not once per client
 * response. Left as-is that turns the origin's timeline into interleaved
 * nonsense ("http.out -> db.writeEnd"). Keep the first occurrence of each
 * stage - when it was first reached - except for http.out, where the last is
 * the one that actually answered the client.
 */
function dedupe(marks: Mark[]): Mark[] {
  const kept: Record<string, Mark> = {};
  marks.forEach((m) => {
    const key = `${m.node}|${m.stage}`;
    const seen = kept[key];
    if (!seen) kept[key] = m;
    else if (m.stage === "http.out" ? m.at > seen.at : m.at < seen.at) kept[key] = m;
  });
  return Object.keys(kept).map((k) => kept[k]);
}

(async () => {
  const harness = new NetworkHarness({ nodeCount: NODES });
  const nodes = await harness.start();
  try {
    const base = nodes[0].baseUrl;
    const id = await onboard(base);
    const ns = `st${Date.now().toString(36)}`;
    await registerNamespace(base, id, ns);
    const contract = await deployContract(base, id, ns, "returner",
      path.join(__dirname, "contracts", "returner-contract.ts"));
    await runContract(base, id, ns, contract, { message: "warm" });
    await new Promise(r => setTimeout(r, 300));

    // Measured runs, recording which umid each produced so warm-up and setup
    // transactions are excluded from the averages below.
    const measured: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const res = await runContract(base, id, ns, contract, { message: `s${i}` });
      if (res.$umid) measured.push(res.$umid);
    }
    await new Promise(r => setTimeout(r, 1200));

    // Plain objects and Array.from throughout: the repo's tsconfig sets no
    // target (so ES5) and no downlevelIteration, under which spreading a Map
    // or Set silently yields an empty array rather than failing - which is
    // exactly how this script first reported "0 stages" over 140 real marks.
    const marks: Mark[] = [];
    nodes.forEach((n, i) => readMarks(n.logPath, i).forEach((m) => marks.push(m)));

    const wanted: Record<string, true> = {};
    measured.forEach((u) => (wanted[u] = true));

    const byUmid: Record<string, Mark[]> = {};
    marks.forEach((mk) => {
      if (!wanted[mk.umid]) return;
      (byUmid[mk.umid] = byUmid[mk.umid] || []).push(mk);
    });
    const umids = Object.keys(byUmid);

    if (!umids.length) {
      console.log(`No [PROF] marks matched (${marks.length} seen, ${measured.length} transactions).`);
      console.log("Is ACTIVELEDGER_PROFILE reaching the nodes?");
      return;
    }

    // --- One full timeline, so the shape is visible ------------------------
    const sampleUmid = umids.filter((u) => byUmid[u].some((m) => m.stage === "http.out"))[0] || umids[0];
    {
      const ms = dedupe(byUmid[sampleUmid]);
      const t0 = Math.min.apply(null, ms.map((m) => m.at));
      console.log(`\nOne transaction, every process that touched it  (${sampleUmid.slice(0, 16)}...)`);
      console.log("=".repeat(72));
      const nodeIds: number[] = [];
      ms.forEach((m) => { if (nodeIds.indexOf(m.node) < 0) nodeIds.push(m.node); });
      nodeIds.sort((a, b) => a - b).forEach((node) => {
        console.log(`  node ${node}${node === 0 ? "  (origin - the one the client called)" : ""}`);
        const own = ms.filter((m) => m.node === node)
          .sort((a, b) => a.at - b.at || rank(a.stage) - rank(b.stage));
        let prev = t0;
        own.forEach((m) => {
          console.log(
            `    +${(m.at - t0).toFixed(2).padStart(8)}ms  ${(m.at - prev).toFixed(2).padStart(7)}ms  ${m.stage}`
          );
          prev = m.at;
        });
      });
    }

    // --- Averaged gaps on the origin node ----------------------------------
    console.log(`\nOrigin-node stage costs, mean over ${umids.length} transactions`);
    console.log("=".repeat(72));
    const gaps: Record<string, number[]> = {};
    const totals: number[] = [];
    umids.forEach((u) => {
      const own = dedupe(byUmid[u]).filter((m) => m.node === 0)
        .sort((a, b) => a.at - b.at || rank(a.stage) - rank(b.stage));
      if (own.length < 2) return;
      totals.push(own[own.length - 1].at - own[0].at);
      for (let i = 1; i < own.length; i++) {
        const key = `${own[i - 1].stage} -> ${own[i].stage}`;
        (gaps[key] = gaps[key] || []).push(own[i].at - own[i - 1].at);
      }
    });
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const total = totals.length ? mean(totals) : 0;
    Object.keys(gaps)
      .map((k) => ({ k, ms: mean(gaps[k]), n: gaps[k].length }))
      .sort((a, b) => b.ms - a.ms)
      .forEach((r) => {
        const share = total ? (r.ms / total) * 100 : 0;
        console.log(
          `  ${r.k.padEnd(44)} ${r.ms.toFixed(2).padStart(7)}ms  ${share.toFixed(0).padStart(3)}%  ` +
          "#".repeat(Math.max(0, Math.round(share / 2)))
        );
      });
    console.log(`  ${"origin total (http.in -> http.out)".padEnd(44)} ${total.toFixed(2).padStart(7)}ms`);
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
