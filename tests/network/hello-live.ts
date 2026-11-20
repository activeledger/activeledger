import { ActiveCrypto } from "@activeledger/activecrypto";
import { NetworkHarness } from "./harness";
import * as http from "http";

const ok = (m: string) => console.log("  ✔ " + m);
let failed = false;
const check = (cond: boolean, m: string) => {
  if (cond) ok(m);
  else {
    failed = true;
    console.log("  ✘ " + m);
  }
};
const get = (url: string, headers: { [name: string]: string } = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The signed hello between real nodes: neighbours pair through it, a direct
 * ask gets an answer signed by that node's key, and a node that behaves like
 * one from before the hello (it neither asks nor answers) still pairs.
 */
(async () => {
  const harness = new NetworkHarness({ nodeCount: 4, basePort: 7950, readyTimeoutMs: 40000 } as any);
  try {
    const nodes: any[] = await harness.start();
    const status = (i: number) => get(`${(harness as any).nodes[i].baseUrl}/a/status`);

    console.log("== Neighbours pair through the hello ==");
    const s0: any = await status(0);
    const others = Object.entries<any>(s0.neighbourhood.neighbours).filter(([ref]) => ref !== s0.reference);
    check(others.length === 3 && others.every(([, n]) => n.isHome), "node 1 has its three neighbours home");
    check(
      others.every(([, n]) => n.peer && typeof n.peer.build === "number" && n.peer.version),
      "each carries the version and build it reported in its hello"
    );

    console.log("== A direct ask is answered, signed by the node's key ==");
    const s1: any = await status(1);
    const nonce = "abcdef0123456789";
    const reply: any = await get(`${(harness as any).nodes[1].baseUrl}/a/hello`, {
      "X-Activeledger": s0.reference,
      "X-Activeledger-Nonce": nonce,
    });
    check(reply?.hello?.nonce === nonce, "the nonce comes back");
    check(reply?.hello?.reference === s1.reference && reply?.hello?.knows === true && reply?.hello?.ready === true, "it names itself, knows the asker and is ready");
    const key = new ActiveCrypto.KeyPair("rsa", Buffer.from(s1.pem, "base64").toString());
    check(key.verify(JSON.stringify(reply.hello), reply.signature) === true, "the signature verifies against the node's public key");
    check(key.verify(JSON.stringify({ ...reply.hello, knows: false }), reply.signature) === false, "and not against an altered answer");
    const stranger: any = await get(`${(harness as any).nodes[1].baseUrl}/a/hello`, {
      "X-Activeledger": "not-a-neighbour",
      "X-Activeledger-Nonce": "n",
    });
    check(stranger?.hello?.knows === false && stranger.hello.version === undefined, "a stranger is told it is not known, and nothing else");

    console.log("== A node from before the hello still pairs ==");
    await harness.killNode(3);
    process.env.AL_NO_HELLO = "1";
    try {
      await harness.restartNode(3);
    } finally {
      delete process.env.AL_NO_HELLO;
    }
    // Node 1 asks everyone afresh when it starts
    await harness.killNode(0);
    await harness.restartNode(0);
    await sleep(6000);
    const after: any = await status(0);
    const entries = Object.entries<any>(after.neighbourhood.neighbours).filter(([ref]) => ref !== after.reference);
    check(entries.length === 3 && entries.every(([, n]) => n.isHome), "node 1 sees all three neighbours home again");
    check(entries.filter(([, n]) => !n.peer).length === 1, "exactly one has no hello on record: the one that does not answer it");
    const s3: any = await status(3);
    const seen3 = Object.entries<any>(s3.neighbourhood.neighbours).filter(([ref]) => ref !== s3.reference);
    check(seen3.length === 3 && seen3.every(([, n]) => n.isHome), "and that node has all three home too");
  } finally {
    await harness.stop();
  }
  console.log(failed ? "FAILED" : "PASSED");
  process.exit(failed ? 1 : 0);
})();
