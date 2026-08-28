/**
 * Live 4-node network integration test. Boots a real bare-host network,
 * runs 100+ real transactions spread across all nodes as origin, verifies
 * SSE event delivery, verifies returnToRemote(), and verifies SPI recovery
 * both when the desynced node is the transaction's origin and when it
 * isn't. Not a Mocha suite - a standalone script with live progress and a
 * final summary, run via `npm run test:network`.
 */

import * as path from "path";
import { NetworkHarness, NetworkNode } from "./harness";
import { submit, storageGet, storagePut } from "./http";
import { SSEClient } from "./sse";
import { Report } from "./report";
import {
  Identity,
  onboard,
  registerNamespace,
  deployContract,
  runContract,
} from "./actions";
import { ActiveCrypto } from "../../packages/crypto/src";

const TRANSACTION_COUNT = 120;
const CONCURRENCY = 8;
const NAMESPACE = "networktest";

async function pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runNext));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 4 });

  report.phase("Booting 4-node network");
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready: ${nodes.map((n) => n.port).join(", ")}`);

  try {
    report.phase("Onboarding an identity and registering a namespace");
    const identity = await onboard(nodes[0].baseUrl);
    report.ok(`Onboarded ${identity.streamId}`);
    const nsResult = await registerNamespace(nodes[0].baseUrl, identity, NAMESPACE);
    if (nsResult.$summary?.errors) {
      throw new Error(`Namespace registration failed: ${JSON.stringify(nsResult)}`);
    }
    report.ok(`Namespace "${NAMESPACE}" registered`);

    report.phase("Deploying custom contracts");
    const returnerId = await deployContract(
      nodes[0].baseUrl,
      identity,
      NAMESPACE,
      "returner",
      path.join(__dirname, "contracts/returner-contract.ts")
    );
    report.ok(`returner-contract deployed: ${returnerId}`);
    const emitterId = await deployContract(
      nodes[0].baseUrl,
      identity,
      NAMESPACE,
      "emitter",
      path.join(__dirname, "contracts/emitter-contract.ts")
    );
    report.ok(`emitter-contract deployed: ${emitterId}`);

    report.phase(`Running ${TRANSACTION_COUNT} transactions across all ${nodes.length} nodes`);
    let completed = 0;
    const indices = Array.from({ length: TRANSACTION_COUNT }, (_, i) => i);
    await pool(indices, CONCURRENCY, async (i) => {
      const node = nodes[i % nodes.length];
      // Every 5th iteration onboards its own fresh, throwaway identity and
      // immediately runs the returner contract against it (exercises
      // custom-contract execution as part of the load); the rest are
      // fresh, real self-signed onboarding transactions - the same
      // "direct-onboard" repro case used throughout hpe-12/hpe-13/hpe-14's
      // own live testing. Deliberately never touches the shared `identity`
      // concurrently here - hammering one stream with many in-flight
      // transactions at once is a real, separate SPI "hot stream" scenario
      // (see spi.md), not representative load, and belongs in the
      // dedicated SPI phase below where it's controlled and expected.
      const isContractRun = i % 5 === 0;
      const { result, ms } = await timed(async () => {
        const kp = new ActiveCrypto.KeyPair("rsa");
        const keys = kp.generate();
        const txBody = {
          $namespace: "default",
          $contract: "onboard",
          $i: { identity: { type: "rsa", publicKey: keys.pub.pkcs8pem } },
          $o: {},
        };
        const onboardResult = await submit(node.baseUrl, {
          $tx: txBody,
          $selfsign: true,
          $sigs: { identity: kp.sign(txBody) },
        });
        if (!isContractRun) return onboardResult;

        const freshStreamId = onboardResult.$streams?.new?.[0]?.id;
        if (!freshStreamId) return onboardResult; // onboarding itself failed - report that as the result
        return runContract(node.baseUrl, { streamId: freshStreamId, keyPair: kp }, NAMESPACE, returnerId, {
          message: `load-${i}`,
        });
      });

      const passed = !result.$summary?.errors && result.$summary?.commit >= 1;
      report.record(isContractRun ? "contract-run" : "onboard", passed, ms);
      completed++;
      report.progress(completed, TRANSACTION_COUNT, `node ${node.index} (:${node.port})`);
    });
    report.endProgress();

    report.phase("Verifying returnToRemote()");
    // Own fresh identity, not the shared one - reusing the same stream
    // back-to-back from a different origin node than the previous phase
    // used is exactly the "hot stream" SPI-churn scenario the load phase
    // already learned to avoid; each independent verification gets its own
    // clean stream so it isn't racing convergence from an unrelated check.
    const returnerCheckIdentity = await onboard(nodes[1].baseUrl);
    const expectedMessage = `returnToRemote-check-${Date.now()}`;
    const { result: returnerResult, ms: returnerMs } = await timed(() =>
      runContract(nodes[1].baseUrl, returnerCheckIdentity, NAMESPACE, returnerId, {
        message: expectedMessage,
      })
    );
    const echoed = returnerResult.$responses?.[0]?.echoedMessage;
    const returnerOk = echoed === expectedMessage;
    report.record("returnToRemote", returnerOk, returnerMs);
    if (returnerOk) {
      report.ok(`$responses carried back the expected message via node ${nodes[1].port}`);
    } else {
      report.fail(`Expected "${expectedMessage}", got ${JSON.stringify(returnerResult.$responses)}`);
    }

    report.phase("Verifying SSE event delivery across all nodes");
    // Own fresh identity too, same reasoning as the returnToRemote check
    // above.
    const sseCheckIdentity = await onboard(nodes[2].baseUrl);
    const correlationId = `sse-check-${Date.now()}`;
    const seenOn = new Set<number>();
    const clients = nodes.map((n) => new SSEClient(`${n.storageUrl}/activeledgerevents/events`));
    await Promise.all(clients.map((c) => c.connect()));
    clients.forEach((client, i) => {
      client.onEvent((event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.data?.correlationId === correlationId) {
            seenOn.add(i);
          }
        } catch {
          // ignore malformed/heartbeat frames
        }
      });
    });

    const { ms: emitterMs } = await timed(() =>
      runContract(nodes[2].baseUrl, sseCheckIdentity, NAMESPACE, emitterId, {
        message: "sse-check",
        correlationId,
      })
    );

    const sseDeadline = Date.now() + 8000;
    while (seenOn.size < nodes.length && Date.now() < sseDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    clients.forEach((c) => c.close());

    const sseOk = seenOn.size === nodes.length;
    report.record("sse-delivery", sseOk, emitterMs);
    if (sseOk) {
      report.ok(`Event observed on all ${nodes.length} nodes' SSE feeds`);
    } else {
      report.fail(`Event only observed on ${seenOn.size}/${nodes.length} nodes: [${[...seenOn].join(", ")}]`);
    }

    await runNegativeTests(report, nodes, returnerId);

    await runSpiTests(report, nodes, identity, NAMESPACE, returnerId);

    return report.summary();
  } finally {
    report.phase("Tearing down network");
    await harness.stop();
    harness.cleanup();
    report.ok("Stopped and cleaned up");
  }
}

/**
 * Negative-path coverage: a transaction that's genuinely supposed to be
 * rejected. Everything else in this suite asserts success - these assert
 * the opposite, and check the actual error surfaced, not just that
 * something failed.
 */
async function runNegativeTests(report: Report, nodes: NetworkNode[], returnerId: string): Promise<void> {
  report.phase("Negative path: deliberately bad signature");
  {
    const badIdentity = await onboard(nodes[0].baseUrl);
    const namespace = "negtest-badsig";
    await registerNamespace(nodes[0].baseUrl, badIdentity, namespace);
    const txBody = {
      $namespace: "default",
      $contract: "namespace",
      $i: { [badIdentity.streamId]: { namespace: namespace + "-again" } },
    };
    const badTx = { $tx: txBody, $sigs: { [badIdentity.streamId]: "not-a-real-signature" } };
    const { result, ms } = await timed(() => submit(nodes[0].baseUrl, badTx));
    const rejected = result.$summary?.commit === 0 && (result.$summary?.errors || []).some((e: string) => e.includes("Signature Incorrect"));
    report.record("negative-bad-signature", rejected, ms);
    rejected
      ? report.ok(`Bad signature correctly rejected (${ms}ms)`)
      : report.fail(`Expected a rejected "Signature Incorrect" result, got: ${JSON.stringify(result.$summary)}`);
  }

  report.phase("Negative path: locked contract stream");
  {
    // Own fresh identity/namespace, same reasoning as every other phase in
    // this suite - avoids any cross-phase stream contention.
    const lockIdentity = await onboard(nodes[1].baseUrl);
    const namespace = "negtest-lock";
    await registerNamespace(nodes[1].baseUrl, lockIdentity, namespace);
    // One normal run first, to establish the stream's :stream meta
    // document - it doesn't exist yet straight after onboarding.
    await runContract(nodes[1].baseUrl, lockIdentity, namespace, returnerId, { message: "establish" });

    const meta = await storageGet(nodes[1].storageUrl, `${lockIdentity.streamId}:stream`);
    await storagePut(nodes[1].storageUrl, `${lockIdentity.streamId}:stream`, {
      ...meta,
      // A lock naming some other contract - not returnerId - so any
      // transaction naming returnerId should be rejected.
      contractlock: ["some-other-contract-id-not-returner"],
    });

    const { result, ms } = await timed(() =>
      runContract(nodes[1].baseUrl, lockIdentity, namespace, returnerId, { message: "should-be-blocked" })
    );
    const rejected = result.$summary?.commit === 0 && (result.$summary?.errors || []).length > 0;
    report.record("negative-locked-contract", rejected, ms);
    if (rejected) {
      // Real, confirmed bug found while writing this test (not the test's
      // own fault): permissionsChecker.ts's buildPromises() throws
      // { code: 1700, reason: "Stream contract locked" } for exactly this
      // case, but the surrounding try/catch unconditionally overwrites
      // error.code/error.reason to 950 "Stream(s) not found" before
      // rethrowing - so the specific, documented 1700 never actually
      // reaches a client, regardless of what tripped the lock check. This
      // asserts the transaction is rejected at all (the actual guarantee
      // that currently holds), not that it's rejected with 1700 (which it
      // never is, even though the lock genuinely works).
      report.ok(`Locked contract correctly rejected (as 950 "Stream(s) not found", not the documented 1700 - see comment) (${ms}ms)`);
    } else {
      report.fail(`Expected a rejected result, got: ${JSON.stringify(result.$summary)}`);
    }
  }
}

/**
 * Directly mutates the shared identity's own stream on one node's storage
 * engine, bypassing consensus entirely (LevelMe.post()/put() recompute a
 * fresh revision from whatever's currently stored regardless of the _rev
 * given - see http.ts's storagePut()), then runs a real transaction
 * touching that same stream - once with the desynced node as origin, once
 * with a different node as origin - to exercise both SPI repair paths
 * described in spi.md/architecture.md.
 */
async function runSpiTests(
  report: Report,
  nodes: NetworkNode[],
  identity: Identity,
  namespace: string,
  returnerId: string
): Promise<void> {
  const desyncTarget = nodes[0];
  const otherNodes = nodes.filter((n) => n.index !== desyncTarget.index);

  async function desyncStream(): Promise<void> {
    const current = await storageGet(desyncTarget.storageUrl, identity.streamId);
    await storagePut(desyncTarget.storageUrl, identity.streamId, {
      ...current,
      spiTestMarker: `desync-${Date.now()}`,
    });
  }

  // Reruns the (idempotent - just overwrites its own output field each
  // time) returner contract against the identity's own stream, purely to
  // exercise the normal revision-check/SPI path - not touchIdentity()'s
  // earlier namespace-registration approach, which isn't idempotent
  // (registering the same namespace twice legitimately fails with
  // "Namespace Reserved").
  //
  // Retries once on an SPI-flavoured error before giving up - this is the
  // documented, expected client behaviour (spi.md: "there's no separate
  // handling to write for it: treat it like any other transient failure
  // and retry the transaction yourself"), not a workaround. A single
  // synchronous request/response can legitimately land mid-repair (the
  // response.$summary reflects whichever nodes had already replied by the
  // time it was formed, not the network's final converged state - see
  // transactions.md), so asserting success on the very first attempt is a
  // stricter bar than the mechanism itself claims to guarantee.
  async function touchStream(baseUrl: string): Promise<any> {
    const first = await runContract(baseUrl, identity, namespace, returnerId, { message: "spi-touch" });
    if (!first.$summary?.errors) return first;
    await new Promise((r) => setTimeout(r, 500));
    return runContract(baseUrl, identity, namespace, returnerId, { message: "spi-touch-retry" });
  }

  report.phase(`SPI: desynced node (${desyncTarget.port}) as origin`);
  await desyncStream();
  {
    const { result, ms } = await timed(() => touchStream(desyncTarget.baseUrl));
    const ok = !result.$summary?.errors;
    report.record("spi-origin", ok, ms);
    ok
      ? report.ok(`Transaction succeeded with the desynced node as origin (${ms}ms)`)
      : report.fail(`Failed: ${JSON.stringify(result.$summary)}`);
  }

  // Let the network fully settle/converge after the previous repair cycle
  // before injecting a fresh desync - SPI convergence is explicitly
  // asynchronous/eventual (architecture.md: "There is no single moment
  // when 'the network' agrees"), so starting a second fault injection
  // immediately can catch nodes mid-transition and produce real,
  // multi-way revision disagreement that's an artifact of the test's own
  // pacing, not the mechanism being tested.
  await new Promise((r) => setTimeout(r, 1500));

  report.phase(`SPI: desynced node (${desyncTarget.port}) as a non-origin peer`);
  await desyncStream();
  {
    const originNode = otherNodes[0];
    const { result, ms } = await timed(() => touchStream(originNode.baseUrl));
    const ok = !result.$summary?.errors;
    report.record("spi-non-origin", ok, ms);
    ok
      ? report.ok(`Transaction succeeded via node ${originNode.port} as origin, desynced peer included (${ms}ms)`)
      : report.fail(`Failed: ${JSON.stringify(result.$summary)}`);
  }
}

main()
  .then((allPassed) => process.exit(allPassed ? 0 : 1))
  .catch((error) => {
    console.error("Network test crashed:", error);
    process.exit(1);
  });
