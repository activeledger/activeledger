/**
 * Live check that $territoriality means "this node writes first": for a
 * transaction naming node N, sent in through a different node, N is the first
 * of the four to begin its commit. Reads the commit marks the nodes print when
 * ACTIVELEDGER_PROFILE is set (set below, before the nodes start).
 *
 *   npm run test:network:territorial-order
 */
process.env.ACTIVELEDGER_PROFILE = "1";
import { hotTransaction, setupWorkload, timedSubmit, withNetwork, sleep } from "../stress/lib/workload";
import { requestJson } from "./http";
import * as fs from "fs";
(async () => {
  await withNetwork({ nodeCount: 4, basePort: 5750, readyTimeoutMs: 60000 }, async (_h, nodes) => {
    const w = await setupWorkload(nodes, "returner", 4);
    const refs: string[] = [];
    for (const n of nodes) refs.push((await requestJson(`${n.baseUrl}/a/status`, "GET")).reference);
    const marker = Date.now();
    const sent: { commitAt: number; entry: number }[] = [];
    // Every entry node against every named node, 16 pairs
    const pairs: { commitAt: number; entry: number }[] = [];
    for (let entry = 0; entry < 4; entry++) for (let commitAt = 0; commitAt < 4; commitAt++) pairs.push({ commitAt, entry });
    let unanswered = 0;
    for (let r = 0; r < pairs.length; r++) {
      const { commitAt, entry } = pairs[r];
      const tx: any = hotTransaction(w, r % 4, `o${r}`, false);
      tx.$territoriality = refs[commitAt];
      const res = await timedSubmit(nodes[entry].baseUrl, tx);
      if (!res.committed) { unanswered++; console.log(`  pair entry ${entry} named ${commitAt}: client not told committed: ${res.reason}`); }
      sent.push({ commitAt, entry });
      await sleep(300);
    }
    await sleep(1500);
    const per: Record<string, Record<number, number>> = {};
    nodes.forEach((n) => String(fs.readFileSync(n.logPath)).split("\n").forEach((l) => {
      const m = l.match(/\[PROF\] (\S+) proto\.commitBegin ([\d.]+)/);
      if (m && Number(m[2]) > marker) (per[m[1]] ||= {})[n.index] = Number(m[2]);
    }));
    const umids = Object.keys(per).filter((u) => Object.keys(per[u]).length === 4).sort((a, b) => Math.min(...Object.values(per[a])) - Math.min(...Object.values(per[b])));
    let failures = unanswered ? 1 : 0;
    console.log("transactions with a commit on all 4 nodes:", umids.length, "of", sent.length);
    if (umids.length < sent.length) { failures++; console.log("FAIL some transactions did not commit on every node"); }
    umids.slice(-sent.length).forEach((u, i) => {
      const order = Object.entries(per[u]).sort((a, b) => a[1] - b[1]).map(([n, t]) => `node${n}+${(t - Math.min(...Object.values(per[u]))).toFixed(1)}ms`);
      const first = Number(Object.entries(per[u]).sort((a, b) => a[1] - b[1])[0][0]);
      if (first !== sent[i].commitAt) { failures++; console.log(`FAIL tx ${i}: node ${first} wrote first, ${sent[i].commitAt} was named`); }
      console.log(`tx ${i}: named node ${sent[i].commitAt} (entry ${sent[i].entry}) -> commit order ${order.join(", ")}`);
    });
    console.log(failures ? `FAILED (${failures})` : "PASSED");
    if (failures) process.exitCode = 1;
  });
})().catch((e) => { console.error(e); process.exit(2); });
