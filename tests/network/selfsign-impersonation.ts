/**
 * Live proof that `$selfsign` cannot be used to impersonate the identity a
 * transaction names in `$i.<label>.$stream`.
 *
 * `$selfsign` exists for the case where there is no on-ledger identity to
 * check a signature against - onboarding. Its branch in `process.ts`
 * therefore verifies each `$i` entry against `$i[label].publicKey`, a key the
 * transaction carries about ITSELF, which anyone satisfies with a keypair
 * generated a second ago. What stops that being an impersonation is that the
 * same branch never resolves `$i` to a stream: it runs the contract with a
 * hard-coded empty input list, so the named stream is never fetched, never
 * authority-checked and never handed over.
 *
 * `tests/selfsign-input-impersonation.test.ts` pins that control flow in
 * isolation. This file is the other half: a real 4-node network, a real
 * attacker holding nothing but a throwaway keypair, a real transaction over
 * HTTP, and the victim's stream read back off every node afterwards. A unit
 * test proves the branch does what the source says; only this proves the
 * network as a whole does.
 *
 * The attacker here is deliberately given every advantage short of a private
 * key: the victim's stream id, the namespace, the contract, the current
 * revision, and a contract that was written to accept self-signed
 * transactions and to write to whatever its input names.
 *
 * Run via `npm run test:network:selfsign`.
 */

import * as path from "path";
import { NetworkHarness } from "./harness";
import { storageGet, submit } from "./http";
import { Report } from "./report";
import { ActiveCrypto } from "../../packages/crypto/src";
import { Identity, onboard, registerNamespace, deployContract } from "./actions";

const NAMESPACE = "ssimpersonation";

/** The victim's stream and meta, as every node currently holds them. */
async function readEverywhere(nodes: { storageUrl: string }[], streamId: string) {
  const [states, metas] = await Promise.all([
    Promise.all(nodes.map((n) => storageGet(n.storageUrl, streamId).catch(() => null))),
    Promise.all(nodes.map((n) => storageGet(n.storageUrl, `${streamId}:stream`).catch(() => null))),
  ]);
  return { states, metas };
}

/** Waits until every node holds the stream, so a "no change" check is not just a slow read. */
async function waitForConvergence(
  nodes: { storageUrl: string }[],
  streamId: string,
  timeoutMs = 15000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await readEverywhere(nodes, streamId);
    if (snapshot.states.every((s) => s?._rev) || Date.now() > deadline) return snapshot;
    await new Promise((r) => setTimeout(r, 500));
  }
}

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

    report.phase("A victim identity, with a contract it controls");
    const victim: Identity = await onboard(origin.baseUrl, "rsa");
    check(!!victim.streamId, `victim onboarded as ${victim.streamId.substring(0, 12)}...`);

    await registerNamespace(origin.baseUrl, victim, NAMESPACE);
    const contractId = await deployContract(
      origin.baseUrl,
      victim,
      NAMESPACE,
      "inputtarget",
      path.join(__dirname, "contracts", "input-target-contract.ts")
    );
    check(!!contractId, "deployed a contract that writes to whatever its input names");

    // The positive control. Without it, every "nothing was written" assertion
    // below would also pass against a contract that simply never works.
    report.phase("The victim can write to its own stream (positive control)");
    const legitTxBody = {
      $namespace: NAMESPACE,
      $contract: contractId,
      $i: { [victim.streamId]: { marker: "written-by-owner" } },
    };
    const legit = await submit(origin.baseUrl, {
      $tx: legitTxBody,
      $sigs: { [victim.streamId]: victim.keyPair.sign(legitTxBody) },
    });
    check(!legit.$summary?.errors, `the owner's own transaction committed: ${JSON.stringify(legit.$summary?.errors ?? "no errors")}`);

    const before = await waitForConvergence(nodes, victim.streamId);
    check(
      before.states.every((s) => s?.marker === "written-by-owner"),
      "every node shows the owner's write, so the contract really does write through an input"
    );

    const beforeRevs = before.states.map((s) => s?._rev);
    const beforeAuthorities = JSON.stringify(before.metas.map((m) => m?.authorities));

    // Everything the attacker knows. All of it is public.
    report.phase("An attacker with nothing but a fresh keypair");
    const attackerKey = new ActiveCrypto.KeyPair("rsa");
    const attackerKeys = attackerKey.generate();
    report.info("attacker holds no stream, no onboarded identity and no authority anywhere");

    // Arm 1 - the reported shape. Self-signed, so the engine's only check is
    // the attacker's key against itself, with the victim's stream named
    // beside it.
    report.phase("Arm 1: $selfsign naming the victim in $i.<label>.$stream");
    const spoofTxBody = {
      $namespace: NAMESPACE,
      $contract: contractId,
      $i: {
        spoof: {
          $stream: victim.streamId,
          publicKey: attackerKeys.pub.pkcs8pem,
          type: "rsa",
          marker: "hijacked",
        },
      },
    };
    const spoof = await submit(origin.baseUrl, {
      $tx: spoofTxBody,
      $selfsign: true,
      $sigs: { spoof: attackerKey.sign(spoofTxBody) },
    });
    report.info(`ledger answered: ${JSON.stringify(spoof.$summary ?? {})}`);

    // Whether the ledger accepts or rejects it is not the assertion. A
    // self-signed transaction creating a stream of its own is ordinary and
    // harmless. What must be true either way is that the victim's stream did
    // not move.
    const afterSpoof = await readEverywhere(nodes, victim.streamId);
    check(
      JSON.stringify(afterSpoof.states.map((s) => s?._rev)) === JSON.stringify(beforeRevs),
      `the victim's revision is unchanged on every node (${JSON.stringify(afterSpoof.states.map((s) => s?._rev))})`
    );
    check(
      afterSpoof.states.every((s) => s?.marker === "written-by-owner"),
      "the victim's state still says written-by-owner, not hijacked"
    );
    check(
      JSON.stringify(afterSpoof.metas.map((m) => m?.authorities)) === beforeAuthorities,
      "the victim's authorities are untouched - no attacker key was added"
    );
    check(
      afterSpoof.metas.every(
        (m) => !m?.authorities?.some((a: any) => a.public === attackerKeys.pub.pkcs8pem)
      ),
      "the attacker's key is on none of the victim's authority lists"
    );

    // If it did commit, it committed somewhere else. Worth stating, because
    // "the transaction was accepted" is the part that looks alarming in a log
    // and the part that does not matter.
    const wroteTo = spoof.$responses?.[0]?.wroteTo;
    if (wroteTo) {
      check(
        wroteTo !== victim.streamId,
        `the contract wrote to ${String(wroteTo).substring(0, 12)}..., a stream of its own, not the victim`
      );
    }

    // Arm 2 - the same intent without $selfsign, labelled exactly as the
    // report described. This one must be refused outright: the ordinary path
    // resolves $i and checks it against the stream's authorities.
    report.phase("Arm 2: the same labelled input WITHOUT $selfsign");
    const labelledTxBody = {
      $namespace: NAMESPACE,
      $contract: contractId,
      $i: { spoof: { $stream: victim.streamId, marker: "hijacked" } },
    };
    const labelled = await submit(origin.baseUrl, {
      $tx: labelledTxBody,
      $sigs: { [victim.streamId]: attackerKey.sign(labelledTxBody) },
    });
    check(
      !!labelled.$summary?.errors,
      `rejected, as the ordinary input path must: ${JSON.stringify(labelled.$summary?.errors ?? "ACCEPTED")}`
    );

    // Arm 3 - unlabelled, naming the victim's stream as the key itself.
    report.phase("Arm 3: the victim's stream id as an unlabelled $i key");
    const unlabelledTxBody = {
      $namespace: NAMESPACE,
      $contract: contractId,
      $i: { [victim.streamId]: { marker: "hijacked" } },
    };
    const unlabelled = await submit(origin.baseUrl, {
      $tx: unlabelledTxBody,
      $sigs: { [victim.streamId]: attackerKey.sign(unlabelledTxBody) },
    });
    check(
      !!unlabelled.$summary?.errors,
      `rejected: ${JSON.stringify(unlabelled.$summary?.errors ?? "ACCEPTED")}`
    );

    report.phase("Final state of the victim's stream");
    const final = await readEverywhere(nodes, victim.streamId);
    check(
      JSON.stringify(final.states.map((s) => s?._rev)) === JSON.stringify(beforeRevs),
      "after all three attempts, still at the revision the owner left it at"
    );
    check(
      final.states.every((s) => s?.marker === "written-by-owner"),
      "after all three attempts, still holding only the owner's write"
    );

    // And the owner still controls it. A stream that became unwritable would
    // also satisfy every assertion above.
    report.phase("The owner still controls the stream afterwards");
    const stillMineBody = {
      $namespace: NAMESPACE,
      $contract: contractId,
      $i: { [victim.streamId]: { marker: "still-mine" } },
    };
    const stillMine = await submit(origin.baseUrl, {
      $tx: stillMineBody,
      $sigs: { [victim.streamId]: victim.keyPair.sign(stillMineBody) },
    });
    check(!stillMine.$summary?.errors, "the owner can still write to their own stream");

    const end = await waitForConvergence(nodes, victim.streamId);
    check(
      end.states.every((s) => s?.marker === "still-mine"),
      "every node shows the owner's second write"
    );
  } finally {
    await harness.stop();
    harness.cleanup();
  }

  return passed;
}

main()
  .then((ok) => {
    console.log(
      ok
        ? "\nSELFSIGN IMPERSONATION CHECK PASSED\n"
        : "\nSELFSIGN IMPERSONATION CHECK FAILED\n"
    );
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
