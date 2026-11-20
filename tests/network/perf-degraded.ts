import * as path from "path";
import { NetworkHarness } from "./harness";
import { onboard, registerNamespace, deployContract, runContract } from "./actions";

/**
 * A simple throughput check for neighbour discovery traffic: four nodes, and
 * (in "degraded" mode) one of them never started, so the others keep looking
 * for it. A fixed number of concurrent writers drive the three nodes that are
 * up for a fixed time; prints one JSON line.
 *
 * Run: npx tsx tests/network/perf-degraded.ts <degraded|allup> [seconds=25] [workers=48] [label]
 * Run the same file from two builds, alternating, with nothing else on the machine.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mode = process.argv[2] === "allup" ? "allup" : "degraded";
  const seconds = Number(process.argv[3] || 25);
  const workers = Number(process.argv[4] || 48);
  const label = process.argv[5] || mode;
  const load0 = require("fs").readFileSync("/proc/loadavg", "utf8").split(" ")[0];
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 7900, readyTimeoutMs: 60000 } as any);
  try {
    await harness.start();
    const nodes = () => (harness as any).nodes as any[];
    let live = [0, 1, 2, 3];
    if (mode === "degraded") {
      await harness.killNode(3);
      // Restart the others so they start with it missing, as a node booting beside a dead one would
      for (const i of [0, 1, 2]) {
        await harness.killNode(i);
        await harness.restartNode(i);
      }
      live = [0, 1, 2];
    }
    await sleep(12000);

    const base = (k: number) => nodes()[live[k % live.length]].baseUrl;
    const owner = await onboard(base(0));
    await registerNamespace(base(0), owner, "perf");
    const contract = await deployContract(base(0), owner, "perf", "returner", path.join(__dirname, "contracts/returner-contract.ts"));
    const users = await Promise.all(Array.from({ length: workers }, (_, k) => onboard(base(k))));
    await sleep(3000);

    const refused = (r: any) => !(r?.$summary && !r.$summary.errors?.length && r.$summary.vote >= r.$summary.total);
    const latencies: number[] = [];
    let failures = 0;
    const stopAt = Date.now() + seconds * 1000;
    const started = Date.now();
    await Promise.all(
      users.map(async (user, k) => {
        let n = 0;
        while (Date.now() < stopAt) {
          const t0 = Date.now();
          try {
            const r = await runContract(base(k + n), user, "perf", contract, { message: `m${k}-${n++}` });
            if (refused(r)) failures++;
            else latencies.push(Date.now() - t0);
          } catch {
            failures++;
          }
        }
      })
    );
    const elapsed = (Date.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
    console.log(
      "RESULT " +
        JSON.stringify({
          label,
          mode,
          tps: Math.round((latencies.length / elapsed) * 10) / 10,
          ok: latencies.length,
          failures,
          p50: pct(0.5),
          p95: pct(0.95),
          loadAtStart: Number(load0),
          loadAtEnd: Number(require("fs").readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
        })
    );
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  process.exit(0);
})();
