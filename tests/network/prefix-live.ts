/**
 * Live check that stream ids can carry a virtual prefix (anything in front of the 64 character id, like
 * "AL<id>") on a real 4-node network. Whatever comes before the last 64 characters is stripped, so the
 * transaction works on the real stream, the contract sees the bare id and the ledger never stores the prefix.
 * A prefix must also never let a signature stand in for another identity.
 *
 *   npx tsx tests/network/prefix-live.ts
 */

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
  await withNetwork({ nodeCount: 4, basePort: 5810, readyTimeoutMs: 60000 }, async (_h, nodes) => {
    const base = nodes[0].baseUrl;
    const admin = await onboard(base);
    await registerNamespace(base, admin, "pfx");
    const contractId = await deployContract(base, admin, "pfx", "counter", `${__dirname}/contracts/counter-contract.ts`);
    const user = await onboard(nodes[1].baseUrl);
    const other = await onboard(nodes[2].baseUrl);
    const send = async (node: number, body: any) => (await requestJson(nodes[node].baseUrl, "POST", body)) as any;
    const count = async (id: string, node = 0): Promise<number> => ((await storageGet(nodes[node].storageUrl, id)) as any).count || 0;

    const tx = (inputId: string, outputId: string, message: string) => ({
      $namespace: "pfx",
      $contract: contractId,
      $i: { [inputId]: {} },
      $o: { [outputId]: { message } },
    });

    let expected = 0;
    const applied = async (what: string, node: number, inputId: string, outputId: string, sigKey: string, message: string, ok = true) => {
      const body = tx(inputId, outputId, message);
      const r = await send(node, { $tx: body, $sigs: { [sigKey]: user.keyPair.sign(body) } });
      await sleep(1500);
      if (ok) expected++;
      const c: number[] = [];
      for (let n = 0; n < 4; n++) c.push(await count(user.streamId, n));
      const done = r.$summary?.commit === 1;
      check(ok ? done && c.every((x) => x === expected) : !done && c.every((x) => x === expected), `${what} (${JSON.stringify(r.$summary?.errors ?? [])}, counts ${c})`);
    };

    const id = user.streamId;
    await applied("no prefix, the baseline", 0, id, id, id, "bare");
    await applied("a two character prefix on the input, output and signature", 0, "AL" + id, "AL" + id, "AL" + id, "al");
    // As the code stands today a prefixed input needs its signature sent under the same spelling (a bare input accepts
    // a prefixed signature key, the other way round is refused). Pinned so a change to it is noticed
    await applied("a prefixed input with a signature under a different spelling is refused", 1, "AL" + id, "AL" + id, id, "sig-bare", false);
    await applied("a bare input with a prefixed output and signature", 2, id, "AL" + id, "AL" + id, "mixed");
    await applied("a long prefix", 3, "x".repeat(40) + id, "x".repeat(40) + id, "x".repeat(40) + id, "long");
    await applied("different prefixes on the input and output, signature spelled as the input", 0, "AL" + id, "ZZ" + id, "AL" + id, "different");
    await applied("a signature under another prefix than the input is refused", 1, "AL" + id, "AL" + id, "QQ" + id, "other-prefix", false);

    // The prefix does not change who signed
    const body = tx("AL" + id, "AL" + id, "stolen");
    const forged = await send(0, { $tx: body, $sigs: { ["AL" + id]: other.keyPair.sign(body) } });
    await sleep(1200);
    check(forged.$summary?.commit === 0 && (await count(id)) === expected, "a prefixed id signed by another identity is refused");
    const body2 = tx("AL" + other.streamId, "AL" + other.streamId, "stolen");
    const wrongOwner = await send(0, { $tx: body2, $sigs: { ["AL" + other.streamId]: user.keyPair.sign(body2) } });
    await sleep(1200);
    check(wrongOwner.$summary?.commit === 0 && (await count(other.streamId)) === 0, "a prefixed id of another identity signed by this one is refused");
  });
  console.log(failures ? `${failures} FAILED` : "all ok");
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
