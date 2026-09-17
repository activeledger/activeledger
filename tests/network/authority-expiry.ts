/**
 * Live check that an expiring authority really stops working - and that
 * every node agrees about when.
 *
 * The unit tests pin the predicate and the two guards. This pins the one
 * thing only a real network can show: that four nodes, each evaluating
 * expiry independently against their own copy of the stream, reach the
 * SAME verdict. If expiry were ever evaluated against a node's own clock
 * instead of the transaction's $datetime, this is where it would surface
 * - as a split vote rather than a clean rejection.
 *
 * Run via `npm run test:network:expiry`.
 */

import * as path from "path";
import { NetworkHarness } from "./harness";
import { storageGet, submit } from "./http";
import { Report } from "./report";
import { ActiveCrypto } from "../../packages/crypto/src";
import {
  Identity,
  onboard,
  registerNamespace,
  deployContract,
} from "./actions";

const NAMESPACE = "expirytest";
const CONTRACT_NAME = "authoritymanager";
const EXPIRY_BUILD = 40100;

/** Calls the authority contract with a payload on the caller's own stream. */
function manageAuthority(
  baseUrl: string,
  identity: Identity,
  namespace: string,
  contractId: string,
  payload: Record<string, unknown>
): Promise<any> {
  const txBody = {
    $namespace: namespace,
    $contract: contractId,
    $i: { [identity.streamId]: payload },
  };
  return submit(baseUrl, {
    $tx: txBody,
    $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
  });
}

/** Signs an ordinary transaction with a given key pair. */
function signWith(
  baseUrl: string,
  streamId: string,
  keyPair: ActiveCrypto.KeyPair,
  namespace: string,
  contractId: string
): Promise<any> {
  const txBody = {
    $namespace: namespace,
    $contract: contractId,
    $i: { [streamId]: { probe: true } },
  };
  return submit(baseUrl, {
    $tx: txBody,
    $sigs: { [streamId]: keyPair.sign(txBody) },
  });
}

const errorsOf = (r: any): string =>
  JSON.stringify(r?.$summary?.errors || r?.summary?.errors || []);

async function main(): Promise<boolean> {
  const report = new Report();
  // build is what gates expiry. Set it on every node before any of them
  // start: half-enabled is a rollout bug, and this test must measure the
  // feature rather than that.
  const harness = new NetworkHarness({ nodeCount: 4, config: { build: EXPIRY_BUILD } });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    ok ? report.ok(message) : report.fail(message);
    passed = ok && passed;
  };

  report.phase(`Booting 4-node network at build ${EXPIRY_BUILD}`);
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready: ${nodes.map((n) => n.port).join(", ")}`);

  try {
    const origin = nodes[0];

    report.phase("Onboarding identity, namespace and the authority contract");
    const identity: Identity = await onboard(origin.baseUrl);
    await registerNamespace(origin.baseUrl, identity, NAMESPACE);
    const contractId = await deployContract(
      origin.baseUrl,
      identity,
      NAMESPACE,
      CONTRACT_NAME,
      path.join(__dirname, "contracts", "authority-contract.ts")
    );
    report.ok(`contract ${contractId.substring(0, 16)}...`);

    // A second key that lapses shortly. Short enough to wait for, long
    // enough to use first.
    const tempKeys = new ActiveCrypto.KeyPair("rsa");
    const tempPub = tempKeys.generate().pub.pkcs8pem;
    const expiresAt = new Date(Date.now() + 20000).toISOString();

    report.phase("Adding an expiring authority");
    const added = await manageAuthority(origin.baseUrl, identity, NAMESPACE, contractId, {
      authority: { public: tempPub, type: "rsa", stake: 100, expire: expiresAt },
    });
    check(!added.$summary?.errors, `expiring key added (expires ${expiresAt})`);

    report.phase("Every node records the same expiry");
    const metas = await Promise.all(
      nodes.map((n) => storageGet(n.storageUrl, `${identity.streamId}:stream`).catch(() => null))
    );
    check(metas.every((m) => m), "all nodes hold the identity meta");
    const expiries = metas.map(
      (m) => (m?.authorities || []).find((a: any) => a.expire)?.expire
    );
    check(
      expiries.every((e) => e === expiresAt),
      `all nodes record expire ${expiresAt} (${JSON.stringify(expiries)})`
    );
    check(
      metas.every((m) => (m?.authorities || []).some((a: any) => a.expire === undefined)),
      "all nodes still hold a permanent key alongside it"
    );

    report.phase("The expiring key works while it is live");
    const whileLive = await signWith(origin.baseUrl, identity.streamId, tempKeys, NAMESPACE, contractId);
    check(!whileLive.$summary?.errors, `signed with the temporary key ${errorsOf(whileLive)}`);

    report.phase("Waiting for it to lapse");
    while (Date.now() <= new Date(expiresAt).getTime() + 1000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    report.ok("expiry passed");

    report.phase("Every node now rejects it");
    for (const node of nodes) {
      const rejected = await signWith(node.baseUrl, identity.streamId, tempKeys, NAMESPACE, contractId);
      const errors = JSON.stringify(rejected);
      check(
        !!rejected.$summary?.errors,
        `node ${node.port} rejected the lapsed key`
      );
      check(
        errors.includes("Expired") || errors.includes("1235"),
        `node ${node.port} said Expired, not just Incorrect`
      );
    }

    report.phase("The permanent key still works");
    const stillFine = await signWith(origin.baseUrl, identity.streamId, identity.keyPair, NAMESPACE, contractId);
    check(!stillFine.$summary?.errors, `permanent key still signs ${errorsOf(stillFine)}`);

    // At this point the temporary key has lapsed, so the onboarded key is
    // the only one that could still sign. Putting an expire on it would
    // leave the stream with nothing permanent - the exact thing the guard
    // exists to refuse.
    report.phase("The last permanent key cannot be expired");
    const refused = await manageAuthority(origin.baseUrl, identity, NAMESPACE, contractId, {
      authority: {
        public: identity.publicKey,
        type: "rsa",
        stake: 100,
        expire: new Date(Date.now() + 600000).toISOString(),
      },
    });
    check(!!refused.$summary?.errors, `expiring the last permanent key was refused ${errorsOf(refused)}`);

    // And it must have changed nothing.
    const afterRefusal = await Promise.all(
      nodes.map((n) => storageGet(n.storageUrl, `${identity.streamId}:stream`).catch(() => null))
    );
    check(
      afterRefusal.every((m) =>
        (m?.authorities || []).some((a: any) => a.public === identity.publicKey && a.expire === undefined)
      ),
      "the permanent key is still permanent on every node"
    );

    report.phase("Promotion restores the lapsed key");
    const promoted = await manageAuthority(origin.baseUrl, identity, NAMESPACE, contractId, {
      authority: { public: tempPub, type: "rsa", stake: 100 },
    });
    check(!promoted.$summary?.errors, `expire removed ${errorsOf(promoted)}`);

    const afterPromotion = await signWith(origin.baseUrl, identity.streamId, tempKeys, NAMESPACE, contractId);
    check(
      !afterPromotion.$summary?.errors,
      `promoted key signs again ${errorsOf(afterPromotion)}`
    );
  } finally {
    await harness.stop();
    harness.cleanup();
  }

  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nAUTHORITY EXPIRY CHECK PASSED\n" : "\nAUTHORITY EXPIRY CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
