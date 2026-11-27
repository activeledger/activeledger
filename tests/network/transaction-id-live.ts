/**
 * Live check of the transaction id on a real 4-node network at the build level where the id is the hash of $tx:
 * one signed transaction with an $expire is applied once, however it is wrapped when it is sent again, through
 * any node. A transaction without an $expire is still a new transaction every time it is sent.
 *
 *   npx tsx tests/network/transaction-id-live.ts
 */

import { ActiveCrypto } from "../../packages/crypto/src";
import { deployContract, onboard, registerNamespace } from "./actions";
import { requestJson, storageGet } from "./http";
import { withNetwork } from "../stress/lib/workload";

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const config = { build: ActiveCrypto.TransactionId.BUILD };
  await withNetwork({ nodeCount: 4, basePort: 5790, readyTimeoutMs: 60000, config }, async (_h, nodes) => {
    const base = nodes[0].baseUrl;
    const admin = await onboard(base);
    await registerNamespace(base, admin, "cnt");
    const contractId = await deployContract(base, admin, "cnt", "counter", `${__dirname}/contracts/counter-contract.ts`);
    const user = await onboard(nodes[1].baseUrl);
    const count = async (node = 0): Promise<number> => ((await storageGet(nodes[node].storageUrl, user.streamId)) as any).count || 0;
    const send = async (node: number, body: any) => (await requestJson(nodes[node].baseUrl, "POST", body)) as any;
    const refused = (r: any) => /^Transaction Exists/.test(String(r?.$summary?.errors?.[0]));

    const tx = (message: string, expire?: string) => ({
      $namespace: "cnt",
      $contract: contractId,
      $i: { [user.streamId]: {} },
      $o: { [user.streamId]: { message } },
      ...(expire ? { $expire: expire } : {}),
    });

    const expire = new Date(Date.now() + 3600_000).toISOString();
    const body = tx("once", expire);
    const sigs = { [user.streamId]: user.keyPair.sign(body) };
    const first = await send(0, { $tx: body, $sigs: sigs });
    await sleep(1500);
    check(first.$summary?.commit === 1 && (await count()) === 1, "a signed transaction with an $expire is applied once");

    const copies: [string, number, any][] = [
      ["the same bytes", 0, { $tx: body, $sigs: sigs }],
      ["the keys in another order", 0, { $sigs: sigs, $tx: body }],
      ["an extra field", 2, { $tx: body, $sigs: sigs, note: "x" }],
      ["fields only a node sets", 3, { $tx: body, $sigs: sigs, $umid: "f".repeat(64), $spiRetry: true, $replaces: "e".repeat(64) }],
      ["another form of the signature", 1, { $tx: body, $sigs: { ...sigs, other: "x" } }],
    ];
    for (const [what, node, copy] of copies) {
      const r = await send(node, copy);
      await sleep(1200);
      check(refused(r) && (await count(node)) === 1, `${what}, through node ${node}, is refused as already done`);
    }

    // A copy with the right $tx and wrong signatures, sent first, does not stand in the way of the right one
    const body2 = tx("second", new Date(Date.now() + 3600_000).toISOString());
    const sigs2 = { [user.streamId]: user.keyPair.sign(body2) };
    const wrong = await send(0, { $tx: body2, $sigs: { [user.streamId]: "00" + sigs2[user.streamId].slice(2) } });
    check(wrong.$summary?.commit === 0, "a copy with wrong signatures is not applied");
    const right = await send(0, { $tx: body2, $sigs: sigs2 });
    await sleep(1500);
    check(right.$summary?.commit === 1 && (await count()) === 2, `the right one, sent after it, is applied once (${JSON.stringify(right.$summary?.errors ?? [])})`);
    const again = await send(2, { $tx: body2, $sigs: sigs2 });
    await sleep(1200);
    check(refused(again) && (await count(2)) === 2, "and a repeat of it through another node is refused as already done");

    // The same at once: the wrong copy and the right one sent together to one node. (Sent together to two
    // different nodes the copies meet on the nodes in between and the right one has to be sent again once the
    // first has cleared; that case is not asserted here.)
    for (const [n, label] of [[0, "one node"]] as [number, string][]) {
      const body3 = tx(`together-${n}`, new Date(Date.now() + 3600_000).toISOString());
      const good3 = { [user.streamId]: user.keyPair.sign(body3) };
      const bad3 = { [user.streamId]: "00" + good3[user.streamId].slice(2) };
      const before = await count();
      const results = await Promise.all([send(0, { $tx: body3, $sigs: bad3 }), send(n, { $tx: body3, $sigs: good3 })]);
      await sleep(1500);
      let after = await count();
      if (after === before) {
        // The right one was told how the wrong one went; its retry goes through at once
        const retry = await send(n, { $tx: body3, $sigs: good3 });
        await sleep(1500);
        after = await count();
        check(retry.$summary?.commit === 1 && after === before + 1, `sent together through ${label}: the right one went through on its retry (${JSON.stringify(retry.$summary?.errors ?? [])})`);
      } else {
        check(after === before + 1 && results[0].$summary?.commit === 0, `sent together through ${label}: the right one was applied once, the wrong one not`);
      }
    }

    // Without an $expire each send is a new transaction (the time is part of its id)
    const open = tx("open");
    const openSigs = { [user.streamId]: user.keyPair.sign(open) };
    await send(0, { $tx: open, $sigs: openSigs });
    await send(1, { $tx: open, $sigs: openSigs });
    await sleep(1500);
    check((await count()) === 5, "without an $expire it is still a new transaction each time it is sent");
  });
  console.log(failures ? `${failures} FAILED` : "all ok");
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
