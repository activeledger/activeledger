/**
 * Local, one-off proof for the streamUpdater.ts/stream.ts fix: does
 * meta.umid correctly track the latest transaction on repeated updates,
 * and does the meta doc stay a fixed size doing it (not the unbounded
 * meta.txs growth that was reverted previously)? Not wired into npm test
 * or test:network - a standalone script, run directly, kept only if it
 * proves useful as a permanent regression check.
 */
import * as path from "path";
import { NetworkHarness } from "./harness";
import { submit, storageGet } from "./http";
import { onboard, deployContract, runContract } from "./actions";

const NAMESPACE = "metagrowthtest";
const ROUNDS = 30;

async function main() {
  const harness = new NetworkHarness({ nodeCount: 4 });
  const nodes = await harness.start();
  const node = nodes[0];
  console.log(`node ready: ${node.baseUrl} (storage ${node.storageUrl})`);

  try {
    const identity = await onboard(node.baseUrl);
    console.log("onboarded:", identity.streamId);

    const nsTxBody = { $namespace: "default", $contract: "namespace", $i: { [identity.streamId]: { namespace: NAMESPACE } } };
    const nsResult = await submit(node.baseUrl, {
      $tx: nsTxBody,
      $sigs: { [identity.streamId]: identity.keyPair.sign(nsTxBody) },
    });
    if (nsResult.$summary?.errors) throw new Error(`namespace failed: ${JSON.stringify(nsResult)}`);
    console.log("namespace registered");

    const contractStreamId = await deployContract(
      node.baseUrl,
      identity,
      NAMESPACE,
      "returner",
      path.join(__dirname, "contracts/returner-contract.ts")
    );
    console.log("contract deployed:", contractStreamId);

    const sizes: { round: number; umid: string; rev: string; bytes: number; matchesLatest: boolean }[] = [];

    for (let i = 1; i <= ROUNDS; i++) {
      const result = await runContract(node.baseUrl, identity, NAMESPACE, contractStreamId, { message: `round-${i}` });
      if (result.$summary?.errors) {
        console.error(`round ${i} FAILED:`, JSON.stringify(result));
        continue;
      }
      const umid = result.$umid;

      const metaDoc = await storageGet(node.storageUrl, `${identity.streamId}:stream`);
      const bytes = Buffer.byteLength(JSON.stringify(metaDoc), "utf8");
      const matchesLatest = metaDoc.umid === umid;

      sizes.push({ round: i, umid, rev: metaDoc._rev, bytes, matchesLatest });
      if (i === 1 || i % 5 === 0 || i === ROUNDS || !matchesLatest) {
        console.log(
          `round ${i}: umid ${matchesLatest ? "MATCHES" : "MISMATCH"} latest tx, meta._rev=${metaDoc._rev}, meta doc size=${bytes} bytes`
        );
      }
    }

    console.log("\n=== summary ===");
    const allMatch = sizes.every((s) => s.matchesLatest);
    console.log("every round's meta.umid matched that round's own transaction:", allMatch);
    const byteValues = sizes.map((s) => s.bytes);
    console.log("meta doc size across all rounds - min:", Math.min(...byteValues), "max:", Math.max(...byteValues), "(should be equal - fixed size)");
    console.log("final meta doc:", JSON.stringify(await storageGet(node.storageUrl, `${identity.streamId}:stream`), null, 2));

    process.exitCode = allMatch && Math.min(...byteValues) === Math.max(...byteValues) ? 0 : 1;
  } finally {
    await harness.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
