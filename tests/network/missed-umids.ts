/**
 * What a node that was away holds when it comes back, and what the network
 * does when nodes are lost part way through work.
 *
 * 1. A node misses transactions, returns, and is repaired. Every umid it
 *    adopted must also be in its umid index (`/activeledgerevents/umids`),
 *    stamped with the time it was written here - without the row, a client
 *    catching up from a time never sees the transaction.
 * 2. A node is killed while transactions are in flight. The network still
 *    has its majority, so it carries on; the node returns and every stream
 *    ends on one revision, with no committed umid missing its index row.
 * 3. Two of four nodes are lost, which is below consensus. Nothing commits,
 *    nothing is half written, and the network works again once they return.
 *
 * Run via `npm run test:network:missed-umids`.
 */

import * as path from "path";
import { NetworkHarness, NetworkNode } from "./harness";
import { requestJson, storageGet } from "./http";
import { Report } from "./report";
import { onboard, registerNamespace, deployContract, runContract, Identity } from "./actions";

const NAMESPACE = "missedumids";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const committed = (res: any) => !res?.$summary?.errors && res?.$summary?.commit >= 1;

/** The umid index rows a node serves, by umid. */
async function indexRows(node: NetworkNode): Promise<Map<string, number>> {
  const got = await requestJson(`${node.storageUrl}/activeledgerevents/umids?from=0&limit=100000`, "GET");
  return new Map((got?.rows || []).map((r: any) => [r.umid as string, Number(r.timestamp)]));
}

/** Whether a node holds the umid document. */
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
  const harness = new NetworkHarness({ nodeCount: 4 });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = ok && passed;
  };

  report.phase("Booting 4-node network");
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready`);

  try {
    const [origin, , , away] = nodes;
    const admin = await onboard(origin.baseUrl);
    await registerNamespace(origin.baseUrl, admin, NAMESPACE);
    const contract = await deployContract(
      origin.baseUrl,
      admin,
      NAMESPACE,
      "returner",
      path.join(__dirname, "contracts/returner-contract.ts")
    );
    await sleep(2000);
    const run = (node: NetworkNode, who: Identity, message: string) =>
      runContract(node.baseUrl, who, NAMESPACE, contract, { message });

    // ---------------------------------------------------------------- 1
    report.phase(`A node misses transactions: does it index the umids it adopts?`);
    {
      const subject = await onboard(origin.baseUrl);
      check(await converged(nodes, subject.streamId, 10000), "the stream starts on one revision everywhere");

      await harness.killNode(away.index);
      const missed: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await run(origin, subject, `missed-${i}`).catch(() => undefined);
        if (res?.$umid && committed(res)) missed.push(res.$umid);
      }
      check(missed.length === 3, `three transactions committed while node ${away.port} was away`);

      const returned = Date.now();
      await harness.restartNode(away.index);
      await sleep(4000);
      const trigger = await run(origin, subject, "after-return").catch(() => undefined);
      check(committed(trigger), "a transaction after its return committed");
      check(await converged(nodes, subject.streamId, 30000), "the node caught up to the network's revision");
      await sleep(4000);

      const all = [...missed, trigger?.$umid].filter(Boolean) as string[];
      const rows = await indexRows(away);
      const held: string[] = [];
      for (const umid of all) if (await holds(away, umid)) held.push(umid);
      report.info(`node ${away.port} holds ${held.length} of ${all.length} umids and ${rows.size} index rows`);

      check(held.length >= 1, "it adopted at least one umid it was away for");
      const unindexed = held.filter((u) => !rows.has(u));
      check(unindexed.length === 0, unindexed.length ? `held but not indexed: ${unindexed.join(", ")}` : "every umid it holds is also in its umid index");

      // An adopted umid is stamped when this node wrote it, which was after it came back
      const early = held.filter((u) => rows.has(u) && rows.get(u)! < returned && !(u === trigger?.$umid));
      check(early.length === 0, early.length ? `${early.length} adopted rows are stamped before the node returned` : "adopted rows are stamped with their write time here");

      // The row must be readable from a time before it, the way a catching-up client asks
      const from = await requestJson(`${away.storageUrl}/activeledgerevents/umids?from=${returned - 60000}`, "GET");
      const listed = new Set((from?.rows || []).map((r: any) => r.umid));
      const absent = held.filter((u) => !listed.has(u));
      check(absent.length === 0, "a client asking from a minute before the return is told about each of them");

      // The nodes that stayed up still agree with what the network committed
      const originRows = await indexRows(origin);
      check(missed.every((u) => originRows.has(u)), "the node that took the transactions indexed all of them");
    }

    // ---------------------------------------------------------------- 2
    report.phase(`A node is killed while transactions are in flight`);
    {
      const people: Identity[] = [];
      for (let i = 0; i < 30; i++) people.push(await onboard(origin.baseUrl));
      await sleep(3000);

      // Kill the node as soon as the first answer arrives, so the rest are still being worked on
      const results: any[] = new Array(people.length);
      let killed: Promise<void> | undefined;
      let finishedAfterKill = 0;
      const inFlight = Promise.all(
        people.map(async (who, i) => {
          results[i] = await run(origin, who, `flight-${i}`).catch((e) => ({ error: String(e) }));
          if (killed) finishedAfterKill++;
          else killed = harness.killNode(away.index);
        })
      );
      await inFlight;
      await killed;
      report.info(`${finishedAfterKill} transactions finished after the node was killed`);
      check(finishedAfterKill > 0, "the node was lost while transactions were still in flight");

      const done = results.filter(committed);
      report.info(`${done.length} of ${people.length} committed with node ${away.port} lost part way`);
      check(done.length > 0, "the network kept committing with its majority");

      const survivors = nodes.filter((n) => n.index !== away.index);
      const missingOnSurvivors: string[] = [];
      for (const res of done) {
        for (const node of survivors) if (!(await holds(node, res.$umid))) missingOnSurvivors.push(`${res.$umid}@${node.port}`);
      }
      check(missingOnSurvivors.length === 0, missingOnSurvivors.length ? `committed but missing on a surviving node: ${missingOnSurvivors.slice(0, 3).join(", ")}` : "every committed transaction is on every surviving node");

      await harness.restartNode(away.index);
      await sleep(4000);
      // One more transaction per stream gives the returned node something to notice and repair on
      await Promise.all(people.map((who, i) => run(origin, who, `after-${i}`).catch(() => undefined)));
      let behind = 0;
      for (const who of people) if (!(await converged(nodes, who.streamId, 30000))) behind++;
      check(behind === 0, behind ? `${behind} of ${people.length} streams did not converge` : `all ${people.length} streams are on one revision on every node`);

      await sleep(4000);
      const gaps: string[] = [];
      for (const node of nodes) {
        const rows = await indexRows(node);
        for (const res of done) if ((await holds(node, res.$umid)) && !rows.has(res.$umid)) gaps.push(`${res.$umid}@${node.port}`);
      }
      check(gaps.length === 0, gaps.length ? `held but not indexed: ${gaps.slice(0, 3).join(", ")}` : "no node holds a committed umid without its index row");
    }

    // ---------------------------------------------------------------- 3
    report.phase(`Two of four nodes are lost, below consensus`);
    {
      const who = await onboard(origin.baseUrl);
      await sleep(2000);
      check(committed(await run(origin, who, "before-loss").catch(() => undefined)), "it commits with all four nodes");
      const before = await revisions(nodes, who.streamId);

      await harness.killNode(2);
      await harness.killNode(3);
      const lost = await run(origin, who, "during-loss").catch((e) => ({ error: String(e) }));
      check(!committed(lost), "a transaction does not commit with half the network gone");
      const during = (await revisions([nodes[0], nodes[1]], who.streamId))[0];
      check(during === before[0], "the stream on the surviving nodes was left as it was");

      await harness.restartNode(2);
      await harness.restartNode(3);
      await sleep(5000);
      let again: any;
      for (let i = 0; i < 5 && !committed(again); i++) {
        again = await run(origin, who, `after-loss-${i}`).catch(() => undefined);
        if (!committed(again)) await sleep(3000);
      }
      check(committed(again), "it commits again once they are back");
      check(await converged(nodes, who.streamId, 30000), "every node ends on one revision");
    }
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nMISSED UMIDS CHECK PASSED\n" : "\nMISSED UMIDS CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
