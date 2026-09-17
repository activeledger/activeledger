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
import * as fs from "fs";
import * as os from "os";
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


/**
 * Every node agrees about every version - in the ledger and on disk.
 *
 * Both halves matter and they fail differently. The stream entries are
 * what consensus produced, so a disagreement there is a divergence: the
 * new write path computing something per-node rather than per-transaction
 * would show up here and nowhere else. The .js files are what each node
 * actually executes, written independently by each node's own commit(),
 * and nothing automatic ever repairs them (rebuild only runs under
 * `activerestore --full`) - so a node missing one is silently unable to
 * run the contract while holding a perfectly healthy stream.
 */
async function verifyVersionsAcrossNodes(
  report: Report,
  check: (ok: boolean, message: string) => void,
  nodes: { storageUrl: string; dataDir: string; port: number }[],
  streamId: string,
  namespace: string,
  expectedVersionCount: number
): Promise<void> {
  report.phase(`Verifying versions across ${nodes.length} nodes`);

  const docs = await Promise.all(
    nodes.map((n) => storageGet(n.storageUrl, streamId).catch(() => null))
  );

  const missing = docs
    .map((d, i) => (d ? null : nodes[i].port))
    .filter((p) => p !== null);
  check(missing.length === 0, `all ${nodes.length} nodes hold the contract stream`);
  if (missing.length) return;

  // --- version key sets ------------------------------------------------
  const keySets = docs.map((d) => Object.keys(d.contract || {}).sort());
  const expectedKeys = keySets[0];
  check(
    expectedKeys.length === expectedVersionCount,
    `stream carries ${expectedVersionCount} version(s): ${expectedKeys.join(", ")}`
  );
  const keyMismatch = keySets
    .map((k, i) => (k.join(",") === expectedKeys.join(",") ? null : `${nodes[i].port}=[${k}]`))
    .filter(Boolean);
  check(
    keyMismatch.length === 0,
    keyMismatch.length
      ? `version key sets disagree: ${keyMismatch.join(" ")}`
      : "every node holds the same set of versions"
  );

  // --- per-version umid and hash ---------------------------------------
  for (const version of expectedKeys) {
    const refs = docs.map((d) => d.contract[version]);
    const first = refs[0];
    const umidDisagree = refs
      .map((r, i) => (r?.umid === first?.umid ? null : nodes[i].port))
      .filter(Boolean);
    const hashDisagree = refs
      .map((r, i) => (r?.hash === first?.hash ? null : nodes[i].port))
      .filter(Boolean);

    check(
      umidDisagree.length === 0,
      umidDisagree.length
        ? `${version}: umid disagrees on node(s) ${umidDisagree.join(", ")}`
        : `${version}: every node records umid ${String(first?.umid).substring(0, 12)}...`
    );
    check(
      hashDisagree.length === 0,
      hashDisagree.length
        ? `${version}: hash disagrees on node(s) ${hashDisagree.join(", ")}`
        : `${version}: every node records hash ${String(first?.hash).substring(0, 12)}...`
    );
    check(
      refs.every((r) => typeof r !== "string"),
      `${version}: no node is still holding base64 source`
    );
  }

  // --- identity -------------------------------------------------------
  const identities = docs.map((d) => d.identity);
  check(
    identities.every((i) => i && i === identities[0]),
    "every node records the same deploy identity"
  );

  // --- the files each node actually executes ---------------------------
  const highest = [...expectedKeys].sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  })[expectedKeys.length - 1];

  for (const version of expectedKeys) {
    const contents = nodes.map((n) => {
      const file = path.join(n.dataDir, "contracts", namespace, `${streamId}@${version}.js`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    });
    const absent = contents
      .map((c, i) => (c === null ? nodes[i].port : null))
      .filter(Boolean);
    check(
      absent.length === 0,
      absent.length
        ? `${version}: .js missing on node(s) ${absent.join(", ")}`
        : `${version}: every node wrote its own .js`
    );
    check(
      absent.length === 0 && contents.every((c) => c === contents[0]),
      `${version}: every node's .js is byte-identical`
    );
  }

  // The unversioned file is what an unpinned transaction executes, so it
  // has to track the newest version - not whichever one was written last.
  const latest = nodes.map((n) => {
    const f = path.join(n.dataDir, "contracts", namespace, `${streamId}.js`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  });
  const highestFiles = nodes.map((n) => {
    const f = path.join(n.dataDir, "contracts", namespace, `${streamId}@${highest}.js`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  });
  check(
    latest.every((c) => c !== null),
    "every node has the unversioned latest .js"
  );
  check(
    latest.every((c, i) => c === highestFiles[i]),
    `unversioned .js matches the highest version (${highest}) on every node`
  );
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
    const source = fs.readFileSync(sourcePath, "utf8");
    const expectedHash = sha256(source);

    // v2 has to differ from v1 in a way that survives transpile
    // (removeComments is on, so a comment-only change compiles to
    // identical output and would prove nothing). Changing the `via` string
    // gives each version a distinct hash AND a distinct .js on disk, which
    // is what makes the "latest file tracks the newest version" check
    // below able to fail.
    const sourceV2 = source.replace('via: "returner-contract"', 'via: "returner-contract-v2"');
    if (sourceV2 === source) throw new Error("v2 source marker did not apply");
    const expectedHashV2 = sha256(sourceV2);
    const sourceV2Path = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "activeledger-entry-v2-")),
      "returner-contract.ts"
    );
    fs.writeFileSync(sourceV2Path, sourceV2);

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

    await verifyVersionsAcrossNodes(report, check, nodes, streamId, NAMESPACE, 1);

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
      sourceV2Path,
      "0.0.2"
    );
    check(!updateResult.$summary?.errors, "update committed without errors");

    const updated = await storageGet(origin.storageUrl, streamId);
    const u1 = updated.contract?.["0.0.1"];
    const u2 = updated.contract?.["0.0.2"];

    check(typeof u2 === "object" && u2 !== null, "0.0.2 entry is a reference object");
    check(typeof u2?.umid === "string", "0.0.2 entry carries its own umid");
    check(u2?.umid !== u1?.umid, "0.0.2 records a different umid to 0.0.1");
    check(u2?.hash === expectedHashV2, "0.0.2 hash is sha256 of the source it deployed");
    check(u2?.hash !== u1?.hash, "0.0.2 hash differs from 0.0.1 - hashed per version");
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

    await verifyVersionsAcrossNodes(report, check, nodes, streamId, NAMESPACE, 2);

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
