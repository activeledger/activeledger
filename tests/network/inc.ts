/**
 * Inter node comms on a live 4-node network. Every transaction's contract
 * sets data on each node in vote() and reads the other nodes' data in
 * commit(); the check is that every node saw all three others', for every
 * transaction. Run with and without the p2p reply switches:
 *
 *   npx tsx tests/network/inc.ts
 *   npx tsx tests/network/inc.ts --quiet     (p2pSlimReplies + p2pQuietReplies)
 *   npx tsx tests/network/inc.ts --quiet --drop 0.05   (5% of p2p frames lost on receipt; needs the preload in AL_PRELOAD)
 */
import * as path from "path";
import { NetworkHarness } from "./harness";
import { Report } from "./report";
import { onboard, registerNamespace, deployContract, runContract } from "./actions";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSACTIONS = 60;

async function main(): Promise<boolean> {
  const quiet = process.argv.includes("--quiet");
  const report = new Report();
  const harness = new NetworkHarness({
    nodeCount: 4,
    basePort: 5780,
    config: quiet ? { p2pSlimReplies: true, p2pQuietReplies: true } : {},
    readyTimeoutMs: 40000,
  });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };
  try {
    report.phase(`Booting 4 nodes (${quiet ? "slim and quiet replies on" : "defaults"})`);
    const nodes = await harness.start();
    const identity = await onboard(nodes[1].baseUrl);
    // One stream per origin node, so transactions sent together do not collide
    const identities = await Promise.all(nodes.map((n) => onboard(n.baseUrl)));
    const ns = `inc${Date.now().toString(36)}`;
    check(!(await registerNamespace(nodes[1].baseUrl, identity, ns)).$summary?.errors, "namespace registered");
    const contractId = await deployContract(nodes[1].baseUrl, identity, ns, "inc", path.resolve(__dirname, "contracts/inc-contract.ts"));
    await sleep(3000);

    report.phase(`${TRANSACTIONS} transactions, spread over every node as origin, 4 at a time`);
    const results: any[] = [];
    for (let i = 0; i < TRANSACTIONS; i += 4) {
      const batch = await Promise.all(
        [0, 1, 2, 3].map((n) => runContract(nodes[n].baseUrl, identities[n], ns, contractId, { message: `inc-${i + n}` }).catch((e: any) => ({ error: String(e) })))
      );
      results.push(...batch);
    }
    const committed = results.filter((r) => !r.$summary?.errors && r.$summary?.commit >= 1).length;
    check(committed === TRANSACTIONS, `${committed} of ${TRANSACTIONS} committed`);

    // Each node returns how many others' comms it saw at commit
    let full = 0, short = 0, none = 0;
    for (const r of results) {
      const responses = (r.$responses || []) as any[];
      if (!responses.length) continue;
      for (const response of responses) {
        if (response?.via !== "inc-contract") continue;
        response.withToken === 3 ? full++ : response.withToken > 0 ? short++ : none++;
      }
    }
    check(full > 0 && short === 0 && none === 0, `every response saw all 3 other nodes' data (${full} did, ${short} saw some, ${none} saw none)`);
  } catch (error) {
    check(false, `scenario failed: ${(error as Error).message}`);
  } finally {
    await harness.stop().catch(() => undefined);
  }
  report.record("inter node comms" + (quiet ? " (quiet replies)" : ""), passed, 0);
  report.summary();
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
