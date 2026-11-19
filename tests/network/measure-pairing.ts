import * as http from "http";
import { NetworkHarness } from "./harness";

/**
 * Status knocks per node over a window, read from each node's /a/status
 * (neighbourhood.knocks), for: all nodes up, and one node never started.
 * Run: npx tsx tests/network/measure-pairing.ts
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = (url: string) =>
  new Promise<any>((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
const counts = async (n: any) => (await get(`${n.baseUrl}/a/status`)).neighbourhood.knocks;

(async () => {
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 7900, readyTimeoutMs: 60000 } as any);
  try {
    await harness.start();
    const nodes = () => (harness as any).nodes as any[];
    await sleep(15000);

    const window = async (label: string, which: number[]) => {
      const a = await Promise.all(which.map((i) => counts(nodes()[i])));
      await sleep(60000);
      const b = await Promise.all(which.map((i) => counts(nodes()[i])));
      const recv = b.map((x, i) => x.received - a[i].received);
      const sent = b.map((x, i) => x.sent - a[i].sent);
      console.log(`${label}, 60 s: knocks received per node = ${recv.join(", ")} (total ${recv.reduce((x, y) => x + y, 0)}); sent per node = ${sent.join(", ")} (total ${sent.reduce((x, y) => x + y, 0)})`);
    };

    await window("ALL UP", [0, 1, 2, 3]);

    await harness.killNode(3);
    for (const i of [0, 1, 2]) {
      await harness.killNode(i);
      const t0 = Date.now();
      await harness.restartNode(i);
      console.log(`node ${i + 1} ready (status 4) after ${Date.now() - t0} ms`);
    }
    await sleep(5000);
    await window("ONE NEVER STARTED", [0, 1, 2]);
    const st = await get(`${nodes()[0].baseUrl}/a/status`);
    console.log("node 1 sees:", JSON.stringify(Object.values(st.neighbourhood.neighbours).map((n: any) => `${n.state}${n.reason ? " (" + n.reason + ")" : ""}`)));
  } finally {
    await harness.stop();
  }
  process.exit(0);
})();
