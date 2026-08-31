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
import { submit, storageGet, storagePut, requestJsonWithStatus } from "./http";
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

    await runDeterministicStreamTests(report, nodes);

    await runStoragePathValidationTests(report, nodes);

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

    // Mutate the meta doc on every node, not just the origin - a real
    // contractlock, set via normal consensus, would be visible identically
    // everywhere. Mutating only one node (the technique the SPI tests
    // deliberately use, since asymmetry is the whole point there) instead
    // creates a mixed-consensus scenario here: 3 nodes still see the
    // unlocked doc and vote to allow it, so with consensus.reached's
    // default 60% threshold the network can commit anyway despite the
    // mutated node's own correct rejection - found via a real, reproduced
    // commit:1-alongside-the-error result before this fix.
    for (const node of nodes) {
      const meta = await storageGet(node.storageUrl, `${lockIdentity.streamId}:stream`);
      await storagePut(node.storageUrl, `${lockIdentity.streamId}:stream`, {
        ...meta,
        // A lock naming some other contract - not returnerId - so any
        // transaction naming returnerId should be rejected.
        contractlock: ["some-other-contract-id-not-returner"],
      });
    }

    // permissionsChecker.ts's buildPromises() used to mask this as a
    // generic 950 "Stream(s) not found" regardless of what actually
    // tripped - found while first writing this test, now fixed (protocol
    // package) so the real, specific "Stream contract locked" reason
    // actually reaches the client.
    //
    // One retry on a specific, separate, pre-existing transient: under
    // load, a transaction's contract-file resolution (setupLocation() in
    // process.ts - runs before permission checking even starts) can
    // itself intermittently fail with an unrelated "Contract not found",
    // most likely a worker-process-pool contract-path-cache race. This
    // isn't caused by the fix above and isn't specific to locked
    // streams - it was always possible, just previously indistinguishable
    // from every other failure once everything got masked to the same
    // generic 950. Found while building this test; flagged, not chased
    // further - touches worker-pool/contract-caching internals well
    // outside what was asked for here. Retrying once keeps this test
    // meaningful (still fails loudly if the lock genuinely isn't
    // enforced) without being flaky on an unrelated, pre-existing race.
    let { result, ms } = await timed(() =>
      runContract(nodes[1].baseUrl, lockIdentity, namespace, returnerId, { message: "should-be-blocked" })
    );
    if ((result.$summary?.errors || []).some((e: string) => e.includes("Contract not found"))) {
      ({ result, ms } = await timed(() =>
        runContract(nodes[1].baseUrl, lockIdentity, namespace, returnerId, { message: "should-be-blocked-retry" })
      ));
    }
    const rejected =
      result.$summary?.commit === 0 &&
      (result.$summary?.errors || []).some((e: string) => e.includes("Stream contract locked"));
    report.record("negative-locked-contract", rejected, ms);
    if (rejected) {
      report.ok(`Locked contract correctly rejected with "Stream contract locked" (${ms}ms)`);
    } else {
      report.fail(`Expected a rejected result with "Stream contract locked", got: ${JSON.stringify(result.$summary)}`);
    }
  }
}

/**
 * Deterministic stream ids (this.newActivityStream(name, deterministic)):
 * a genuinely fresh seed must commit cleanly, and a repeated seed must be
 * rejected with a real "Deterministic Stream Name Exists" (1530). Covers
 * the false-positive bug where every deterministic stream, fresh or not,
 * was rejected as an "existing" collision - root-caused to
 * ActiveDSConnect.get() always resolving (ActiveRequest.send() never
 * rejects on a non-2xx status), so detectCollisions()'s
 * get().then(() => true).catch(() => false) always evaluated to true
 * regardless of whether the stream actually existed. Fixed by using
 * ActiveDSConnect.exists() (which checks the resolved body for a real
 * _id) instead, in packages/protocol/src/protocol/streamUpdater.ts.
 *
 * Uses a different origin node for each call (nodes[0] then nodes[1]) so
 * this also confirms the write from the first call is visible
 * network-wide by the time the second call's collision check runs, not
 * just self-consistent on a single node.
 */
async function runDeterministicStreamTests(report: Report, nodes: NetworkNode[]): Promise<void> {
  report.phase("Deterministic streams: fresh seed commits, repeated seed correctly collides");

  const detIdentity = await onboard(nodes[0].baseUrl);
  const namespace = "dettest";
  await registerNamespace(nodes[0].baseUrl, detIdentity, namespace);
  const detContractId = await deployContract(
    nodes[0].baseUrl,
    detIdentity,
    namespace,
    "deterministic",
    path.join(__dirname, "contracts/deterministic-contract.ts")
  );

  const seed = `det-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const streamName = "notabox.identity";

  const { result: first, ms: firstMs } = await timed(() =>
    runContract(nodes[0].baseUrl, detIdentity, namespace, detContractId, { seed, name: streamName })
  );
  const firstOk = !first.$summary?.errors && first.$summary?.commit >= 1;
  report.record("deterministic-fresh-seed", firstOk, firstMs);
  if (firstOk) {
    report.ok(`Fresh deterministic seed committed cleanly via node ${nodes[0].port} (${firstMs}ms)`);
  } else {
    report.fail(`Fresh seed unexpectedly rejected: ${JSON.stringify(first.$summary)}`);
  }

  const { result: second, ms: secondMs } = await timed(() =>
    runContract(nodes[1].baseUrl, detIdentity, namespace, detContractId, { seed, name: streamName })
  );
  const collided =
    second.$summary?.commit === 0 &&
    (second.$summary?.errors || []).some((e: string) => e.includes("Deterministic Stream Name Exists"));
  report.record("deterministic-real-collision", collided, secondMs);
  if (collided) {
    report.ok(`Repeated seed correctly rejected with "Deterministic Stream Name Exists" via node ${nodes[1].port} (${secondMs}ms)`);
  } else {
    report.fail(`Expected a real collision rejection, got: ${JSON.stringify(second.$summary)}`);
  }
}

/**
 * Storage engine HTTP layer, hit directly (not through consensus) - the
 * same layer storageGet()/storagePut() above already use.
 *
 * Covers two next-perf fixes with no prior test coverage:
 * - /_backup and /_restore's filename path-validation (the branch's most
 *   security-sensitive change - blocks writing/reading arbitrary files
 *   via a traversal or absolute-path filename in the request body).
 * - /_all_dbs and the db-info data_size computation, whose file-stat
 *   loops were parallelized (Promise.all(files.map(...))) - sanity-checks
 *   the parallelized versions still return correct, sensible results.
 */
async function runStoragePathValidationTests(
  report: Report,
  nodes: NetworkNode[]
): Promise<void> {
  const storageUrl = nodes[0].storageUrl;

  report.phase("Storage: /_backup and /_restore reject path-traversal filenames");
  {
    const attempts: { label: string; filename: string }[] = [
      { label: "relative traversal", filename: "../../../tmp/pwned-backup" },
      { label: "absolute path", filename: "/tmp/pwned-backup" },
    ];
    let allRejected = true;
    let details = "";
    for (const { label, filename } of attempts) {
      const { statusCode } = await requestJsonWithStatus(
        `${storageUrl}/activeledger/_backup`,
        "POST",
        { filename }
      );
      if (statusCode < 400) {
        allRejected = false;
        details += `${label} backup got ${statusCode} (expected >=400); `;
      }
      const restoreResult = await requestJsonWithStatus(
        `${storageUrl}/activeledger/_restore`,
        "POST",
        { filename }
      );
      if (restoreResult.statusCode < 400) {
        allRejected = false;
        details += `${label} restore got ${restoreResult.statusCode} (expected >=400); `;
      }
    }
    report.record("storage-path-traversal-rejected", allRejected, 0);
    if (allRejected) {
      report.ok("Both /_backup and /_restore rejected every traversal/absolute-path filename");
    } else {
      report.fail(`Expected every attempt to be rejected: ${details}`);
    }
  }

  report.phase("Storage: /_backup still succeeds with a safe filename");
  {
    const { statusCode, data } = await requestJsonWithStatus(
      `${storageUrl}/activeledger/_backup`,
      "POST",
      { filename: `test-backup-${Date.now()}.alb` }
    );
    const ok = statusCode === 200 && data?.status === "started";
    report.record("storage-legit-backup-succeeds", ok, 0);
    if (ok) {
      report.ok(`Legitimate backup filename accepted (${statusCode})`);
    } else {
      report.fail(`Expected 200 { status: "started" }, got ${statusCode} ${JSON.stringify(data)}`);
    }
  }

  report.phase("Storage: /_all_dbs and db-info data_size still return sane results after parallelizing their file-stat loops");
  {
    const { statusCode: dbsStatus, data: dbs } = await requestJsonWithStatus(
      `${storageUrl}/_all_dbs`,
      "GET"
    );
    const dbsOk = dbsStatus === 200 && Array.isArray(dbs) && dbs.includes("activeledger");
    report.record("storage-all-dbs-sane", dbsOk, 0);
    if (dbsOk) {
      report.ok(`/_all_dbs includes "activeledger" (${JSON.stringify(dbs)})`);
    } else {
      report.fail(`Expected an array including "activeledger", got ${dbsStatus} ${JSON.stringify(dbs)}`);
    }

    const { statusCode: infoStatus, data: info } = await requestJsonWithStatus(
      `${storageUrl}/activeledger`,
      "GET"
    );
    const infoOk =
      infoStatus === 200 &&
      typeof info?.data_size === "number" &&
      info.data_size >= 0;
    report.record("storage-data-size-sane", infoOk, 0);
    if (infoOk) {
      report.ok(`db-info data_size is a sane non-negative number (${info.data_size})`);
    } else {
      report.fail(`Expected a non-negative numeric data_size, got ${infoStatus} ${JSON.stringify(info)}`);
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
