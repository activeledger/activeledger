/**
 * Live check that contract streams carry a reference, not their source.
 *
 * Boots a real 4-node network, deploys a contract, updates it, and runs
 * it - asserting at each step that the contract stream holds
 * {umid, hash} rather than base64, that the umid actually resolves back
 * to source matching the hash, that every node wrote the identical
 * document, and that the contract still executes.
 *
 * The unit tests pin the shape the handlers produce. This pins the things
 * only a real network can show: that the umid a contract records is the
 * umid the transaction actually got, that the source is recoverable from
 * the ledger afterwards, and that four nodes independently computing the
 * new state agree byte for byte.
 *
 * Run via `npm run test:network:contracts`.
 */

import * as path from "path";
import * as crypto from "crypto";
import { NetworkHarness } from "./harness";
import { storageGet } from "./http";
import { Report } from "./report";
import {
  Identity,
  onboard,
  registerNamespace,
  deployContract,
  updateContract,
  runContract,
} from "./actions";

const NAMESPACE = "entrytest";
const CONTRACT_NAME = "entryexample";

const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

/** Every version entry across the stream, as [version, entry] pairs. */
const entries = (doc: any): [string, any][] => Object.entries(doc.contract || {});

function assert(report: Report, ok: boolean, message: string): boolean {
  if (ok) {
    report.ok(message);
    return true;
  }
  report.fail(message);
  return false;
}

async function main(): Promise<boolean> {
  const report = new Report();
  const harness = new NetworkHarness({ nodeCount: 4 });
  let passed = true;
  const check = (ok: boolean, message: string) => {
    passed = assert(report, ok, message) && passed;
  };

  report.phase("Booting 4-node network");
  const nodes = await harness.start();
  report.ok(`${nodes.length} nodes ready: ${nodes.map((n) => n.port).join(", ")}`);

  try {
    const origin = nodes[0];

    report.phase("Onboarding identity and namespace");
    const identity: Identity = await onboard(origin.baseUrl);
    await registerNamespace(origin.baseUrl, identity, NAMESPACE);
    report.ok(`identity ${identity.streamId.substring(0, 12)}... namespace ${NAMESPACE}`);

    const sourcePath = path.join(__dirname, "contracts", "returner-contract.ts");
    const source = require("fs").readFileSync(sourcePath, "utf8");
    const expectedHash = sha256(source);

    // ---- Deploy -------------------------------------------------------
    report.phase("Deploying a contract");
    const streamId = await deployContract(
      origin.baseUrl,
      identity,
      NAMESPACE,
      CONTRACT_NAME,
      sourcePath
    );
    report.ok(`deployed as ${streamId.substring(0, 16)}...`);

    const deployed = await storageGet(origin.storageUrl, streamId);
    const v1 = deployed.contract?.["0.0.1"];

    check(
      typeof v1 === "object" && v1 !== null,
      "0.0.1 entry is a reference object, not a base64 string"
    );
    check(typeof v1?.umid === "string", "0.0.1 entry carries a umid");
    check(v1?.hash === expectedHash, "0.0.1 hash is sha256 of the deployed source");
    check(
      typeof deployed.identity === "string",
      "stream records the deploy identity for rebuild"
    );
    check(
      deployed.identity === identity.streamId,
      "recorded identity is the transaction's own input stream"
    );
    check(
      !JSON.stringify(deployed).includes(Buffer.from(source).toString("base64")),
      "no base64 source anywhere in the contract stream"
    );

    // The whole point: the source has to come back out of the ledger.
    report.phase("Recovering the source from the umid it recorded");
    const umidDoc = await storageGet(origin.storageUrl, `${v1.umid}:umid`);
    const recovered = umidDoc?.umid?.$tx?.$i?.[deployed.identity]?.contract;
    check(typeof recovered === "string", "the recorded umid document holds the source");
    check(
      typeof recovered === "string" &&
        sha256(Buffer.from(recovered, "base64").toString()) === v1.hash,
      "recovered source hashes to what the stream recorded"
    );

    // ---- Every node agrees --------------------------------------------
    report.phase("Checking all nodes wrote the same document");
    const perNode = await Promise.all(
      nodes.map((n) => storageGet(n.storageUrl, streamId).catch(() => null))
    );
    const held = perNode.filter((d) => d);
    check(held.length === nodes.length, `all ${nodes.length} nodes hold the contract stream`);
    const canonical = JSON.stringify(
      held[0] && { ...held[0], _rev: undefined }
    );
    check(
      held.every((d) => JSON.stringify({ ...d, _rev: undefined }) === canonical),
      "every node computed an identical contract stream (no divergence)"
    );

    // ---- Run it -------------------------------------------------------
    report.phase("Running the deployed contract");
    const ran = await runContract(origin.baseUrl, identity, NAMESPACE, streamId, {
      message: "before-update",
    });
    check(!ran.$summary?.errors, "contract executed without errors");
    check(
      ran.$responses?.[0]?.echoedMessage === "before-update",
      "contract returned the value it was given (it really ran)"
    );

    // ---- Update -------------------------------------------------------
    report.phase("Updating the contract to 0.0.2");
    const updateResult = await updateContract(
      origin.baseUrl,
      identity,
      NAMESPACE,
      streamId,
      CONTRACT_NAME,
      sourcePath,
      "0.0.2"
    );
    check(!updateResult.$summary?.errors, "update committed without errors");

    const updated = await storageGet(origin.storageUrl, streamId);
    const u1 = updated.contract?.["0.0.1"];
    const u2 = updated.contract?.["0.0.2"];

    check(typeof u2 === "object" && u2 !== null, "0.0.2 entry is a reference object");
    check(typeof u2?.umid === "string", "0.0.2 entry carries its own umid");
    check(u2?.umid !== u1?.umid, "0.0.2 records a different umid to 0.0.1");
    check(u2?.hash === expectedHash, "0.0.2 hash is sha256 of the deployed source");
    check(
      entries(updated).length === 2,
      "both versions are present - normalising never drops a version"
    );
    check(
      entries(updated).every(([, e]) => typeof e !== "string"),
      "no version entry is a raw base64 string after update"
    );
    check(
      !JSON.stringify(updated).includes(Buffer.from(source).toString("base64")),
      "no base64 source anywhere after update"
    );

    report.phase("Running the contract again after update");
    const ranAgain = await runContract(origin.baseUrl, identity, NAMESPACE, streamId, {
      message: "after-update",
    });
    check(!ranAgain.$summary?.errors, "updated contract still executes");
    check(
      ranAgain.$responses?.[0]?.echoedMessage === "after-update",
      "updated contract returned the value it was given"
    );

    report.phase("Stream size");
    report.ok(
      `contract stream is ${JSON.stringify(updated).length} bytes for 2 versions ` +
        `(previously ~${Buffer.from(source).toString("base64").length * 2} bytes of base64 alone)`
    );
  } finally {
    await harness.stop();
    harness.cleanup();
  }

  return passed;
}

main()
  .then((ok) => {
    console.log(ok ? "\nCONTRACT ENTRY CHECK PASSED\n" : "\nCONTRACT ENTRY CHECK FAILED\n");
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
