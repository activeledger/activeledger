/**
 * Hunts a transaction that a node never answered (seen in the 4-node throughput run: "Request timed out after 20000ms").
 * Runs the throughput tool's load (clients writing their own stream one transaction after another, entering at the nodes in
 * turn) for a while, remembers every submit that failed or timed out, and then looks at what each node logged around it.
 *
 *   npx tsx tests/network/lost-tx-trace.ts [seconds] [clients] [nodes] [settle seconds before the load]
 *
 * Logs are copied to /tmp/claude-1000/trace/<start>/ before the network is torn down.
 */

import * as fs from "fs";
import { hotTransaction, setupWorkload, timedSubmit, withNetwork, sleep } from "../stress/lib/workload";
import { storageGet } from "./http";

interface Miss {
  client: number;
  entry: number;
  message: string;
  startedAt: number;
  ms: number;
  reason?: string;
}

async function main(): Promise<number> {
  const seconds = Number(process.argv[2] || 120);
  const clients = Number(process.argv[3] || 8);
  const nodeCount = Number(process.argv[4] || 4);
  const settle = Number(process.argv[5] || 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `/tmp/claude-1000/trace/${stamp}`;
  fs.mkdirSync(dir, { recursive: true });
  const misses: Miss[] = [];
  let sent = 0, committed = 0;

  await withNetwork({ nodeCount, basePort: 5800, readyTimeoutMs: 60000 }, async (_h, nodes) => {
    const w = await setupWorkload(nodes, "returner", clients);
    if (settle) {
      console.log(`settling ${settle} s before the load`);
      await sleep(settle * 1000);
    }
    const stop = Date.now() + seconds * 1000;
    await Promise.all(
      Array.from({ length: clients }, async (_, c) => {
        for (let i = 0; Date.now() < stop; i++) {
          const message = `c${c}-${i}`;
          const startedAt = Date.now();
          const r = await timedSubmit(nodes[c % nodes.length].baseUrl, hotTransaction(w, c, message));
          sent++;
          if (r.committed) committed++;
          else misses.push({ client: c, entry: c % nodes.length, message, startedAt, ms: r.ms, reason: r.reason });
        }
      })
    );
    console.log(`${sent} sent, ${committed} committed, ${misses.length} not committed`);
    await sleep(3000);

    // What did the nodes end up holding for each client's stream?
    for (const m of misses) {
      const id = w.identities[m.client].streamId;
      const docs = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, id).catch(() => null)));
      const seen = docs.map((d: any) => d && d.message);
      const ever = seen.includes(m.message);
      console.log(`miss: client ${m.client} entry node ${m.entry} "${m.message}" after ${Math.round(m.ms)} ms (${String(m.reason).slice(0, 90)}); streams now say ${JSON.stringify(seen)}; the message ${ever ? "WAS written (somewhere)" : "was never written"}`);
    }

    // Keep the logs, and show what each node logged near each miss (warnings and errors, once each)
    nodes.forEach((n, i) => fs.copyFileSync(n.logPath, `${dir}/node${i}.log`));
    for (const m of misses) {
      console.log(`--- around ${new Date(m.startedAt).toISOString()} (client ${m.client}, entry node ${m.entry})`);
      nodes.forEach((n, i) => {
        const seen = new Set<string>();
        const lines = String(fs.readFileSync(n.logPath)).split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
        for (const l of lines) {
          const t = /^\[(\d{13})\]/.exec(l);
          if (!t || !/WARN|ERROR|FATAL/.test(l)) continue;
          const at = Number(t[1]);
          if (at < m.startedAt - 2000 || at > m.startedAt + m.ms + 2000) continue;
          const key = l.replace(/^\[\d+\]\s*/, "").replace(/[0-9a-f]{32,}/g, "<id>").slice(0, 120);
          if (seen.has(key)) continue;
          seen.add(key);
          console.log(`  node ${i}: ${l.slice(0, 220)}`);
        }
      });
    }
  });
  // With ACTIVELEDGER_PROFILE=1 the nodes log a mark per stage per transaction: show every node's marks for the first
  // transactions whose vote round timed out (error 1510), relative to the first mark any node made
  if (process.env.ACTIVELEDGER_PROFILE) {
    const logs = [0, 1, 2, 3].slice(0, nodeCount).map((i) => String(fs.readFileSync(`${dir}/node${i}.log`)).replace(/\x1b\[[0-9;]*m/g, "").split("\n"));
    const timedOut: string[] = [];
    logs.forEach((lines) => {
      lines.forEach((l, i) => {
        if (/TX Error Logged umid : ([0-9a-f]{64})/.test(l)) {
          const umid = /umid : ([0-9a-f]{64})/.exec(l)![1];
          const block = lines.slice(i, i + 12).join(" ");
          if (/"code": 1510/.test(block) && !timedOut.includes(umid)) timedOut.push(umid);
        }
      });
    });
    console.log(`${timedOut.length} transactions with a vote round that timed out (1510)`);
    for (const umid of timedOut.slice(0, 3)) {
      const marks: { node: number; stage: string; at: number }[] = [];
      logs.forEach((lines, node) => lines.forEach((l) => {
        const m = new RegExp(`\\[PROF\\] ${umid} (\\S+) ([0-9.]+)`).exec(l);
        if (m) marks.push({ node, stage: m[1], at: Number(m[2]) });
      }));
      marks.sort((a, b) => a.at - b.at);
      const t0 = marks.length ? marks[0].at : 0;
      console.log(`--- ${umid}: ${marks.length} marks`);
      for (const m of marks.slice(0, 80)) console.log(`  +${(m.at - t0).toFixed(1).padStart(9)} ms node ${m.node} ${m.stage}`);
    }
  }
  console.log(`logs kept in ${dir}`);
  return misses.length ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
