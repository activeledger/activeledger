import { NetworkHarness } from "./harness";
import { requestJson } from "./http";
import { onboard } from "./actions";

/**
 * The start-up gap: a node reports Stable before it has found every
 * neighbour, and a broadcast only goes to neighbours already counted as home,
 * so a transaction sent in that gap used to miss a node. Boots four nodes
 * WITHOUT waiting for discovery, sends the first transaction at once, then
 * times how long each node takes to hold the stream it created.
 *
 * Run: npx tsx tests/network/replay-live.ts [runs=10]
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const runs = Number(process.argv[2] || 10);
  let slowRuns = 0;
  const all: number[] = [];
  for (let run = 1; run <= runs; run++) {
    const harness = new NetworkHarness({ nodeCount: 4, basePort: 7900, readyTimeoutMs: 60000, discoveryTimeoutMs: 0 } as any);
    try {
      const nodes = await harness.start();
      const started = Date.now();
      const owner = await onboard(nodes[0].baseUrl);
      const heldAt: number[] = [];
      for (let n = 0; n < 4; n++) {
        let at = -1;
        while (Date.now() - started < 15000) {
          try {
            const doc = await requestJson(`${nodes[n].storageUrl}/activeledger/${encodeURIComponent(owner.streamId)}`, "GET");
            if (doc && doc._id) { at = Date.now() - started; break; }
          } catch { /* not there yet */ }
          await sleep(100);
        }
        heldAt.push(at);
      }
      const worst = heldAt.includes(-1) ? -1 : Math.max(...heldAt);
      all.push(worst);
      if (worst === -1 || worst > 2000) slowRuns++;
      console.log(`run ${run}: stream held after (ms) per node = ${heldAt.join(", ")}${worst === -1 ? "  <- a node never got it in 15 s" : ""}`);
    } catch (e) {
      console.log(`run ${run}: aborted: ${(e as Error).message}`);
      slowRuns++;
    } finally {
      await harness.stop();
      harness.cleanup();
    }
  }
  const missed = all.filter((t) => t === -1).length;
  console.log(`\n${runs} runs: ${missed} with a node that never got it in 15 s, ${slowRuns} slow (over 2 s) or failed`);
  process.exit(0);
})();
