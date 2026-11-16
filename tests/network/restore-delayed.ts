/**
 * Live test of the restore agent when the umid it was asked to fetch cannot be
 * supplied yet (5.3.0: it keeps the 950 record and tries again with back-off,
 * archiving it as failed only after ten tries).
 *
 *  1. A node is down while a transaction commits, and returns without it.
 *  2. The other three go down, so nobody can supply it. A 950 record asking for
 *     the umid is left in the returned node's error database, as SPI leaves one.
 *  3. The node's restore agent finds the record, cannot get the umid, and does
 *     NOT delete the record: it counts the attempt and sets when to try next.
 *  4. The others come back. On a later attempt the agent fetches the umid, the
 *     node holds the umid document and its index row, and the record is done.
 *
 * Run via `npm run test:network:restore-delayed`.
 */

import { NetworkHarness, NetworkNode } from "./harness";
import { requestJson, storageGet, storagePut } from "./http";
import { Report } from "./report";
import { onboard } from "./actions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms: number, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

const indexRows = async (node: NetworkNode): Promise<Map<string, number>> => {
  const got = await requestJson(`${node.storageUrl}/activeledgerevents/umids?from=0&limit=100000`, "GET");
  return new Map((got?.rows || []).map((r: any) => [r.umid as string, Number(r.timestamp)]));
};

const holds = async (node: NetworkNode, umid: string): Promise<boolean> => {
  try {
    return !!(await storageGet(node.storageUrl, `${umid}:umid`))?._id;
  } catch {
    return false;
  }
};

const ready = (node: NetworkNode) => requestJson(`${node.baseUrl}/a/status`, "GET").then((s) => s?.status === 4).catch(() => false);

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 5810, readyTimeoutMs: 40000 });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };

  try {
    report.phase("Booting 4 nodes");
    const nodes = await harness.start();
    const behind = nodes[3];

    report.phase("A node misses a transaction");
    const before = new Set((await indexRows(nodes[0])).keys());
    await harness.killNode(3);
    await onboard(nodes[0].baseUrl);
    const rows = await indexRows(nodes[0]);
    const missed = [...rows.keys()].find((u) => !before.has(u));
    if (!missed) throw new Error("the transaction was not committed");
    report.ok(`committed ${missed.slice(0, 12)} on three nodes`);
    await harness.restartNode(3);
    await until("node 3 to be back", () => ready(behind), 60000);
    check(!(await holds(behind, missed)), "the returned node does not hold it");

    report.phase("Nobody can supply it");
    for (const i of [0, 1, 2]) await harness.killNode(i);
    const id = `${missed}:${Date.now()}`;
    await storagePut(
      behind.storageUrl,
      id,
      {
        _id: id,
        code: 950,
        processed: false,
        umid: missed,
        transaction: { $broadcast: true, $tx: {}, $revs: {} },
        reason: 'Vote Failure - "SPI#2 UMID not found',
      },
      "activeledgererrors"
    );
    report.ok("left a 950 record in its error database");

    report.phase("The agent keeps the record and counts the attempts");
    const tried = await until(
      "the agent to try and fail",
      async () => {
        const d = await storageGet(behind.storageUrl, id, "activeledgererrors");
        return d?.attempts >= 1 ? d : undefined;
      },
      90000
    );
    check(tried.processed === false, "the record is kept, not processed");
    check(typeof tried.nextAttemptAt === "number" && tried.nextAttemptAt > Date.now() - 1000, `it says when to try next (attempt ${tried.attempts})`);
    check(!(await holds(behind, missed)), "the node still does not hold the umid");

    report.phase("The others come back");
    await Promise.all([0, 1, 2].map((i) => harness.restartNode(i)));
    await until("the others to be back", async () => (await Promise.all([0, 1, 2].map((i) => ready(nodes[i])))).every(Boolean), 90000);
    report.ok("three nodes back");

    await until("the node to hold the umid", () => holds(behind, missed), 240000, 2000);
    report.ok("the agent fetched the umid on a later attempt");
    const index = await until("its index row", async () => ((await indexRows(behind)).has(missed) ? true : undefined), 30000);
    check(!!index, "and its row is in the node's umid index");
    // Done means out of the error database (the agent archives a finished record)
    const gone = async () => {
      try {
        return !(await storageGet(behind.storageUrl, id, "activeledgererrors"))?._id;
      } catch {
        return true;
      }
    };
    await until("the record to be finished", async () => ((await gone()) ? true : undefined), 60000);
    check(await gone(), "the 950 record is finished and no longer in the error database");
  } catch (e) {
    passed = false;
    report.fail(`aborted: ${(e as Error).message}`);
  } finally {
    await harness.stop();
  }
  console.log(passed ? "\nPASSED" : "\nFAILED");
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
