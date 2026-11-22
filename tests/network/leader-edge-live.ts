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
    const says = !!(r && r.$umid && r.$streams && r.$streams.updated && r.$streams.updated.length);
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
    await territorial(w, nodes, rounds);
    await territorialShapes(w, nodes);
    await commitConflict(w, nodes, rounds);
  });
  console.log(failures ? `FAILED (${failures})` : "PASSED");
  return failures ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
