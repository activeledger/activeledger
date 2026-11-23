/**
 * Live edge cases for leader mode ($tx.$leader) and the brick in issue #127
 * (a stream that stops accepting writes after a leader vote):
 *
 *  1. territorial: the transaction names a commit node ($territoriality) so it
 *     is not broadcast. Sent with and without $leader, every node must end on
 *     the same revision, and a normal write afterwards must still commit.
 *  2. a commit that fails on one node: while leader transactions run, one
 *     node's own copy of the streams is rewritten over and over, so some
 *     commits there hit a revision conflict while the others succeed. When the
 *     rewriting stops the nodes must agree again and every stream must accept
 *     a new write (not bricked). Run with and without $leader for comparison.
 *
 *   npm run test:network:leader-edge   (or npx tsx tests/network/leader-edge-live.ts [rounds] [clients])
 */

import { hotTransaction, setupWorkload, timedSubmit, uniqueTransaction, withNetwork, sleep, Workload } from "../stress/lib/workload";
import { requestJson, storageGet, storagePut, submit } from "./http";
import { NetworkNode } from "./harness";
import { ownerOf } from "../../packages/network/src/network/home";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`FAIL ${m}`);
};

/** Every node's own copy of every stream: wait until they agree (or time out) and say how many differ. */
async function settle(w: Workload, nodes: NetworkNode[], ms = 25000): Promise<{ differ: number; detail: string[] }> {
  const until = Date.now() + ms;
  let detail: string[] = [];
  for (;;) {
    detail = [];
    for (let c = 0; c < w.identities.length; c++) {
      const copies = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, w.identities[c].streamId).catch(() => null)));
      const revs = copies.map((d) => (d ? d._rev : null));
      const msgs = copies.map((d) => (d ? d.message : null));
      if (new Set(revs).size > 1 || new Set(msgs).size > 1) detail.push(`stream ${c}: ${JSON.stringify(msgs)} ${JSON.stringify(revs)}`);
    }
    if (!detail.length || Date.now() > until) return { differ: detail.length, detail };
    await sleep(500);
  }
}

/** A normal (not leader) write to every stream: all must commit. Returns the failures. */
async function followUp(w: Workload, nodes: NetworkNode[], tag: string): Promise<string[]> {
  const out = await Promise.all(w.identities.map((_, c) => timedSubmit(nodes[(c + 1) % nodes.length].baseUrl, hotTransaction(w, c, `${tag}${c}`, false))));
  return out.map((x, c) => (x.committed ? "" : `stream ${c}: ${x.reason}`)).filter(Boolean);
}

async function territorial(w: Workload, nodes: NetworkNode[], rounds: number) {
  const refs: string[] = [];
  for (const n of nodes) refs.push((await requestJson(`${n.baseUrl}/a/status`, "GET")).reference);
  for (const leader of [false, true]) {
    const tag = leader ? "L" : "N";
    // A forwarded territorial transaction answers with what the commit node
    // returned (an empty summary), so the outcome is read from the streams
    for (let r = 0; r < rounds; r++) {
      await Promise.all(
        w.identities.map((_, c) => {
          const tx: any = hotTransaction(w, c, `t${tag}${r}c${c}`, leader);
          tx.$territoriality = refs[(c + r) % refs.length];
          return timedSubmit(nodes[c % nodes.length].baseUrl, tx);
        })
      );
      // The forwarded answer comes back before the commit: let it land everywhere first
      const landed = Date.now() + 8000;
      for (;;) {
        const copies = await Promise.all(
          w.identities.map((id) => Promise.all(nodes.map((n) => storageGet(n.storageUrl, id.streamId).catch(() => null))))
        );
        if (copies.every((per, c) => per.every((d) => d && d.message === `t${tag}${r}c${c}`)) || Date.now() > landed) break;
        await sleep(100);
      }
    }
    const s = await settle(w, nodes);
    const last = rounds - 1;
    let notLast = 0;
    for (let c = 0; c < w.identities.length; c++) {
      const copies = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, w.identities[c].streamId).catch(() => null)));
      if (copies.some((d) => !d || d.message !== `t${tag}${last}c${c}`)) { notLast++; if (notLast <= 4) console.log(`  stream ${c} (entry node ${c % nodes.length}) ends at ${JSON.stringify(copies.map((d) => d && d.message))}, wanted t${tag}${last}c${c}`); }
    }
    console.log(`territorial ${leader ? "with $leader" : "without    "}: ${rounds * w.identities.length} sent, ${notLast} streams not at the last write on every node, ${s.differ} streams differ`);
    // Territorial: the named node writes first, and every write must land everywhere
    if (s.differ) {
      s.detail.slice(0, 3).forEach((d) => console.log("  " + d));
      fail(`territorial ${leader ? "leader" : "normal"}: ${s.differ} streams differ across nodes`);
    }
    if (notLast) fail(`territorial ${leader ? "leader" : "normal"}: ${notLast} streams missed their last write`);
    if (process.env.EDGE_LOGS && notLast) {
      const fs = require("fs");
      for (const n of nodes) {
        const lines = String(fs.readFileSync(n.logPath)).split("\n").filter((l: string) => /error|fail|busy|lock|rebroadcast|territor|unknown/i.test(l));
        console.log(`--- node ${n.index} log (${lines.length} matching lines, last 12)`);
        lines.slice(-12).forEach((l: string) => console.log("   " + l.slice(0, 260)));
      }
    }
    const stuck = await followUp(w, nodes, `tf${tag}`);
    const healed = await settle(w, nodes, 15000);
    console.log(`  follow-up writes: ${stuck.length ? stuck.length + " failed" : "all committed"}; ${healed.differ} streams differ after them`);
    if (stuck.length) fail(`territorial ${leader ? "leader" : "normal"}: bricked streams, ${stuck[0]}`);
    if (healed.differ) fail(`territorial ${leader ? "leader" : "normal"}: ${healed.differ} streams still differ after a follow-up write`);
  }
}

/** Territorial transactions of other shapes: with an $expire, creating a new stream, and with $leader asked for. */
async function territorialShapes(w: Workload, nodes: NetworkNode[]) {
  const refs: string[] = [];
  for (const n of nodes) refs.push((await requestJson(`${n.baseUrl}/a/status`, "GET")).reference);
  const landed = async (streamId: string, message?: string) => {
    const until = Date.now() + 10000;
    for (;;) {
      const copies = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, streamId).catch(() => null)));
      if (copies.every((d) => d && (message === undefined || d.message === message)) && new Set(copies.map((d) => d._rev)).size === 1) return true;
      if (Date.now() > until) return false;
      await sleep(100);
    }
  };

  // The forwarded client answer is the owner's real one, not an empty summary
  // (entry node and named node are never the same here: forwarded every time)
  for (let i = 0; i < 4; i++) {
    const tx: any = hotTransaction(w, 0, `answer${i}`, false);
    tx.$territoriality = refs[(i + 2) % 4];
    const r: any = await submit(nodes[i].baseUrl, tx);
    const says = !!(r && r.$umid && r.$streams && r.$streams.updated && r.$streams.updated.length && r.$summary && r.$summary.commit > 0 && r.$responses && r.$responses.length);
    if (!says) fail(`territorial answer ${i} was not a committed response: ${JSON.stringify(r).slice(0, 160)}`);
    if (!(await landed(w.identities[0].streamId, `answer${i}`))) fail(`territorial answer ${i} did not land on every node`);
  }
  console.log("territorial answers: the client is given the committed response from the node that wrote");

  // $expire is part of the umid check on the entry node and again on the owner
  {
    const base: any = hotTransaction(w, 1, "expiring", false);
    const body = { ...base.$tx, $expire: new Date(Date.now() + 120000).toISOString() };
    const tx: any = { $tx: body, $sigs: { [w.identities[1].streamId]: w.identities[1].keyPair.sign(body) }, $territoriality: refs[3] };
    const r: any = await submit(nodes[0].baseUrl, tx);
    const ok = !!(r && r.$streams && r.$streams.updated && r.$streams.updated.length);
    if (!ok) fail(`territorial transaction with $expire did not commit: ${JSON.stringify(r).slice(0, 160)}`);
    if (!(await landed(w.identities[1].streamId, "expiring"))) fail("territorial $expire transaction did not land on every node");
    // The same bytes again must be refused as already accepted, not run twice
    const again: any = await submit(nodes[0].baseUrl, JSON.parse(JSON.stringify(tx)));
    const refused = !(again && again.$streams && again.$streams.updated && again.$streams.updated.length);
    console.log(`territorial with $expire: committed ${ok}, the same transaction sent again ${refused ? "refused" : "ACCEPTED"}`);
    if (!refused) fail("an $expire transaction sent twice was accepted twice");
  }

  // A transaction that creates a stream
  {
    const tx: any = uniqueTransaction();
    tx.$territoriality = refs[2];
    const r: any = await submit(nodes[0].baseUrl, tx);
    const id = r && r.$streams && r.$streams.new && r.$streams.new[0] && (r.$streams.new[0].id || r.$streams.new[0]);
    if (!id) { fail(`territorial new stream was not created: ${JSON.stringify(r).slice(0, 160)}`); return; }
    if (!(await landed(String(id)))) fail("territorial new stream is not the same on every node");
    else console.log("territorial new stream exists, at the same revision, on every node");
  }

  // $leader asked for on a territorial transaction: runs as a normal territorial transaction
  {
    const tx: any = hotTransaction(w, 2, "terri-leader", true);
    tx.$territoriality = refs[1];
    const r: any = await submit(nodes[3].baseUrl, tx);
    if (r && r.$leader) fail("a territorial transaction was answered as a leader transaction");
    if (!(await landed(w.identities[2].streamId, "terri-leader"))) fail("territorial $leader transaction did not land on every node");
    console.log(`territorial with $leader asked for: lands everywhere, response says $leader: ${r && r.$leader ? "yes" : "no"}`);
  }
}

/** What each node's log says about errors and positions, for a failing scenario */
function dumpLogs(nodes: NetworkNode[], pattern = /error|fail|position|busy|spi|leader|lock|vote/i, last = 14) {
  const fs = require("fs");
  for (const n of nodes) {
    const lines = String(fs.readFileSync(n.logPath)).split("\n").filter((l: string) => pattern.test(l)).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    console.log(`--- node ${n.index} log: ${lines.length} matching lines, last ${last}`);
    lines.slice(-last).forEach((l: string) => console.log("   " + l.slice(0, 230)));
  }
}

/** Wait until no node has written to its log for `still` ms (a forked stream keeps the nodes busy repairing it for a minute or more) */
async function quiet(nodes: NetworkNode[], still = 6000, max = 120000): Promise<number> {
  const fs = require("fs");
  const began = Date.now();
  let last = nodes.map((n) => fs.statSync(n.logPath).size).join(",");
  let since = Date.now();
  while (Date.now() - began < max) {
    await sleep(1000);
    const now = nodes.map((n) => fs.statSync(n.logPath).size).join(",");
    if (now !== last) (last = now), (since = Date.now());
    else if (Date.now() - since >= still) break;
  }
  return Date.now() - began;
}

const revNumber = (d: any): number => (d && typeof d._rev === "string" ? parseInt(d._rev.split("-")[0], 10) : NaN);

/**
 * Every entry node writes the SAME stream at the same moment (the real shape of
 * #127: a stream that several leaders race for). Whatever the clients are told
 * committed must be exactly what every node holds: the revision moves by the
 * number of commits reported, identically on all four nodes, and the stream
 * still takes a normal write afterwards.
 */
async function contention(w: Workload, nodes: NetworkNode[], rounds: number, mode: "normal" | "leader" | "territorial" | "mixed", client: number, known = false) {
  // `known`: a limit of the mode that is reported, not failed (see the summary line)
  const bad = (m: string) => (known ? console.log(`KNOWN LIMIT ${m}`) : fail(m));
  const id = w.identities[client];
  const refs: string[] = [];
  for (const n of nodes) refs.push((await requestJson(`${n.baseUrl}/a/status`, "GET")).reference);
  const start = revNumber(await storageGet(nodes[0].storageUrl, id.streamId));
  let told = 0, tried = 0;
  for (let r = 0; r < rounds; r++) {
    const results = await Promise.all(
      nodes.map((n, k) => {
        const tx: any = hotTransaction(w, client, `${mode}-${r}-${k}`, mode === "leader" || (mode === "mixed" && k % 2 === 0));
        if (mode === "territorial") tx.$territoriality = refs[(k + r) % 4];
        tried++;
        return submit(n.baseUrl, tx).then(
          (x: any) => !!(x && x.$streams && ((x.$streams.updated && x.$streams.updated.length) || (x.$streams.new && x.$streams.new.length))),
          () => false
        );
      })
    );
    told += results.filter(Boolean).length;
    if (mode === "territorial") await sleep(600); // a forwarded answer is not a committed one on every node yet
  }
  // Let it settle, then every node must be on one revision
  const until = Date.now() + 25000;
  let revs: number[] = [], msgs: string[] = [];
  for (;;) {
    const copies = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, id.streamId).catch(() => null)));
    revs = copies.map(revNumber);
    msgs = copies.map((d) => (d ? d.message : ""));
    if ((new Set(revs).size === 1 && new Set(msgs).size === 1) || Date.now() > until) break;
    await sleep(400);
  }
  const moved = revs[0] - start;
  const disagree = new Set(revs).size > 1 || new Set(msgs).size > 1;
  if (disagree && (mode === "leader" || mode === "mixed")) {
    dumpLogs(nodes);
    // What each node's log says about this very stream
    console.log(`stream ${id.streamId}`);
    dumpLogs(nodes, new RegExp(id.streamId.slice(0, 16)), 12);
  }
  console.log(`contention ${mode.padEnd(11)}: ${tried} writers at once on one stream, clients told ${told} committed; revision moved ${moved} on nodes [${revs.join(",")}]`);
  if (disagree && mode === "leader") {
    // Does a node that missed the burst get back, if given a normal write and time?
    const heal = await timedSubmit(nodes[1].baseUrl, hotTransaction(w, client, "heal", false));
    const t0 = Date.now();
    let same = false;
    while (Date.now() - t0 < 45000 && !same) {
      await sleep(1000);
      const c = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, id.streamId).catch(() => null)));
      same = new Set(c.map(revNumber)).size === 1;
    }
    console.log(`  after a normal write (${heal.committed ? "committed" : "failed"}), the nodes ${same ? "agree again after " + Math.round((Date.now() - t0) / 1000) + " s" : "STILL disagree after 45 s"}`);
  }
  if (new Set(revs).size > 1 || new Set(msgs).size > 1) bad(`contention ${mode}: nodes disagree: ${JSON.stringify(msgs)} ${JSON.stringify(revs)}`);
  // Territorial answers are the owner's, which may be an error for a busy stream, so only count exactly for the others
  if (mode !== "territorial" && moved !== told) bad(`contention ${mode}: clients were told ${told} committed but the stream moved ${moved}`);
  if (mode === "territorial" && moved < 1) bad("contention territorial: nothing committed");
  // A normal write to this stream afterwards
  const after = await timedSubmit(nodes[1].baseUrl, hotTransaction(w, client, `after-${mode}`, false));
  console.log(`  a normal write to that stream afterwards: ${after.committed ? "committed" : "FAILED: " + String(after.reason).slice(0, 120)}`);
  if (!after.committed) bad(`contention ${mode}: the stream would not take a normal write afterwards`);
}

/**
 * Leader mode is routed to the node that owns the stream: wherever the client
 * sends it the answer is a leader answer, a transaction writing streams of
 * different owners is a normal one, and one writing streams of the same owner
 * is still a leader one.
 */
async function leaderRouting(w: Workload, nodes: NetworkNode[]) {
  const refs: string[] = [];
  for (const n of nodes) refs.push((await requestJson(`${n.baseUrl}/a/status`, "GET")).reference);
  const sorted = [...refs].sort();
  const ownerOfStream = (c: number) => refs.indexOf(ownerOf(w.identities[c].streamId, sorted) as string);
  const saysLeader = (r: any) => !!(r && r.$leader);
  const wrote = (r: any) => !!(r && r.$streams && r.$streams.updated && r.$streams.updated.length);

  // From every entry node, one stream
  const c = 0;
  const seen: string[] = [];
  for (let k = 0; k < nodes.length; k++) {
    const r: any = await submit(nodes[k].baseUrl, hotTransaction(w, c, `routed${k}`, true));
    seen.push(`${k === ownerOfStream(c) ? "owner" : "forwarded"}:${wrote(r) && saysLeader(r) ? "leader" : "NOT leader"}`);
    if (!wrote(r)) fail(`leader transaction through node ${k} did not commit: ${JSON.stringify(r).slice(0, 140)}`);
    else if (!saysLeader(r)) fail(`leader transaction through node ${k} was not answered as a leader transaction`);
  }
  console.log(`leader routing, stream owned by node ${ownerOfStream(c)}, entered at each node: ${seen.join(", ")}`);

  // Two streams written, owned by different nodes, then by the same node
  const pairs: { same: number[] | undefined; diff: number[] | undefined } = { same: undefined, diff: undefined };
  for (let a = 0; a < w.identities.length; a++) {
    for (let b = a + 1; b < w.identities.length; b++) {
      if (ownerOfStream(a) === ownerOfStream(b)) pairs.same = pairs.same || [a, b];
      else pairs.diff = pairs.diff || [a, b];
    }
  }
  for (const [kind, pair] of [["different owners", pairs.diff], ["the same owner", pairs.same]] as const) {
    if (!pair) { console.log(`leader routing, ${kind}: no such pair among the test streams`); continue; }
    const [a, b] = pair;
    const body = { $namespace: w.namespace, $contract: w.contractId, $i: { [w.identities[a].streamId]: {} }, $o: { [w.identities[b].streamId]: { message: `pair-${kind}` } }, $leader: true };
    const tx = { $tx: body, $sigs: { [w.identities[a].streamId]: w.identities[a].keyPair.sign(body) } };
    const r: any = await submit(nodes[1].baseUrl, tx);
    const want = kind === "the same owner";
    console.log(`leader routing, two streams with ${kind}: committed ${wrote(r)}, answered as leader ${saysLeader(r)} (expected ${want})`);
    if (!wrote(r)) fail(`two streams with ${kind} did not commit: ${JSON.stringify(r).slice(0, 140)}`);
    else if (saysLeader(r) !== want) fail(`two streams with ${kind}: answered as leader ${saysLeader(r)}, expected ${want}`);
  }
}

/** A leader transaction whose commit fails: the client is told, and no node moved. */
async function failedCommit(w: Workload, nodes: NetworkNode[]) {
  const id = w.identities[4];
  // The conflict scenario before this rewrote copies on one node; let that heal first, or a repair reads as the commit moving a stream
  await settle(w, nodes, 20000);
  const before = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, id.streamId)));
  const r: any = await submit(nodes[1].baseUrl, hotTransaction(w, 4, "commit-fail", true));
  const said = !!(r && r.$streams && ((r.$streams.updated && r.$streams.updated.length) || (r.$streams.new && r.$streams.new.length)));
  await sleep(2000);
  const after = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, id.streamId)));
  const moved = after.some((d, i) => d._rev !== before[i]._rev);
  if (moved) console.log(`  before ${JSON.stringify(before.map((d) => [d._rev, d.message]))}\n  after  ${JSON.stringify(after.map((d) => [d._rev, d.message]))}`);
  console.log(`leader commit that fails: client told ${said ? "COMMITTED" : "failed"}, a stream moved: ${moved}${r && r.$leader ? ", response says $leader" : ""}`);
  if (said) fail("a leader transaction whose commit failed was reported as committed");
  if (moved) fail("a leader transaction whose commit failed still changed a stream");
  const ok = await timedSubmit(nodes[2].baseUrl, hotTransaction(w, 4, "after-commit-fail", false));
  if (!ok.committed) fail(`the stream would not take a write after a failed leader commit: ${ok.reason}`);
}

/** $leader with $unanimous is a normal transaction: committed, and not answered as leader. */
async function unanimousLeader(w: Workload, nodes: NetworkNode[]) {
  const tx: any = hotTransaction(w, 5, "unanimous", true);
  tx.$unanimous = true;
  const r: any = await submit(nodes[0].baseUrl, tx);
  const ok = !!(r && r.$streams && r.$streams.updated && r.$streams.updated.length);
  console.log(`$leader with $unanimous: committed ${ok}, response says $leader: ${r && r.$leader ? "yes" : "no"}`);
  if (!ok) fail(`a unanimous transaction asking for leader did not commit: ${JSON.stringify(r).slice(0, 160)}`);
  if (r && r.$leader) fail("a unanimous transaction was answered as a leader transaction");
}

async function commitConflict(w: Workload, nodes: NetworkNode[], rounds: number) {
  const victim = nodes[nodes.length - 1];
  for (const leader of [false, true]) {
    let running = true;
    let rewrites = 0;
    // Rewrites the victim node's own copies, racing the commits that land there
    const chaos = (async () => {
      while (running) {
        await Promise.all(
          w.identities.map(async (id) => {
            const cur = await storageGet(victim.storageUrl, id.streamId).catch(() => null);
            if (cur) {
              await storagePut(victim.storageUrl, id.streamId, { ...cur, chaos: Date.now() }).then(() => rewrites++, () => undefined);
            }
          })
        );
        await sleep(2);
      }
    })();
    let bad = 0;
    for (let r = 0; r < rounds; r++) {
      const results = await Promise.all(
        w.identities.map((_, c) => timedSubmit(nodes[c % (nodes.length - 1)].baseUrl, hotTransaction(w, c, `x${leader ? "L" : "N"}${r}c${c}`, leader)))
      );
      for (const x of results) if (!x.committed) bad++;
    }
    running = false;
    await chaos;
    // Nodes that lost a commit to the conflict have to repair themselves from a write
    const first = await settle(w, nodes, 8000);
    const stuck = await followUp(w, nodes, `xf${leader ? "L" : "N"}`);
    const second = await settle(w, nodes, 25000);
    console.log(
      `commit conflict on ${victim.port} ${leader ? "with $leader" : "without    "}: ${rewrites} rewrites, ${rounds * w.identities.length} sent, ${bad} not committed; ` +
        `${first.differ} streams differ after the burst, ${stuck.length} follow-up writes failed, ${second.differ} differ after them`
    );
    if (stuck.length) { console.log("  " + stuck.slice(0, 3).join("\n  ")); fail(`commit conflict ${leader ? "leader" : "normal"}: ${stuck.length} streams would not take a write`); }
    if (second.differ) { second.detail.slice(0, 3).forEach((d) => console.log("  " + d)); fail(`commit conflict ${leader ? "leader" : "normal"}: ${second.differ} streams never converged`); }
  }
}

async function main(): Promise<number> {
  const rounds = Number(process.argv[2] || 6);
  const clients = Number(process.argv[3] || 8);
  await withNetwork({ nodeCount: 4, basePort: 5730, readyTimeoutMs: 60000 }, async (_h, nodes) => {
    const w = await setupWorkload(nodes, "returner-leader", clients);
    if (process.env.EDGE_ONLY === "leader-contention") {
      for (let i = 0; i < Number(process.env.EDGE_REPEAT || 5); i++) await contention(w, nodes, Math.max(4, rounds), "leader", i % clients);
      return;
    }
    if (process.env.EDGE_ONLY === "terr-then-leader") {
      // A forked territorial stream, then leader contention on another: does the first leave a node unable to apply the second?
      await contention(w, nodes, Math.max(4, rounds), "territorial", 6, true);
      if (process.env.EDGE_QUIET !== "0") console.log(`  network quiet after ${Math.round((await quiet(nodes)) / 1000)} s`);
      await contention(w, nodes, Math.max(4, rounds), "leader", 7);
      return;
    }
    await territorial(w, nodes, rounds);
    await territorialShapes(w, nodes);
    await commitConflict(w, nodes, rounds);
    await contention(w, nodes, Math.max(4, rounds), "normal", 3);
    // Reported, not failed: concurrent writers to one stream through different nodes fork it in territorial mode (see the docs)
    await contention(w, nodes, Math.max(4, rounds), "territorial", 6, true);
    // The forked territorial stream keeps the nodes repairing it for a minute or more; leader work starts once they are quiet
    console.log(`  network quiet after ${Math.round((await quiet(nodes)) / 1000)} s`);
    // Leader transactions are all routed to the node that owns the stream, so they cannot race each other
    await contention(w, nodes, Math.max(4, rounds), "leader", 7);
    // Soak: the same leader contention again on other streams, to catch a node that stops applying (seen once in about 12 runs)
    for (const c of [0, 1, 2, 4, 5]) await contention(w, nodes, Math.max(4, rounds), "leader", c);
    // Leader and normal writers on one stream together: documented as unsafe, so reported rather than failed
    await contention(w, nodes, Math.max(4, rounds), "mixed", 5, true);
    await leaderRouting(w, nodes);
    await failedCommit(w, nodes);
    await unanimousLeader(w, nodes);
  });
  console.log(failures ? `FAILED (${failures})` : "PASSED");
  return failures ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
