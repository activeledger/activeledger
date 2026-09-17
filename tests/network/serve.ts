/**
 * Boots the 4-node test network, prints the node URLs as JSON, and holds
 * until interrupted.
 *
 * Exists so an SDK in a language other than JavaScript can run its
 * integration suite against real nodes. Before this, the only way to check
 * that an SDK's signatures were acceptable was to read the ledger's source
 * and reason about it - so every "done" for a port was an assertion. With
 * this, it is an observation, for every port, in every language, forever.
 *
 * Run via `npm run test:network:serve`.
 *
 *   $ npm run test:network:serve
 *   {"nodes":[{"port":5510,"baseUrl":"http://localhost:5510","storageUrl":"..."},...]}
 *
 * stdout carries exactly one line - the JSON - so a consuming test runner
 * can parse it without filtering. Everything else goes to stderr.
 */

import { NetworkHarness } from "./harness";

async function main(): Promise<void> {
  // 40100 by default, because both 4.8.0 protocol features (authority key
  // expiry, contract source references) are gated behind it. An SDK testing
  // against a network below the threshold would be testing 4.7.1 behaviour
  // while believing it was testing current behaviour.
  const build = Number(process.env.AL_BUILD || 40100);
  const nodeCount = Number(process.env.AL_NODES_COUNT || 4);

  console.error(`Booting ${nodeCount} nodes at build ${build}...`);
  const harness = new NetworkHarness({ nodeCount, config: { build } });
  const nodes = await harness.start();

  console.log(
    JSON.stringify({
      build,
      nodes: nodes.map((n) => ({
        port: n.port,
        baseUrl: n.baseUrl,
        storageUrl: n.storageUrl,
      })),
    })
  );

  console.error(`Ready. ${nodes.length} nodes: ${nodes.map((n) => n.port).join(", ")}`);
  console.error("Press Ctrl-C to stop and clean up.");

  let stopping = false;
  const shutdown = async () => {
    // Guarded: SIGINT from a terminal reaches the whole process group, and a
    // second one arriving mid-teardown would race the first and leave data
    // directories behind.
    if (stopping) return;
    stopping = true;
    console.error("\nStopping...");
    try {
      await harness.stop();
      harness.cleanup();
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Hold until signalled.
  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
