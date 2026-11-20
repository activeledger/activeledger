import * as path from "path";
import { NetworkHarness } from "./harness";
import { requestJson, storageGet } from "./http";
import { onboard, registerNamespace, deployContract, runContract, Identity } from "./actions";

const ok = (m: string) => console.log("  ✔ " + m);
let failed = false;
const check = (cond: boolean, m: string) => {
  if (cond) ok(m);
  else {
    failed = true;
    console.log("  ✘ " + m);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const committed = (res: any) => !res?.$summary?.errors && res?.$summary?.commit >= 1;

/**
 * Catch-up on a quiet network: a node is away while transactions commit, comes
 * back, and NO further transaction touches the streams it missed. With
 * `catchUp` on it finds them itself.
 *
 * Run: npx tsx tests/network/catchup-live.ts
 */
(async () => {
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 8050, readyTimeoutMs: 60000, config: { catchUp: !process.env.NO_CATCHUP } } as any);
  try {
    const nodes: any[] = await harness.start();
    const away = nodes[3];
    const origin = nodes[0];
    const admin = await onboard(origin.baseUrl);
    await registerNamespace(origin.baseUrl, admin, "catchup");
    const contract = await deployContract(origin.baseUrl, admin, "catchup", "returner", path.join(__dirname, "contracts/returner-contract.ts"));
    await sleep(2000);
    const people: Identity[] = [];
    for (let i = 0; i < 12; i++) people.push(await onboard(origin.baseUrl));
    await sleep(3000);
    const run = (who: Identity, message: string) => runContract(origin.baseUrl, who, "catchup", contract, { message }).catch(() => undefined);

    const revisions = async (streamId: string) => {
      const revs: string[] = [];
      for (const node of (harness as any).nodes) {
        try {
          revs.push((await storageGet(node.storageUrl, streamId))?._rev || "missing");
        } catch {
          revs.push("unreadable");
        }
      }
      return revs;
    };
    const behind = async () => {
      let n = 0;
      for (const who of people) if (new Set(await revisions(who.streamId)).size !== 1) n++;
      return n;
    };

    console.log("== A node that was away catches up on a quiet network ==");
    await Promise.all(people.map((who, i) => run(who, `before-${i}`)));
    await harness.killNode(3);
    const during = (await Promise.all(people.map((who, i) => run(who, `while-away-${i}`)))).filter(committed);
    check(during.length === people.length, `${during.length} of ${people.length} streams moved on while node ${away.port} was away`);
    await harness.restartNode(3);
    check((await behind()) > 0, "the node is behind straight after it restarts (so there is something to catch up)");

    // No more transactions from here
    const deadline = Date.now() + 90000;
    let still = people.length;
    while (Date.now() < deadline) {
      still = await behind();
      if (still === 0) break;
      await sleep(3000);
    }
    check(still === 0, still ? `${still} of ${people.length} streams still behind after 90 s with no traffic` : "every stream is on one revision with no further transaction");

    console.log("== A node that crashes again while catching up still finishes ==");
    const second = [];
    for (let i = 0; i < 8; i++) second.push(await onboard(origin.baseUrl));
    await sleep(3000);
    await Promise.all(second.map((who, i) => run(who, `s-before-${i}`)));
    await harness.killNode(3);
    await Promise.all(second.map((who, i) => run(who, `s-away-${i}`)));
    await harness.restartNode(3);
    await sleep(9000); // it starts catching up
    await harness.crashNode(3);
    await harness.restartNode(3);
    const deadline2 = Date.now() + 90000;
    let left = second.length;
    const behindSecond = async () => {
      let n = 0;
      for (const who of second) if (new Set(await revisions(who.streamId)).size !== 1) n++;
      return n;
    };
    while (Date.now() < deadline2) {
      left = await behindSecond();
      if (left === 0) break;
      await sleep(3000);
    }
    check(left === 0, left ? `${left} of ${second.length} streams still behind after the second crash` : "every stream converged after a crash during catch-up");
  } finally {
    await harness.stop();
  }
  console.log(failed ? "FAILED" : "PASSED");
  process.exit(failed ? 1 : 0);
})();
