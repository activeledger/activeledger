/**
 * Runs one fixed scenario against a real multi-node network and writes a
 * normalised record of what a client saw and of what every node stored. Run it
 * on two builds (a release and a candidate) and compare the files with
 * tests/network/behaviour-compare.ts: any difference is a behaviour change, and
 * a node that stored something different from its neighbours is a consensus
 * bug in whichever build wrote the file.
 *
 *   npm run test:behaviour -- --out /tmp/candidate.json
 *
 * Not part of npm test (it boots a network and takes about a minute).
 */

import * as fs from "fs";
import * as http from "http";
import { ActiveCrypto } from "../../packages/crypto/src";
import { NetworkHarness, NetworkNode } from "./harness";
import { Identity, deployContract, lockContract, onboard, registerNamespace, runContract } from "./actions";
import { requestJson, submit } from "./http";
import * as path from "path";

const CONTRACTS = path.join(__dirname, "contracts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Replaces everything that is meant to differ between two runs, keeping what is meant to match. */
class Normaliser {
  private ids = new Map<string, string>();
  text(s: string): string {
    return s
      .replace(/[0-9a-f]{64}/g, (m) => {
        if (!this.ids.has(m)) this.ids.set(m, `<id${this.ids.size + 1}>`);
        return this.ids.get(m) as string;
      })
      .replace(/\b(\d+)-[0-9a-f]{32}\b/g, "<rev $1>")
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
      .replace(/127\.0\.0\.1:\d+/g, "<node>")
      .replace(/\[[^\]]*instance-\d+[^\]]*\]/g, "<path>");
  }
}
const norm = new Normaliser();

const committed = (r: any) => !!(r && r.$streams && ((r.$streams.updated && r.$streams.updated.length) || (r.$streams.new && r.$streams.new.length)));
const answered = (r: any) => !!(r && r.$summary);

/** What a client can rely on from a response, without the parts that are timing. */
function outcome(r: any) {
  const errors = (r && r.$summary && r.$summary.errors) || [];
  return {
    committed: committed(r),
    answered: answered(r),
    errors: errors.map((e: string) => norm.text(String(e))).sort(),
    streams: { new: (r?.$streams?.new || []).length, updated: (r?.$streams?.updated || []).length },
    responses: r && r.$responses ? norm.text(JSON.stringify(r.$responses)) : undefined,
  };
}

function rawPost(baseUrl: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + "/");
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: "/", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 20000 },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: text }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

async function allDocs(storageUrl: string, db: string): Promise<{ id: string; rev: string; doc: any }[]> {
  const r = await requestJson(`${storageUrl}/${db}/_all_docs?include_docs=true`, "GET");
  const rows: any[] = r.rows || [];
  return rows
    .map((x) => ({ id: x.id ?? x.doc?._id ?? x.key, rev: x.doc?._rev || x.value?.rev || "", doc: x.doc }))
    .filter((d) => typeof d.id === "string");
}

async function main() {
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "behaviour.json";
  const basePort = process.argv.includes("--base-port") ? Number(process.argv[process.argv.indexOf("--base-port") + 1]) : 5610;
  const harness = new NetworkHarness({ nodeCount: 4, basePort, readyTimeoutMs: 90000 });
  const steps: { name: string; result: unknown }[] = [];
  const record = (name: string, result: unknown) => {
    steps.push({ name, result });
    console.log(`  ${name}`);
  };
  let nodes: NetworkNode[] = [];
  try {
    nodes = await harness.start();
    const url = (i: number) => nodes[i % nodes.length].baseUrl;

    // Setup: an admin, a namespace, two contracts and four users
    const admin = await onboard(url(0));
    const namespace = `behaviour${Date.now().toString(36)}`;
    record("register namespace", outcome(await registerNamespace(url(0), admin, namespace)));
    const returner = await deployContract(url(0), admin, namespace, "returner", path.join(CONTRACTS, "returner-contract.ts"));
    const noWrite = await deployContract(url(0), admin, namespace, "no-write", path.join(CONTRACTS, "no-write-contract.ts"));
    const users: Identity[] = [];
    for (let i = 0; i < 4; i++) users.push(await onboard(url(i)));
    await sleep(1500);

    // Ordinary transactions, entering at each node in turn
    for (let i = 0; i < 6; i++) record(`update ${i}`, outcome(await runContract(url(i), users[i % 4], namespace, returner, { message: `m${i}` })));
    record("a contract that writes no state", outcome(await runContract(url(1), users[0], namespace, noWrite, { message: "read" })));

    // Things that must be refused, and how
    const body = (u: Identity, contract: string, ns = namespace) => ({ $namespace: ns, $contract: contract, $i: { [u.streamId]: {} }, $o: { [u.streamId]: { message: "x" } } });
    const wrongKey = body(users[0], returner);
    record("signed with someone else's key", outcome(await submit(url(0), { $tx: wrongKey, $sigs: { [users[0].streamId]: users[1].keyPair.sign(wrongKey) } })));
    record("no signature", outcome(await submit(url(0), { $tx: body(users[0], returner), $sigs: {} })));
    const unknown = body(users[0], "0".repeat(64));
    record("unknown contract", outcome(await submit(url(0), { $tx: unknown, $sigs: { [users[0].streamId]: users[0].keyPair.sign(unknown) } })));
    const noNs = body(users[0], returner, "no-such-namespace");
    record("unknown namespace", outcome(await submit(url(0), { $tx: noNs, $sigs: { [users[0].streamId]: users[0].keyPair.sign(noNs) } })));
    const ghost = { $namespace: namespace, $contract: returner, $i: { ["f".repeat(64)]: {} }, $o: { ["f".repeat(64)]: { message: "x" } } };
    record("input stream that does not exist", outcome(await submit(url(0), { $tx: ghost, $sigs: { ["f".repeat(64)]: users[0].keyPair.sign(ghost) } })));

    // Onboarding the same key twice
    const kp = new ActiveCrypto.KeyPair("secp256k1");
    const keys = kp.generate(256, true);
    const ob = { $namespace: "default", $contract: "onboard", $i: { identity: { type: "secp256k1", publicKey: keys.pub.pkcs8pem } }, $o: {} };
    const obTx = { $tx: ob, $selfsign: true, $sigs: { identity: kp.sign(ob) } };
    record("onboard a new identity", outcome(await submit(url(0), obTx)));
    record("onboard the same key again", outcome(await submit(url(1), obTx)));

    // Locking a contract
    record("lock the contract", outcome(await lockContract(url(0), admin, namespace, returner, "")));
    await sleep(1000);
    record("run a locked contract", outcome(await runContract(url(2), users[1], namespace, returner, { message: "locked" })));
    record("unlock the contract", outcome(await lockContract(url(0), admin, namespace, returner, "", "unlock")));
    await sleep(1000);
    record("run it after unlocking", outcome(await runContract(url(3), users[1], namespace, returner, { message: "unlocked" })));

    // Bodies: a big valid one takes the direct JSON route, a big invalid one must still be refused
    record("a large valid body", outcome(await runContract(url(0), users[2], namespace, returner, { message: "L".repeat(40000) })));
    const bad = await rawPost(url(0), "{" + "x".repeat(30000));
    record("a large invalid body", { status: bad.status, body: norm.text(bad.body).slice(0, 120) });
    const notJson = await rawPost(url(0), "not json at all");
    record("a body that is not json", { status: notJson.status, body: norm.text(notJson.body).slice(0, 120) });

    // Concurrency on one stream: the outcomes may differ run to run, what they may be may not
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => runContract(url(i), users[3], namespace, returner, { message: `race${i}` }).catch((e) => ({ thrown: String(e).slice(0, 80) }))));
    const kinds = new Set(burst.map((r: any) => (r.thrown ? "thrown" : committed(r) ? "committed" : "refused")));
    record("eight at once on one stream", { atLeastOneCommitted: kinds.has("committed"), neverThrown: !kinds.has("thrown"), refusals: [...new Set(burst.filter((r: any) => !committed(r) && !r.thrown).flatMap((r: any) => outcome(r).errors))].sort() });

    // Spread load across all users and nodes
    const spread = await Promise.all(Array.from({ length: 40 }, (_, i) => runContract(url(i), users[i % 4], namespace, returner, { message: `s${i}` }).catch(() => ({}))));
    record("forty at once across users and nodes", { answeredAll: spread.every((r: any) => answered(r)), committedAtLeast: spread.filter((r: any) => committed(r)).length >= 4 });

    // Every node must now hold exactly the same documents
    await sleep(6000);
    const perNode = await Promise.all(nodes.map((n) => allDocs(n.storageUrl, "activeledger")));
    const eventsPerNode = await Promise.all(nodes.map((n) => allDocs(n.storageUrl, "activeledgerevents")));
    const revs = (docs: { id: string; rev: string }[]) => new Map(docs.map((d) => [d.id, d.rev]));
    const first = revs(perNode[0]);
    let missing = 0, revMismatch = 0, umidDocMismatch = 0;
    for (let n = 1; n < perNode.length; n++) {
      const other = revs(perNode[n]);
      for (const [id, rev] of first) {
        if (!other.has(id)) missing++;
        else if (other.get(id) !== rev) revMismatch++;
      }
      for (const id of other.keys()) if (!first.has(id)) missing++;
      const byId = new Map(perNode[n].map((d) => [d.id, d]));
      for (const d of perNode[0]) {
        if (!d.id.endsWith(":umid")) continue;
        const o = byId.get(d.id);
        if (o && JSON.stringify(o.doc) !== JSON.stringify(d.doc)) umidDocMismatch++;
      }
    }
    const eventIds = (docs: { id: string }[]) => docs.map((d) => d.id).sort().join("|");
    const kind = (id: string) => (id.endsWith(":umid") ? "umid" : id.endsWith(":stream") ? "meta" : id.endsWith(":volatile") ? "volatile" : id.startsWith("_design") ? "design" : "stream");
    const counts: Record<string, number> = {};
    for (const d of perNode[0]) counts[kind(d.id)] = (counts[kind(d.id)] || 0) + 1;
    record("every node holds the same documents", {
      nodes: nodes.length,
      documentsMissingOnSomeNode: missing,
      revisionsThatDiffer: revMismatch,
      umidDocumentsThatDiffer: umidDocMismatch,
      eventRowsIdenticalOnEveryNode: eventsPerNode.every((e) => eventIds(e) === eventIds(eventsPerNode[0])),
      umidDocumentsAndEventRowsAgree: counts.umid === eventsPerNode[0].filter((e) => e.id.startsWith("umid:")).length,
      documentKinds: counts,
    });
  } finally {
    await harness.stop().catch(() => undefined);
    try {
      harness.cleanup();
    } catch {
      // gone already
    }
  }
  fs.writeFileSync(out, JSON.stringify({ steps }, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
