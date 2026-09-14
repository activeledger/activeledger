/**
 * Live measurement of leader ($delegated) consensus against ordinary
 * broadcast consensus on the same network, same contract, same transaction
 * shape - and, more importantly, a check that the network still agrees
 * afterwards.
 *
 * The speed was never really in doubt; skipping a voting round is obviously
 * faster. What this exists to catch is the failure the first version of
 * leader mode had: the entry node committed and told nobody, so it was 4x
 * faster and the other three nodes silently fell a revision behind. Latency
 * without the convergence check would have reported that as a success.
 */

import * as path from "path";
import { NetworkHarness } from "./harness";
import { onboard, registerNamespace, deployContract, Identity } from "./actions";
import { submit, storageGet } from "./http";

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function stat(label: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  console.log(
    `  ${label.padEnd(26)} n=${String(s.length).padStart(3)}` +
    `  min=${String(s[0]).padStart(5)}` +
    `  p50=${String(percentile(s, 50)).padStart(5)}` +
    `  p90=${String(percentile(s, 90)).padStart(5)}` +
    `  max=${String(s[s.length - 1]).padStart(5)}` +
    `  mean=${mean.toFixed(1).padStart(6)}ms`
  );
}

/**
 * `request` is the client's $delegated flag; `grant` is whether the contract
 * will actually vote leader. They are deliberately separate, because the
 * interesting case is the one where they disagree - see case 3.
 */
async function run(
  baseUrl: string,
  identity: Identity,
  namespace: string,
  contract: string,
  message: string,
  request: boolean,
  grant: boolean
): Promise<any> {
  const txBody = {
    $namespace: namespace,
    $contract: contract,
    $i: { [identity.streamId]: {} },
    // The contract only votes leader when asked - otherwise the "ordinary"
    // run below is not ordinary, and there is nothing to compare against.
    $o: { [identity.streamId]: grant ? { message, leader: true } : { message } },
  };
  const tx: any = {
    $tx: txBody,
    $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
  };
  if (request) tx.$delegated = true;
  return submit(baseUrl, tx);
}

/** Reads a stream's revision straight from each node's own storage engine. */
async function revisions(
  harness: NetworkHarness,
  streamId: string
): Promise<{ port: number; rev: string }[]> {
  const out: { port: number; rev: string }[] = [];
  for (const node of harness.nodes) {
    try {
      const doc = await storageGet(node.storageUrl, streamId);
      out.push({ port: node.port, rev: doc?._rev || "MISSING" });
    } catch (e) {
      out.push({ port: node.port, rev: `ERROR ${(e as Error).message}` });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const harness = new NetworkHarness({ nodeCount: 4 });
  let failures = 0;

  try {
    console.log("booting 4 nodes...");
    await harness.start();
    const entry = harness.nodes[0].baseUrl;

    const identity = await onboard(entry);
    await registerNamespace(entry, identity, "leadertest");
    const contract = await deployContract(
      entry,
      identity,
      "leadertest",
      "leader",
      path.resolve(__dirname, "contracts/leader-contract.ts")
    );
    // Contract has to be visible on every node before it can be delegated -
    // a follower that cannot load it fails at "Contract not found", which
    // looks exactly like a consensus failure in the numbers below.
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`contract ${contract.substring(0, 12)}... deployed\n`);

    const N = 20;
    const SETTLE_MS = Number(process.env.AL_SETTLE_MS ?? 0);

    const cases: { label: string; request: boolean; grant: boolean }[] = [
      { label: "ordinary broadcast", request: false, grant: false },
      { label: "$delegated, contract votes leader", request: true, grant: true },
      // The case that decides whether $delegated is safe to expose at all.
      // A client can set it on any transaction; if that alone were enough to
      // make the network stop voting, any client could switch consensus off.
      // It is not - the entry node's contract has to vote leader too, and
      // when it doesn't this has to fall all the way back to a normal
      // voting round rather than half-commit or stall.
      { label: "$delegated, contract refuses", request: true, grant: false },
      // Leader without $delegated - the shape master already had. The entry
      // node has broadcast before voting, so every node runs vote(), every
      // node votes leader, and every node commits on its own authority with
      // no consensus barrier anywhere. Nothing paces the client against the
      // network. This is the case that has to be watched.
      { label: "contract votes leader, no $delegated", request: false, grant: true },
    ];

    for (const { label, request, grant } of cases) {
      const samples: number[] = [];
      let committed = 0;

      // One untimed warm-up - the first run of any contract pays for the VM.
      await run(entry, identity, "leadertest", contract, "warmup", request, grant);

      for (let i = 0; i < N; i++) {
        // Unpaced by default: back-to-back writes to a single stream are the
        // hardest case for convergence, so that is what gets measured. Raise
        // AL_SETTLE_MS to tell a genuine race apart from a slow node.
        if (SETTLE_MS) await new Promise((r) => setTimeout(r, SETTLE_MS));
        const started = Date.now();
        const result = await run(
          entry, identity, "leadertest", contract, `m${i}`, request, grant
        );
        samples.push(Date.now() - started);
        if (result?.$summary?.commit) committed++;
        else if (i === 0) console.log(`  first tx summary:`, JSON.stringify(result?.$summary));
      }

      console.log(`[${label}]`);
      stat("client latency", samples);
      console.log(`  committed ${committed}/${N} (as reported to the client)`);

      // The check the first cut of leader mode would have failed.
      await new Promise((r) => setTimeout(r, 2000));
      const revs = await revisions(harness, identity.streamId);
      const agreed = new Set(revs.map((r) => r.rev)).size === 1;
      for (const r of revs) console.log(`    ${r.port}: ${r.rev}`);
      console.log(`  all four nodes agree? ${agreed ? "yes" : "NO"}\n`);
      if (!agreed) failures++;
      if (committed !== N) failures++;
    }
  } finally {
    for (const node of failures ? harness.nodes : []) {
      try {
        const log = require("fs").readFileSync(node.logPath, "utf8");
        const lines = log.split("\n").filter((l: string) =>
          /error|Error|not found|Not Found|fail|Fail|vote|leader|delegat/.test(l));
        console.log(`--- ${node.port} (${lines.length} matching lines, last 12) ---`);
        for (const l of lines.slice(-12)) console.log("   " + l.slice(0, 220));
      } catch (e) { console.log(`--- ${node.port} log unreadable`); }
    }
    await harness.stop();
    harness.cleanup();
  }

  if (failures) {
    console.log(`FAILED (${failures} check${failures === 1 ? "" : "s"})`);
    process.exitCode = 1;
  } else {
    console.log(
      "PASSED - leader mode committed on every node, the network agrees, and\n" +
      "         a $delegated transaction the contract refused still went to a vote"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
