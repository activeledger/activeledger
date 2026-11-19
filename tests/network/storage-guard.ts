/**
 * Live test that a contract cannot reach a node's storage through the HTTP
 * toolkit, on a real 4-node network.
 *
 * An owner namespace keeps a secret in a stream's volatile data. A contract in
 * another namespace tries to read it, and to overwrite it, with the HTTP
 * toolkit pointed at the node's storage port. Both transactions must be
 * refused and the secret must be unchanged on every node's storage. A
 * namespace the node's config allows (security.contractEgress.allow) reaches
 * the database it was given, and nothing else. Not a Mocha suite - run with
 * `npx tsx tests/network/storage-guard.ts`.
 */
import * as path from "path";
import { NetworkHarness } from "./harness";
import { requestJson } from "./http";
import { Report } from "./report";
import { onboard, registerNamespace, deployContract, runContract } from "./actions";

const BASE = 5810;
// A node's storage is on its port minus one
const STORAGE = [0, 1, 2, 3].map((i) => BASE + i * 10 - 1);

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({
    nodeCount: 4,
    basePort: BASE,
    readyTimeoutMs: 60000,
    config: {
      build: 50600,
      security: {
        contractEgress: {
          // The harness runs every node on one machine, so each node must also
          // keep contracts off the others' storage ports
          protect: STORAGE,
          // Deliberately generous: the whole port. The node's own databases and
          // :volatile are refused whatever a list says.
          allow: { trusted: STORAGE.map((p) => `127.0.0.1:${p}`) },
        },
      },
    },
  });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = passed && ok;
    return ok;
  };
  // The network accepts a transaction when every vote is yes and nothing errored (the reply can come before every commit has)
  const refused = (r: any) => !(r?.$summary && !r.$summary.errors?.length && r.$summary.vote >= r.$summary.total);
  const why = (r: any) => (r?.$summary?.errors?.length ? String(r.$summary.errors[0]) : JSON.stringify(r?.$summary ?? r)).slice(0, 160);

  try {
    report.phase("Booting 4 nodes");
    const nodes = await harness.start();
    const entry = nodes[0];

    report.phase("The owner keeps a secret in volatile data");
    const owner = await onboard(entry.baseUrl);
    await registerNamespace(entry.baseUrl, owner, "owner");
    const setterId = await deployContract(entry.baseUrl, owner, "owner", "setter", path.join(__dirname, "contracts/volatile-setter-contract.ts"));
    const set = await runContract(entry.baseUrl, owner, "owner", setterId, { secret: "SHARD-123" });
    if (refused(set)) report.fail(`the setter did not commit: ${JSON.stringify(set?.$summary)}`);
    const volatile = async (n: number) => {
      try { return (await requestJson(`${nodes[n].storageUrl}/activeledger/${encodeURIComponent(owner.streamId + ":volatile")}`, "GET")).secret; } catch { return undefined; }
    };
    report.ok(`raw volatile on node 1: ${JSON.stringify(await requestJson(`${nodes[0].storageUrl}/activeledger/${encodeURIComponent(owner.streamId + ":volatile")}`, "GET").catch((e) => String(e)))}`);
    // Each node writes its own copy as it commits, so give the slowest a moment
    for (let n = 0; n < 4; n++) {
      for (let wait = 0; wait < 40 && (await volatile(n)) !== "SHARD-123"; wait++) await new Promise((r) => setTimeout(r, 250));
      check((await volatile(n)) === "SHARD-123", `node ${n + 1} holds the secret`);
    }

    report.phase("A contract in another namespace cannot read or overwrite it");
    const evil = await onboard(entry.baseUrl);
    await registerNamespace(entry.baseUrl, evil, "evil");
    const evilProbe = await deployContract(entry.baseUrl, evil, "evil", "probe", path.join(__dirname, "contracts/storage-probe-contract.ts"));
    const target = `${entry.storageUrl}/activeledger/${encodeURIComponent(owner.streamId + ":volatile")}`;
    const read = await runContract(entry.baseUrl, evil, "evil", evilProbe, { url: target, method: "GET" });
    check(refused(read), `reading the volatile data through the HTTP toolkit is refused (${why(read)})`);
    const write = await runContract(entry.baseUrl, evil, "evil", evilProbe, {
      url: `${entry.storageUrl}/activeledger/_bulk_docs`,
      method: "POST",
      body: { docs: [{ _id: owner.streamId + ":volatile", secret: "STOLEN" }], options: {} },
    });
    check(refused(write), `overwriting it through the HTTP toolkit is refused (${why(write)})`);
    for (let n = 0; n < 4; n++) check((await volatile(n)) === "SHARD-123", `node ${n + 1} still holds the original secret`);

    report.phase("A namespace the config allows still cannot touch the node's own databases or any :volatile");
    const trusted = await onboard(entry.baseUrl);
    await registerNamespace(entry.baseUrl, trusted, "trusted");
    const trustedProbe = await deployContract(entry.baseUrl, trusted, "trusted", "probe", path.join(__dirname, "contracts/storage-probe-contract.ts"));
    // A database of its own, on every node
    for (const n of nodes) await requestJson(`${n.storageUrl}/activeledgerwallets`, "PUT", { name: "activeledgerwallets" }).catch(() => undefined);
    const wallets = await runContract(entry.baseUrl, trusted, "trusted", trustedProbe, { url: `${entry.storageUrl}/activeledgerwallets/_all_docs`, method: "GET" });
    check(!refused(wallets), `its own database can be read (${why(wallets)})`);
    const ledgerVolatile = await runContract(entry.baseUrl, trusted, "trusted", trustedProbe, { url: target, method: "GET" });
    check(refused(ledgerVolatile), "the ledger's volatile data is refused even with the whole port listed");
    const ledger = await runContract(entry.baseUrl, trusted, "trusted", trustedProbe, { url: `${entry.storageUrl}/activeledger/_all_docs`, method: "GET" });
    check(refused(ledger), "the ledger database is refused");
    const events = await runContract(entry.baseUrl, trusted, "trusted", trustedProbe, { url: `${entry.storageUrl}/activeledgerevents/_all_docs`, method: "GET" });
    check(refused(events), "the events database is refused");
    const ownVolatile = await runContract(entry.baseUrl, trusted, "trusted", trustedProbe, { url: `${entry.storageUrl}/activeledgerwallets/x%3Avolatile`, method: "GET" });
    check(refused(ownVolatile), "a :volatile document is refused even in its own database");
    for (let n = 0; n < 4; n++) check((await volatile(n)) === "SHARD-123", `node ${n + 1} still holds the original secret`);

    report.phase("The network carries on");
    const after = await onboard(nodes[2].baseUrl);
    check(!!after.streamId, "a transaction commits afterwards");
  } catch (e) {
    passed = false;
    report.fail(`aborted: ${(e as Error).message}`);
  } finally {
    await harness.stop();
    harness.cleanup();
  }
  console.log(passed ? "\nPASSED" : "\nFAILED");
  return passed;
}

main().then((ok) => process.exit(ok ? 0 : 1));
