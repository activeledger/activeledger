/**
 * Live 4-node network integration test. Boots a real bare-host network,
 * runs 100+ real transactions spread across all nodes as origin, verifies
 * SSE event delivery, verifies returnToRemote(), and verifies SPI recovery
 * both when the desynced node is the transaction's origin and when it
 * isn't. Not a Mocha suite - a standalone script with live progress and a
 * final summary, run via `npm run test:network`.
 */

import * as path from "path";
import * as fsSync from "fs";
import { NetworkHarness, NetworkNode } from "./harness";
import { submit, storageGet, storagePut, requestJsonWithStatus } from "./http";
import { SSEClient } from "./sse";
import { Report } from "./report";
import {
  Identity,
  onboard,
  registerNamespace,
  deployContract,
  updateContract,
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

    await runMetaGrowthTest(report, nodes, identity, NAMESPACE, returnerId);

    await runStoragePathValidationTests(report, nodes);

    await runSpiTests(report, nodes, identity, NAMESPACE, returnerId);

    await runContractDivergenceTest(report, nodes, identity, NAMESPACE);

    await runNodeRecoveryTests(report, harness, nodes, identity, NAMESPACE, returnerId);

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
 * Regression check for the streamUpdater.ts/stream.ts fix (v4.5.6):
 * meta.umid used to be permanently frozen at whichever transaction first
 * created a stream, never refreshed on later updates - and the
 * previous attempt at tracking transaction history (meta.txs, allowed to
 * grow unbounded) was reverted after it got too expensive to load. This
 * checks both halves stay fixed: umid tracks the *latest* transaction on
 * every round, and the meta doc's own size stays flat rather than
 * creeping up as more transactions accumulate against the same stream.
 */
async function runMetaGrowthTest(
  report: Report,
  nodes: NetworkNode[],
  identity: Identity,
  namespace: string,
  returnerId: string
): Promise<void> {
  report.phase("Meta doc growth: umid tracks the latest transaction, doc size stays flat");

  const ROUNDS = 20;
  const sizes: number[] = [];
  let allMatch = true;

  for (let i = 1; i <= ROUNDS; i++) {
    const result = await runContract(nodes[0].baseUrl, identity, namespace, returnerId, { message: `growth-check-${i}` });
    if (result.$summary?.errors) {
      report.fail(`Round ${i} unexpectedly rejected: ${JSON.stringify(result.$summary)}`);
      allMatch = false;
      continue;
    }

    const metaDoc = await storageGet(nodes[0].storageUrl, `${identity.streamId}:stream`);
    const matchesLatest = metaDoc.umid === result.$umid;
    if (!matchesLatest) allMatch = false;
    sizes.push(Buffer.byteLength(JSON.stringify(metaDoc), "utf8"));
  }

  report.record("meta-umid-tracks-latest", allMatch, 0);
  if (allMatch) {
    report.ok(`meta.umid correctly matched its own round's transaction across all ${ROUNDS} rounds`);
  } else {
    report.fail(`meta.umid did not match the latest transaction on at least one of ${ROUNDS} rounds`);
  }

  // A few bytes of wobble is expected (umid/_rev are hex/decimal strings
  // of slightly varying length round to round) - anything beyond that
  // means something is accumulating, which is exactly the failure mode
  // this test exists to catch.
  const flat = Math.max(...sizes) - Math.min(...sizes) <= 8;
  report.record("meta-doc-size-flat", flat, 0);
  if (flat) {
    report.ok(`Meta doc size stayed flat across ${ROUNDS} rounds (${Math.min(...sizes)}-${Math.max(...sizes)} bytes)`);
  } else {
    report.fail(`Meta doc size grew beyond expected wobble: ${Math.min(...sizes)}-${Math.max(...sizes)} bytes across ${ROUNDS} rounds`);
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
 * Reads a node's own log and reports which repair mechanism, if any,
 * touched a given stream.
 *
 * "Did it converge" is necessary but not sufficient - a stream can end up
 * consistent because the transaction eventually applied everywhere, which
 * says nothing about whether reconciliation works. Naming the mechanism is
 * the difference between a test that guards an outcome and one that
 * proves a cause.
 */
function healedBy(node: NetworkNode, streamId: string): string[] {
  let log = "";
  try {
    log = fsSync.readFileSync(node.logPath, "utf8");
  } catch {
    return ["log unreadable"];
  }
  // Strip ANSI colour before matching. The logger writes escape codes
  // around the message, and an earlier version of this check filtered
  // lines by stream id first and found nothing - not because no repair
  // happened, but because the filter was wrong. A log grep that reports a
  // clean negative when the log plainly contains the opposite is worse
  // than no check at all.
  const plain = log.replace(/\u001b\[[0-9;]*m/g, "");
  const short = streamId.slice(0, 16);
  const found: string[] = [];
  for (const line of plain.split("\n")) {
    if (line.indexOf(short) === -1) continue;
    if (line.indexOf("SPI REWRITE FAILED") !== -1) {
      found.push("SPI write failed");
    } else if (line.indexOf("SPI REWRITING") !== -1) {
      found.push("SPI rewrite");
    }
    if (line.indexOf("Stream resync") !== -1) found.push("restore reconciler");
    if (line.indexOf("SPI NOWINNER") !== -1) found.push("SPI abstained");
  }
  return found.filter((v, i) => found.indexOf(v) === i);
}

/**
 * Reads one stream from every node and reports the distinct revisions.
 *
 * Every SPI assertion in this file used to be "did the client get a
 * response without errors", which is a question about the transaction, not
 * about the network. A round that commits on three nodes while the fourth
 * stays behind answers that question with a cheerful yes - and being
 * behind is precisely the fault worth catching, because that node now
 * vetoes every future transaction touching the stream. Convergence has to
 * be read off the nodes themselves.
 */
async function revisionsAcross(
  nodes: NetworkNode[],
  streamId: string
): Promise<{ byNode: { port: number; rev: string }[]; converged: boolean }> {
  const byNode: { port: number; rev: string }[] = [];
  for (const node of nodes) {
    try {
      const doc = await storageGet(node.storageUrl, streamId);
      byNode.push({ port: node.port, rev: doc?._rev || "missing" });
    } catch {
      byNode.push({ port: node.port, rev: "unreadable" });
    }
  }
  const distinct = new Set(byNode.map((n) => n.rev));
  return { byNode, converged: distinct.size === 1 };
}

/** Waits for every node to agree on a stream's revision, or gives up. */
async function waitForConvergence(
  nodes: NetworkNode[],
  streamId: string,
  timeoutMs: number
): Promise<{ byNode: { port: number; rev: string }[]; converged: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last = await revisionsAcross(nodes, streamId);
  while (!last.converged && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await revisionsAcross(nodes, streamId);
  }
  return last;
}

/**
 * The scenario a live network hit that this suite did not: a node holding
 * a CONTRACT's own stream at the wrong revision.
 *
 * The existing SPI tests desync an identity stream, which the transaction
 * that follows names in $i/$o, so SPI is asked about it directly and the
 * repair works. A contract's code stream is only ever named in $i/$o by a
 * contract update - so it is only ever arbitrated during exactly the
 * transaction that holds it locked on every node, which is the one moment
 * SPI cannot get a clean sample.
 *
 * Asserts the two things that actually matter, separately:
 *   1. does a majority that agrees still commit when one node dissents
 *   2. does the dissenting node afterwards catch up
 *
 * They are separate because the first can pass while the second fails
 * forever, which is what happened in production.
 *
 * Known state of these two assertions, measured against a real 4-node
 * network rather than assumed:
 *
 * - contract-update-majority-commits FAILS, and fails identically with
 *   and without the reconciler work. Three nodes vote yes and one commits
 *   (`vote: 3, commit: 1`). It reproduces locally, on one machine, with no
 *   container or network layer involved, so it is an engine fault rather
 *   than anything about how a particular deployment is wired. It is left
 *   here failing on purpose: it is the regression guard for a bug that is
 *   still open, and this script is a diagnostic run by hand, not part of
 *   `npm test`.
 *
 * - contract-desync-converged PASSES, and the desynced node's own log
 *   names SPI as what repaired it - "SPI REWRITING #2 <stream> @ <rev>"
 *   carrying the exact revision the network converged on, for both the
 *   state document and its :stream meta. So on a clean 3-1 split with an
 *   answerable sample, the existing repair does work end to end.
 *
 *   That does not extend to the case this suite still cannot construct:
 *   the production incident had the triggering transaction commit NOWHERE,
 *   which leaves the divergence in place and is what the idle reconciler
 *   is for. Here the update does commit, so this proves SPI, not the
 *   reconciler.
 */
async function runContractDivergenceTest(
  report: Report,
  nodes: NetworkNode[],
  identity: Identity,
  namespace: string
): Promise<void> {
  const contractSource = path.join(__dirname, "contracts/returner-contract.ts");
  const desyncTarget = nodes[0];
  const originNode = nodes[1];

  report.phase("Contract divergence: deploying a contract to update");
  const contractId = await deployContract(
    nodes[0].baseUrl,
    identity,
    namespace,
    "divergence",
    contractSource
  );
  report.ok(`Deployed ${contractId}`);

  // A first update, so the stream has a real history and the test is not
  // measuring anything special about a freshly created stream.
  const firstUpdate = await updateContract(
    originNode.baseUrl,
    identity,
    namespace,
    contractId,
    "divergence",
    contractSource,
    "0.0.2"
  );
  if (firstUpdate.$summary?.errors) {
    report.fail(`Baseline contract update failed: ${JSON.stringify(firstUpdate.$summary)}`);
    report.record("contract-update-baseline", false, 0);
    return;
  }
  report.record("contract-update-baseline", true, 0);

  const settled = await waitForConvergence(nodes, contractId, 15000);
  if (!settled.converged) {
    report.fail(
      `Nodes disagreed before the test even started: ${JSON.stringify(settled.byNode)}`
    );
    report.record("contract-update-baseline-converged", false, 0);
    return;
  }
  const baseRev = settled.byNode[0].rev;
  report.ok(`All nodes agree at ${baseRev}`);
  report.record("contract-update-baseline-converged", true, 0);

  report.phase(`Contract divergence: desyncing node ${desyncTarget.port}`);
  // Both documents, because they diverge together in the real fault - the
  // state document and its :stream meta are written by the same commit.
  for (const id of [contractId, `${contractId}:stream`]) {
    const current = await storageGet(desyncTarget.storageUrl, id);
    await storagePut(desyncTarget.storageUrl, id, {
      ...current,
      contractDivergenceMarker: `desync-${Date.now()}`,
    });
  }
  const desynced = await revisionsAcross(nodes, contractId);
  if (desynced.converged) {
    report.fail("Desync had no effect - the test cannot prove anything");
    report.record("contract-desync-injected", false, 0);
    return;
  }
  report.ok(`Injected: ${JSON.stringify(desynced.byNode)}`);
  report.record("contract-desync-injected", true, 0);

  report.phase("Contract divergence: does a 3/4 majority still commit?");
  const { result, ms } = await timed(() =>
    updateContract(
      originNode.baseUrl,
      identity,
      namespace,
      contractId,
      "divergence",
      contractSource,
      "0.0.3"
    )
  );

  // The dissenting node is expected to report a position error - that is
  // the correct behaviour, not the failure. What matters is whether the
  // three nodes that agree went ahead and committed anyway.
  const committed = (result.$summary?.commit ?? 0) >= 3;
  report.record("contract-update-majority-commits", committed, ms);
  committed
    ? report.ok(`Committed on ${result.$summary.commit} nodes with one dissenter (${ms}ms)`)
    : report.fail(
        `Only ${result.$summary?.commit ?? 0} nodes committed: ${JSON.stringify(result.$summary)}`
      );

  report.phase("Contract divergence: does the desynced node catch up?");
  // Generous, and deliberately so: reconciliation is asynchronous and runs
  // off a periodic check, so the honest question is "does it ever", not
  // "does it within one round trip".
  const converged = await waitForConvergence(nodes, contractId, 60000);
  report.record("contract-desync-converged", converged.converged, 0);
  converged.converged
    ? report.ok(`All four nodes converged at ${converged.byNode[0].rev}`)
    : report.fail(
        `Node did not catch up after 60s: ${JSON.stringify(converged.byNode)}`
      );

  // Name the mechanism. Convergence alone does not distinguish "something
  // repaired the laggard" from "the update simply applied everywhere in
  // the end", and only the first is what this suite is here to prove.
  const mechanisms = healedBy(desyncTarget, contractId);
  mechanisms.length
    ? report.info(`Desynced node log shows: ${mechanisms.join(", ")}`)
    : report.warn(
        `Desynced node log shows no repair activity for ${contractId.slice(0, 16)}`
      );

  // A negative from a log grep is only worth anything if the log contains
  // what you think it does. Report what SPI actually said, so an empty
  // result above can be read as "it did not repair" rather than "the
  // filter missed".
  try {
    const raw = fsSync.readFileSync(desyncTarget.logPath, "utf8");
    const spiLines = raw.split("\n").filter((l) => l.indexOf("SPI") !== -1);
    report.info(`Desynced node logged ${spiLines.length} SPI lines`);
    for (const line of spiLines.slice(-6)) {
      report.info(`  ${line.slice(0, 200)}`);
    }
  } catch {
    report.warn("Could not read the desynced node's log");
  }

  const metaConverged = await waitForConvergence(nodes, `${contractId}:stream`, 15000);
  report.record("contract-desync-meta-converged", metaConverged.converged, 0);
  metaConverged.converged
    ? report.ok(`Meta document converged at ${metaConverged.byNode[0].rev}`)
    : report.fail(
        `Meta document still split: ${JSON.stringify(metaConverged.byNode)}`
      );
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

/**
 * Exercises the reactive neighbourhood health-check end to end - the one
 * scenario that was, until now, only ever verified manually (kill a node
 * by hand, read the logs). Everything else in this suite tests the happy
 * path; this is the actual point of the redesign, so it gets its own
 * automated regression guard against both halves of the failure mode this
 * session's work fixed:
 *
 * - A transaction submitted while a neighbour is down must still complete
 *   promptly via the remaining nodes, not silently hang waiting on a
 *   neighbour nothing is going to mark unavailable (the original
 *   ActiveRequest.send()-never-rejects bug) or on stale/incomplete
 *   discovery racing the harness's own readiness check (the
 *   getInterval()/Stable bug) - both fixed earlier in this same PR.
 * - The network must actually recover once the neighbour comes back, not
 *   just correctly notice it went away.
 */
async function runNodeRecoveryTests(
  report: Report,
  harness: NetworkHarness,
  nodes: NetworkNode[],
  identity: Identity,
  namespace: string,
  returnerId: string
): Promise<void> {
  const downNode = nodes[1];
  const originNode = nodes[0];

  report.phase(`Node recovery: killing node ${downNode.port} mid-operation`);
  await harness.killNode(downNode.index);
  report.ok(`Node ${downNode.port} stopped`);

  report.phase(`Node recovery: transaction via node ${originNode.port} with node ${downNode.port} down`);
  {
    // Generous relative to the ~1-2s typical transaction time seen
    // elsewhere in this suite, but a small, deliberate fraction of the
    // harness's own 20s HTTP timeout - the exact symptom being guarded
    // against here is a transaction silently riding that timeout out
    // instead of completing promptly via the 3 remaining nodes.
    const REGRESSION_THRESHOLD_MS = 12000;
    try {
      const { result, ms } = await timed(() =>
        runContract(originNode.baseUrl, identity, namespace, returnerId, { message: "node-down-recovery" })
      );
      const ok = !result.$summary?.errors && ms < REGRESSION_THRESHOLD_MS;
      report.record("node-down-transaction", ok, ms);
      if (!result.$summary?.errors && ms < REGRESSION_THRESHOLD_MS) {
        report.ok(`Transaction completed in ${ms}ms with node ${downNode.port} down (well under the ${REGRESSION_THRESHOLD_MS}ms regression threshold)`);
      } else if (result.$summary?.errors) {
        report.fail(`Failed: ${JSON.stringify(result.$summary)}`);
      } else {
        report.fail(`Completed in ${ms}ms - at or over the ${REGRESSION_THRESHOLD_MS}ms regression threshold, the network isn't routing around the down node promptly`);
      }
    } catch (error) {
      report.record("node-down-transaction", false, 0);
      report.fail(`Transaction threw instead of completing - likely hung until the harness's own HTTP timeout: ${error}`);
    }
  }

  report.phase(`Node recovery: restarting node ${downNode.port}`);
  await harness.restartNode(downNode.index);
  report.ok(`Node ${downNode.port} back up and reporting Stable`);

  // Give the reactive recovery-poll loop (RECOVERY_CHECK_INTERVAL, 3s) a
  // beat to actually notice and re-mark the node home on the other
  // nodes' side, not just confirm the restarted node's own status.
  await new Promise((r) => setTimeout(r, 4000));

  report.phase(`Node recovery: transaction via node ${originNode.port} after node ${downNode.port} recovered`);
  {
    const { result, ms } = await timed(() =>
      runContract(originNode.baseUrl, identity, namespace, returnerId, { message: "node-recovered" })
    );
    const ok = !result.$summary?.errors;
    report.record("node-recovered-transaction", ok, ms);
    ok
      ? report.ok(`Transaction succeeded after node ${downNode.port} recovered (${ms}ms)`)
      : report.fail(`Failed: ${JSON.stringify(result.$summary)}`);
  }
}

main()
  .then((allPassed) => process.exit(allPassed ? 0 : 1))
  .catch((error) => {
    console.error("Network test crashed:", error);
    process.exit(1);
  });
