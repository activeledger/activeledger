/**
 * Faults a clean stop does not cover, against a live 4-node network.
 *
 * 1. A node freezes (it holds its port but answers nothing) while work goes
 *    on. The other three carry on; when it thaws every stream converges and
 *    no node holds a committed umid without its index row.
 * 2. A node is crashed (SIGKILL, no clean shutdown) mid-flight, restarted,
 *    and repaired.
 * 3. A node is crashed again while it is being repaired - twice in a row -
 *    and still ends on the network's revision.
 *
 * A hard crash can lose the umid index rows for the last few transactions the
 * node committed (they are written just after the answer is sent). That is
 * accepted and documented in docs/guide/operate/troubleshooting.md, so the
 * crash scenarios report the count as a warning; the streams and umid
 * documents themselves are still asserted. The frozen-node scenario keeps the
 * hard assertion, since a freeze loses nothing.
 *
 * A true network partition needs root (netns/iptables) and is not covered;
 * a frozen node is the closest thing that runs unprivileged.
 *
 * Run via `npm run test:network:faults`.
 */

import * as fs from "fs";
import * as path from "path";
import { NetworkHarness, NetworkNode } from "./harness";
import { requestJson, storageGet } from "./http";
import { Report } from "./report";
import { onboard, registerNamespace, deployContract, runContract, Identity } from "./actions";

const NAMESPACE = "faults";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const committed = (res: any) => !res?.$summary?.errors && res?.$summary?.commit >= 1;

async function indexRows(node: NetworkNode): Promise<Set<string>> {
  const got = await requestJson(`${node.storageUrl}/activeledgerevents/umids?from=0&limit=100000`, "GET");
  return new Set((got?.rows || []).map((r: any) => r.umid as string));
}

async function holds(node: NetworkNode, umid: string): Promise<boolean> {
  try {
    return !!(await storageGet(node.storageUrl, `${umid}:umid`))?._id;
  } catch {
    return false;
  }
}

async function revisions(nodes: NetworkNode[], streamId: string): Promise<string[]> {
  const revs: string[] = [];
  for (const node of nodes) {
    try {
      revs.push((await storageGet(node.storageUrl, streamId))?._rev || "missing");
    } catch {
      revs.push("unreadable");
    }
  }
  return revs;
}

async function converged(nodes: NetworkNode[], streamId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const revs = await revisions(nodes, streamId);
    if (new Set(revs).size === 1 && revs[0] !== "missing" && revs[0] !== "unreadable") return true;
    if (Date.now() > deadline) return false;
    await sleep(1000);
  }
}

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 4, config: { ...(process.env.FAULT_DEBUG ? { debug: true } : {}), ...(process.env.FAULT_NO_CATCHUP ? { catchUp: false } : {}) } } as any);
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = ok && passed;
  };

  report.phase("Booting 4-node network");
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready`);

  let frozen: number | undefined;
  try {
    const [origin, , , away] = nodes;
    const admin = await onboard(origin.baseUrl);
    await registerNamespace(origin.baseUrl, admin, NAMESPACE);
    const contract = await deployContract(origin.baseUrl, admin, NAMESPACE, "returner", path.join(__dirname, "contracts/returner-contract.ts"));
    await sleep(2000);
    const run = (who: Identity, message: string) => runContract(origin.baseUrl, who, NAMESPACE, contract, { message });

    const people = async (n: number) => {
      const list: Identity[] = [];
      for (let i = 0; i < n; i++) list.push(await onboard(origin.baseUrl));
      await sleep(3000);
      return list;
    };
    const allConverge = async (list: Identity[]) => {
      let behind = 0;
      for (const who of list) {
        if (await converged(nodes, who.streamId, 40000)) continue;
        behind++;
        // Which node is on a different revision, for working out why
        const revs = await revisions(nodes, who.streamId);
        report.info(`not converged ${who.streamId.slice(0, 8)}: ${revs.map((r, i) => `n${i}=${r.slice(0, 12)}`).join(" ")}`);
      }
      if (behind && process.env.FAULT_LOGS) {
        fs.mkdirSync(process.env.FAULT_LOGS, { recursive: true });
        nodes.forEach((n, i) => fs.copyFileSync(path.join(n.dataDir, "node.log"), path.join(process.env.FAULT_LOGS!, `node${i}-${Date.now()}.log`)));
      }
      return behind;
    };
    const unindexed = async (done: any[]) => {
      const gaps: string[] = [];
      for (const node of nodes) {
        const rows = await indexRows(node);
        for (const res of done) if ((await holds(node, res.$umid)) && !rows.has(res.$umid)) gaps.push(`${res.$umid}@${node.port}`);
      }
      return gaps;
    };

    // ---------------------------------------------------------------- 1
    report.phase("A node freezes while work goes on");
    {
      const list = await people(12);
      const first = await Promise.all(list.map((who, i) => run(who, `before-freeze-${i}`).catch(() => undefined)));
      check(first.filter(committed).length === list.length, "everything commits while all four nodes are up");

      harness.freezeNode(away.index);
      frozen = away.index;
      const during = await Promise.all(list.map((who, i) => run(who, `while-frozen-${i}`).catch(() => undefined)));
      const done = during.filter(committed);
      report.info(`${done.length} of ${list.length} committed with node ${away.port} frozen`);
      check(done.length > 0, "the other three nodes keep committing");

      harness.thawNode(away.index);
      frozen = undefined;
      await sleep(4000);
      await Promise.all(list.map((who, i) => run(who, `after-thaw-${i}`).catch(() => undefined)));
      const behind = await allConverge(list);
      check(behind === 0, behind ? `${behind} of ${list.length} streams did not converge after the thaw` : `all ${list.length} streams are on one revision after the thaw`);
      await sleep(4000);
      const gaps = await unindexed([...first, ...done]);
      check(gaps.length === 0, gaps.length ? `${gaps.length} held but not indexed: ${gaps.slice(0, 3).join(", ")}` : "no node holds a committed umid without its index row");
    }

    // ---------------------------------------------------------------- 2
    report.phase("A node is crashed mid-flight");
    {
      const list = await people(24);
      let crashed: Promise<void> | undefined;
      let after = 0;
      const results: any[] = new Array(list.length);
      await Promise.all(
        list.map(async (who, i) => {
          results[i] = await run(who, `crash-${i}`).catch(() => undefined);
          if (crashed) after++;
          else crashed = harness.crashNode(away.index);
        })
      );
      await crashed;
      check(after > 0, "the node was crashed while transactions were still in flight");
      const done = results.filter(committed);
      check(done.length > 0, `the network kept committing (${done.length} of ${list.length})`);

      await harness.restartNode(away.index);
      await sleep(4000);
      await Promise.all(list.map((who, i) => run(who, `after-crash-${i}`).catch(() => undefined)));
      const behind = await allConverge(list);
      check(behind === 0, behind ? `${behind} of ${list.length} streams did not converge after the crash` : `all ${list.length} streams are on one revision after the crash`);
      await sleep(4000);
      const gaps = await unindexed(done);
      gaps.length ? report.warn(`${gaps.length} umids are held without an index row after the hard crash (accepted, see the header)`) : report.info("no node holds a committed umid without its index row");
    }

    // ---------------------------------------------------------------- 3
    report.phase("A node is crashed while it is being repaired, twice");
    {
      const list = await people(12);
      await harness.killNode(away.index);
      const missed = (await Promise.all(list.map((who, i) => run(who, `missed-${i}`).catch(() => undefined)))).filter(committed);
      check(missed.length > 0, `${missed.length} transactions committed while node ${away.port} was away`);

      for (let round = 1; round <= 2; round++) {
        await harness.restartNode(away.index);
        // One more transaction per stream makes the node notice it is behind and start repairing
        void Promise.all(list.map((who, i) => run(who, `repair-${round}-${i}`).catch(() => undefined)));
        await sleep(1500);
        await harness.crashNode(away.index);
        report.info(`crashed node ${away.port} again, ${round} of 2, shortly after it began repairing`);
      }

      await harness.restartNode(away.index);
      await sleep(4000);
      await Promise.all(list.map((who, i) => run(who, `final-${i}`).catch(() => undefined)));
      const behind = await allConverge(list);
      check(behind === 0, behind ? `${behind} of ${list.length} streams did not converge` : `all ${list.length} streams are on one revision after two interrupted repairs`);
      await sleep(4000);
      const gaps = await unindexed(missed);
      gaps.length ? report.warn(`${gaps.length} umids are held without an index row after the hard crashes (accepted, see the header)`) : report.info("no node holds a committed umid without its index row");
    }
  } finally {
    if (frozen !== undefined) harness.thawNode(frozen);
    // KEEP_NODE_LOGS=<dir> keeps each node's log, to see what a failing run did
    if (process.env.KEEP_NODE_LOGS) {
      for (const node of nodes) {
        try {
          fs.copyFileSync(node.logPath, path.join(process.env.KEEP_NODE_LOGS, `node-${node.port}.log`));
        } catch {
          // no log to keep
        }
      }
    }
    await harness.stop();
    harness.cleanup();
  }
  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nFAULTS CHECK PASSED\n" : "\nFAULTS CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
