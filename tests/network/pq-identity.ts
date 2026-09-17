/**
 * Live proof that a post-quantum identity works end to end.
 *
 * Post-quantum identities shipped in 4.7.0 and, until this file, nothing in
 * the repository exercised one against a real network. `actions.ts` onboarded
 * only "rsa", so the whole PQ path - key generation, the `type` string
 * reaching `meta.authorities[].type`, signature verification in
 * permissionsChecker, a contract executing under a PQ-signed transaction -
 * was covered by unit tests and a note in a commit message saying it had been
 * checked by hand.
 *
 * Every assertion here is about the shapes a port gets wrong first:
 * the exact key byte lengths, the `type` string surviving into the stream,
 * and $selfsign onboarding being keyed by the $i LABEL rather than a stream
 * id. A port failing any of these sees 1220 "Signature Incorrect", which says
 * nothing about which of them it was.
 *
 * Run via `npm run test:network:pq`.
 */

import * as path from "path";
import { NetworkHarness } from "./harness";
import { storageGet, submit } from "./http";
import { Report } from "./report";
import { Identity, onboard, registerNamespace, deployContract, runContract } from "./actions";

const PQ_TYPES = ["ml-dsa-65", "falcon-512"];

// Byte lengths of the raw key material, before base64. A wrong length here is
// the single most likely first bug in a port, and catching it at onboarding
// rather than at signature verification is the difference between a useful
// error and "Signature Incorrect".
const EXPECTED_KEY_BYTES: Record<string, { pub: number }> = {
  "ml-dsa-65": { pub: 1952 },
  "falcon-512": { pub: 897 },
};

const rawBytes = (b64: string) => Buffer.from(b64, "base64").length;

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 4, config: { build: 40100 } });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = ok && passed;
  };

  report.phase("Booting 4-node network");
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready: ${nodes.map((n) => n.port).join(", ")}`);

  try {
    const origin = nodes[0];

    for (const type of PQ_TYPES) {
      report.phase(`${type}: onboarding an identity`);
      const identity: Identity = await onboard(origin.baseUrl, type);
      check(!!identity.streamId, `${type}: onboarded as ${identity.streamId.substring(0, 12)}...`);

      // Wait for the meta to converge - consensus is a majority, so the
      // origin's response means three of four nodes have committed.
      const deadline = Date.now() + 15000;
      let metas: any[] = [];
      for (;;) {
        metas = await Promise.all(
          nodes.map((n) => storageGet(n.storageUrl, `${identity.streamId}:stream`).catch(() => null))
        );
        if (metas.every((m) => m?.authorities?.length) || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      check(metas.every((m) => m?.authorities?.length), `${type}: every node holds the identity meta`);

      const types = metas.map((m) => m?.authorities?.[0]?.type);
      check(
        types.every((t) => t === type),
        `${type}: every node recorded authority type "${type}" (${JSON.stringify(types)})`
      );

      const lengths = metas.map((m) => rawBytes(m?.authorities?.[0]?.public || ""));
      const want = EXPECTED_KEY_BYTES[type].pub;
      check(
        lengths.every((l) => l === want),
        `${type}: public key is ${want} raw bytes on every node (${JSON.stringify(lengths)})`
      );

      report.phase(`${type}: namespace, contract and a transaction`);
      const namespace = `pq${type.replace(/-/g, "")}`;
      await registerNamespace(origin.baseUrl, identity, namespace);

      const contractId = await deployContract(
        origin.baseUrl,
        identity,
        namespace,
        "pqreturner",
        path.join(__dirname, "contracts", "returner-contract.ts")
      );
      check(!!contractId, `${type}: deployed a contract signed with a ${type} key`);

      const ran = await runContract(origin.baseUrl, identity, namespace, contractId, {
        message: `hello-from-${type}`,
      });
      check(!ran.$summary?.errors, `${type}: contract executed under a ${type} signature`);
      check(
        ran.$responses?.[0]?.echoedMessage === `hello-from-${type}`,
        `${type}: contract returned the value it was given`
      );

      // A tampered payload must be rejected. Without this the test would pass
      // against an implementation that accepted everything.
      report.phase(`${type}: a tampered payload is rejected`);
      const txBody = {
        $namespace: namespace,
        $contract: contractId,
        $i: { [identity.streamId]: {} },
        $o: { [identity.streamId]: { message: "original" } },
      };
      const goodSig = identity.keyPair.sign(txBody);
      const tampered = JSON.parse(JSON.stringify(txBody));
      tampered.$o[identity.streamId].message = "tampered";
      const rejected = await submit(origin.baseUrl, {
        $tx: tampered,
        $sigs: { [identity.streamId]: goodSig },
      });
      check(!!rejected.$summary?.errors, `${type}: a tampered payload was rejected`);
    }
  } finally {
    await harness.stop();
    harness.cleanup();
  }

  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nPOST-QUANTUM IDENTITY CHECK PASSED\n" : "\nPOST-QUANTUM IDENTITY CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
