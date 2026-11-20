import * as fs from "fs";
import * as path from "path";
import { NetworkHarness } from "./harness";
import { requestJson } from "./http";
import { onboard } from "./actions";

/**
 * Staggered cold start, repeated: four nodes from empty data directories,
 * started a random few seconds apart, the first transaction sent at once to a
 * random node (not waiting for discovery), then how long each node takes to
 * hold the stream it created.
 *
 * Counts the two cold-start faults the 2026-11 soak found: the first
 * transaction getting no reply, and a node that never gets the stream.
 *
 * Run: npx tsx tests/network/soak-staggered.ts [runs=40] [maxOffsetMs=3000]
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const runs = Number(process.argv[2] || 40);
  const maxOffset = Number(process.argv[3] || 3000);
  let firstTxFailed = 0;
  let nodeLag = 0;
  let slow = 0;
  let aborted = 0;
  const worsts: number[] = [];
  const firstTx: number[] = [];

  for (let run = 1; run <= runs; run++) {
    const offsets = [0, 1, 2, 3].map((i) => (i === 0 ? 0 : Math.floor(Math.random() * maxOffset)));
    const harness = new NetworkHarness({
      nodeCount: 4,
      basePort: 7900,
      readyTimeoutMs: 60000,
      discoveryTimeoutMs: 0,
      startOffsetsMs: offsets,
      ...(process.env.SOAK_CATCHUP ? { config: { catchUp: true } } : {}),
    } as any);
    try {
      const nodes = await harness.start();
      const entry = nodes[Math.floor(Math.random() * 4)];
      const started = Date.now();
      let owner: any;
      try {
        owner = await onboard(entry.baseUrl);
      } catch (e) {
        firstTxFailed++;
        console.log(`run ${run} offsets=${offsets.join(",")}: FIRST TX FAILED: ${(e as Error).message}`);
        continue;
      }
      firstTx.push(Date.now() - started);
      const heldAt: number[] = [];
      for (let n = 0; n < 4; n++) {
        let at = -1;
        while (Date.now() - started < 15000) {
          try {
            const doc = await requestJson(`${nodes[n].storageUrl}/activeledger/${encodeURIComponent(owner.streamId)}`, "GET");
            if (doc && doc._id) {
              at = Date.now() - started;
              break;
            }
          } catch {
            /* not there yet */
          }
          await sleep(50);
        }
        heldAt.push(at);
      }
      const worst = heldAt.includes(-1) ? -1 : Math.max(...heldAt);
      if (worst === -1) {
        nodeLag++;
        // Keep the node logs of a failing run (SOAK_LOGS=<dir>) to see why
        if (process.env.SOAK_LOGS) {
          const dir = path.join(process.env.SOAK_LOGS, `run-${run}`);
          fs.mkdirSync(dir, { recursive: true });
          (harness as any).nodes.forEach((n: any, i: number) => fs.copyFileSync(n.logPath, path.join(dir, `node${i}.log`)));
          fs.writeFileSync(path.join(dir, "info.txt"), `offsets=${offsets.join(",")} entry=${entry.index} held=${heldAt.join(",")}\n`);
        }
      } else {
        worsts.push(worst);
        if (worst > 2000) slow++;
      }
      console.log(`run ${run} offsets=${offsets.join(",")}: first tx ${firstTx[firstTx.length - 1]}ms, held by all after ${heldAt.join(", ")}${worst === -1 ? "  <- NODE LAG" : ""}`);
    } catch (e) {
      aborted++;
      console.log(`run ${run}: aborted: ${(e as Error).message}`);
    } finally {
      await harness.stop();
      harness.cleanup();
    }
  }
  const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : NaN);
  console.log(
    `\n${runs} runs: first tx failed ${firstTxFailed}, a node never got the stream ${nodeLag}, slow (over 2 s) ${slow}, aborted ${aborted}`
  );
  console.log(`first tx ms p50=${pct(firstTx, 50)} p95=${pct(firstTx, 95)} max=${pct(firstTx, 100)}; all-held ms p50=${pct(worsts, 50)} p95=${pct(worsts, 95)} max=${pct(worsts, 100)}`);
  process.exit(0);
})();
