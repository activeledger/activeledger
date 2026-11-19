/**
 * Does setVolatile() write a volatile document that is not there? Tried with
 * and without a getVolatile() first, on a stream whose volatile document has
 * been removed from every node's storage.
 */
import * as path from "path";
import { NetworkHarness } from "./harness";
import { requestJson, storageDelete } from "./http";
import { onboard, registerNamespace, deployContract, runContract } from "./actions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 5850, readyTimeoutMs: 60000, config: { build: 50600 } });
  try {
    const nodes = await harness.start();
    const entry = nodes[0];
    const owner = await onboard(entry.baseUrl);
    await registerNamespace(entry.baseUrl, owner, "ns");
    const contract = await deployContract(entry.baseUrl, owner, "ns", "modes", path.join(__dirname, "contracts/volatile-modes-contract.ts"));
    const id = owner.streamId + ":volatile";
    const read = async (n: number) => { try { return await requestJson(`${nodes[n].storageUrl}/activeledger/${encodeURIComponent(id)}`, "GET"); } catch { return null; } };
    const gone = async (n: number) => { const d: any = await read(n); return !d || d.notFound; };

    for (const mode of ["load", "plain", "plain-existing"]) {
      // Remove the volatile document from every node (not for the last: it keeps what is there)
      if (mode !== "plain-existing") for (let n = 0; n < 4; n++) { const d: any = await read(n); if (d && d._rev) await storageDelete(nodes[n].storageUrl, id).catch(() => undefined); }
      const missing = (await Promise.all([0, 1, 2, 3].map(gone))).every(Boolean);
      const r: any = await runContract(entry.baseUrl, owner, "ns", contract, { mode: mode === "load" ? "load" : "plain", value: "v-" + mode });
      await sleep(3000);
      const after = await Promise.all([0, 1, 2, 3].map(read));
      console.log(`mode ${mode}: volatile missing before=${missing}; reply=${JSON.stringify(r.$summary)}`);
      after.forEach((d: any, n) => console.log(`  node ${n + 1}: ${d && !d.notFound ? JSON.stringify({ written: d.written, now: d.now ? "kept" : "gone", _rev: d._rev }) : "no volatile document"}`));
    }
  } finally {
    await harness.stop();
    harness.cleanup();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
