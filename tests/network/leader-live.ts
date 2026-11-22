/**
 * Live check of leader voting ({ leader: true } from vote()) on a real 4-node
 * network: every client writes its own stream several times, then every node's
 * own copy of every stream is compared. A leader commit must not leave a node
 * behind or on a different revision, and a later transaction on the same
 * stream must still commit.
 *
 *   npx tsx tests/network/leader-live.ts [contract] [rounds] [clients]
 *
 * contract defaults to returner-leader, rounds to 5, clients to 8; a fourth
 * argument `leader` sends the transactions with $tx.$leader (the origin holds
 * the broadcast until its own vote is yes).
 */

import { hotTransaction, setupWorkload, timedSubmit, withNetwork, sleep } from "../stress/lib/workload";
import { storageGet, storagePut } from "./http";

async function main(): Promise<number> {
  const contract = process.argv[2] || "returner-leader";
  const rounds = Number(process.argv[3] || 5);
  const clients = Number(process.argv[4] || 8);
  const leader = process.argv[5] === "leader";
  let failures = 0;
  const fail = (m: string) => {
    failures++;
    console.log(`FAIL ${m}`);
  };

  await withNetwork({ nodeCount: 4, basePort: 5710, readyTimeoutMs: 60000 }, async (_h, nodes) => {
    const w = await setupWorkload(nodes, contract, clients);
    let uncommitted = 0;
    for (let r = 0; r < rounds; r++) {
      const results = await Promise.all(
        Array.from({ length: clients }, (_, c) => timedSubmit(nodes[c % nodes.length].baseUrl, hotTransaction(w, c, `r${r}c${c}`, leader)))
      );
      for (const x of results) if (!x.committed) { uncommitted++; console.log(`round ${r}: not committed: ${x.reason}`); }
    }
    console.log(`${rounds * clients} transactions sent, ${uncommitted} not committed`);
    if (uncommitted) fail(`${uncommitted} transactions did not commit`);

    // Let every node settle, then compare their own copies
    const want = `r${rounds - 1}`;
    const deadline = Date.now() + 20000;
    let docs: any[][] = [];
    for (;;) {
      docs = await Promise.all(w.identities.map((id) => Promise.all(nodes.map((n) => storageGet(n.storageUrl, id.streamId).catch(() => null)))));
      const settled = docs.every((perNode, c) => perNode.every((d) => d && d.message === `${want}c${c}`));
      if (settled || Date.now() > deadline) break;
      await sleep(500);
    }
    let behind = 0, revDiffer = 0;
    docs.forEach((perNode, c) => {
      const msgs = perNode.map((d) => d && d.message);
      const revs = perNode.map((d) => d && d._rev);
      if (msgs.some((m) => m !== `${want}c${c}`)) { behind++; console.log(`stream ${c}: messages ${JSON.stringify(msgs)}`); }
      else if (new Set(revs).size > 1) { revDiffer++; console.log(`stream ${c}: revisions ${JSON.stringify(revs)}`); }
    });
    if (behind) fail(`${behind} streams had a node behind or different`);
    if (revDiffer) fail(`${revDiffer} streams had differing revisions across nodes`);
    if (!behind && !revDiffer) console.log("every node holds every stream at the same revision");

    // One node falls behind its peers on a stream (a stale copy), then the
    // stream is written again: does that node get back to the same revision?
    {
      const behindNode = nodes[0];
      const cur = await storageGet(behindNode.storageUrl, w.identities[0].streamId);
      await storagePut(behindNode.storageUrl, w.identities[0].streamId, { ...cur, desyncMarker: `d${Date.now()}` });
      const t = await timedSubmit(nodes[1].baseUrl, hotTransaction(w, 0, "after-desync", leader));
      console.log(`write while node ${behindNode.port} is desynced: ${t.committed ? "committed" : "not committed: " + t.reason}`);
      let healed = false;
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const copies = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, w.identities[0].streamId).catch(() => null)));
        if (copies.every((d) => d && d.message === "after-desync" && d._rev === copies[0]._rev && !d.desyncMarker)) { healed = true; break; }
        await sleep(500);
      }
      console.log(healed ? "the desynced node caught up" : "the desynced node did NOT catch up in 20 s");
      if (!healed) fail("desynced node did not catch up");
    }

    // A no from the origin is the answer, straight away, and nothing was
    // broadcast: no other node ever saw the transaction
    if (leader && contract === "returner-leader") {
      const before = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, w.identities[1].streamId)));
      const began = Date.now();
      const refused = await timedSubmit(nodes[0].baseUrl, hotTransaction(w, 1, "", true));
      const took = Date.now() - began;
      console.log(`a transaction the contract refuses: ${refused.committed ? "COMMITTED" : "failed"} in ${took} ms (${refused.reason})`);
      if (refused.committed) fail("a refused leader transaction committed");
      if (took > 3000) fail(`the refusal took ${took} ms, it should be immediate`);
      await sleep(1500);
      const after = await Promise.all(nodes.map((n) => storageGet(n.storageUrl, w.identities[1].streamId)));
      if (JSON.stringify(before.map((d) => d._rev)) !== JSON.stringify(after.map((d) => d._rev))) fail("a refused transaction changed a stream");
    }

    // A later transaction on the same streams must still work
    const again = await Promise.all(w.identities.map((_, c) => timedSubmit(nodes[(c + 1) % nodes.length].baseUrl, hotTransaction(w, c, `after${c}`, leader))));
    const bad = again.filter((x) => !x.committed);
    if (bad.length) fail(`${bad.length}/${again.length} follow-up transactions failed: ${bad[0].reason}`);
    else console.log("follow-up transactions on every stream committed");
  });
  console.log(failures ? `FAILED (${failures})` : "PASSED");
  return failures ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
