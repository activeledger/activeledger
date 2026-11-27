/**
 * Live test of a transaction the entry node resent under a new umid: the same
 * signed bytes, reposted before their $expire, must not run a second time.
 *
 * A node is made to disagree with the others about the client's stream (its
 * storage is written directly), a transaction with an $expire is sent to it,
 * and the node repairs itself and resends the transaction under a new umid.
 * The umid it gave up is never stored, so nothing used to stop a repost of the
 * same bytes once the node forgot the first attempt. The nodes here forget
 * after a couple of seconds (releaseHoldSeconds) so the repost can be made
 * soon enough. Checked:
 *  - the transaction committed under a different umid, and the umid the client
 *    can work out from what it sent is stored nowhere;
 *  - after the node has forgotten, a repost is refused, naming where it went,
 *    and the stream does not move;
 *  - the same after the node is restarted.
 *  - the same through every other node, which noted the first umid when it
 *    committed the transaction (the node that resent it is not the only one that knows).
 * With --canonical the network is at the build level where the umid is the hash of
 * $tx alone, and the same repost wrapped differently is refused too.
 * Not a Mocha suite - run via `npm run test:network:resend-replay` or
 * `npm run test:network:resend-replay-canonical`.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { NetworkHarness } from "./harness";
import { requestJson, storageGet, storagePut, submit } from "./http";
import { Report } from "./report";
import { deployContract, onboard, registerNamespace } from "./actions";
import { ActiveCrypto } from "../../packages/crypto/src";

const canonical = process.argv.includes("--canonical");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60000, every = 300): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({
    nodeCount: 4,
    basePort: 5740,
    // The node forgets a finished transaction after about two seconds
    config: { releaseHoldSeconds: 2, releaseStubSeconds: 1, releaseTailSeconds: 1, ...(canonical ? { build: ActiveCrypto.TransactionId.BUILD } : {}) },
    readyTimeoutMs: 40000,
  });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };

  try {
    report.phase("Booting 4 nodes, an identity, a namespace and a contract");
    const nodes = await harness.start();
    const entry = nodes[0];
    const identity = await onboard(nodes[1].baseUrl);
    const ns = `resend${Date.now().toString(36)}`;
    const reg = await registerNamespace(nodes[1].baseUrl, identity, ns);
    check(!reg.$summary?.errors, "namespace registered");
    const contractId = await deployContract(nodes[1].baseUrl, identity, ns, "returner", path.resolve(__dirname, "contracts/returner-contract.ts"));
    await sleep(3000);

    report.phase("Making the entry node disagree about the stream, then sending it a transaction with an $expire");
    const current = await storageGet(entry.storageUrl, identity.streamId);
    await storagePut(entry.storageUrl, identity.streamId, { ...current, resendMarker: Date.now() });
    const body = {
      $namespace: ns,
      $contract: contractId,
      $i: { [identity.streamId]: {} },
      $o: { [identity.streamId]: { message: "resend-replay" } },
      $expire: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    const tx = { $tx: body, $sigs: { [identity.streamId]: identity.keyPair.sign(body) } };
    // What the node hashes, and so what a client can work out before it posts
    const original = sha256(JSON.stringify(canonical ? body : tx));
    const first = await submit(entry.baseUrl, tx);
    const committed = !first.$summary?.errors && first.$summary?.commit >= 1;
    check(committed, `the transaction committed (${JSON.stringify(first.$summary)})`);
    const log = fs.readFileSync(entry.logPath, "utf8");
    if (!check(first.$umid !== original && /SPI \(Rewrite\) Resending #1/.test(log), "the entry node resent it under a new umid")) {
      throw new Error("the scenario did not cause a resend, so there is nothing to test");
    }
    const resentAs = first.$umid as string;
    report.ok(`resent as ${resentAs.slice(0, 12)}...; the umid worked out from the bytes sent is ${original.slice(0, 12)}...`);

    report.phase("The umid it gave up is stored nowhere");
    for (const n of nodes) {
      const doc = await storageGet(n.storageUrl, `${original}:umid`).catch(() => ({}));
      check(!doc?._id, `node ${n.index}: no ${original.slice(0, 8)}...:umid document`);
    }
    const there = await storageGet(entry.storageUrl, `${resentAs}:umid`).catch(() => ({}));
    check(!!there?._id, "the umid it was resent under is stored");
    const revBefore = (await storageGet(nodes[1].storageUrl, identity.streamId))._rev;

    report.phase("Reposting the same bytes after the node has forgotten the first attempt");
    await sleep(7000);
    const again = await submit(entry.baseUrl, tx);
    const message = again.$summary?.errors?.[0] ?? "";
    check(message === `Transaction Exists : ${original} (resent as ${resentAs})`, `refused: ${message || JSON.stringify(again.$summary)}`);
    check(again.$summary?.commit === 0, "and nothing committed");
    await sleep(1500);
    check((await storageGet(nodes[1].storageUrl, identity.streamId))._rev === revBefore, "the stream did not move");

    report.phase("Reposting through every other node");
    const wraps: [string, any][] = [["the same bytes", tx]];
    if (canonical) wraps.push(["the keys in another order", { $sigs: tx.$sigs, $tx: tx.$tx }], ["an extra field", { ...tx, note: "x" }]);
    for (const n of nodes.slice(1)) {
      for (const [what, copy] of wraps) {
        const r = await submit(n.baseUrl, copy);
        const m = r.$summary?.errors?.[0] ?? "";
        check(m === `Transaction Exists : ${original} (resent as ${resentAs})` && r.$summary?.commit === 0, `node ${n.index} refuses ${what}: ${m || JSON.stringify(r.$summary)}`);
      }
    }
    await sleep(1500);
    check((await storageGet(nodes[1].storageUrl, identity.streamId))._rev === revBefore, "the stream did not move");

    const rows = await requestJson(`${entry.storageUrl}/activeledgerevents/_all_docs`, "GET");
    const rowIds = ((rows.rows || []) as any[]).map((r) => String(r._id ?? r.id)).filter((id) => id.startsWith("resent:"));
    check(rowIds.includes(`resent:${original}`), `the node wrote a resent: row for it (${rowIds.length} row(s))`);

    report.phase("The same after the node is restarted");
    await harness.killNode(entry.index);
    await harness.restartNode(entry.index);
    await until("the node to settle", async () => ((await requestJson(`${entry.baseUrl}/a/status`, "GET")).status === 4 ? true : undefined), 60000, 1000);
    await sleep(3000);
    const afterRestart = await submit(entry.baseUrl, tx);
    const restartMessage = afterRestart.$summary?.errors?.[0] ?? "";
    check(restartMessage === `Transaction Exists : ${original} (resent as ${resentAs})`, `refused after a restart: ${restartMessage || JSON.stringify(afterRestart.$summary)}`);
    check(afterRestart.$summary?.commit === 0, "and nothing committed");
    await sleep(1500);
    check((await storageGet(nodes[1].storageUrl, identity.streamId))._rev === revBefore, "the stream still did not move");
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
