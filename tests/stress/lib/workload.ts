/**
 * Shared pieces of the network-driving stress tools: running a harness
 * network with guaranteed teardown, the load gate wiring, contracts, and
 * transaction builders. Needs a built workspace and free ports, so it is
 * exercised by running the tools, not by the unit tests.
 */

import * as path from "path";
import { ActiveCrypto } from "../../../packages/crypto/src";
import { NetworkHarness, NetworkHarnessOptions, NetworkNode } from "../../network/harness";
import { submit } from "../../network/http";
import { Identity, deployContract, onboard, registerNamespace } from "../../network/actions";
import { Flags } from "./cli";
import { GateResult, readLoad, waitForQuiet } from "./loadgate";

export const CONTRACT_FILES: Record<string, string> = {
  returner: "returner-contract.ts",
  "no-write": "no-write-contract.ts",
  "cpu-work": "cpu-work-contract.ts",
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True if a transaction response shows the transaction committed. */
export function isCommitted(r: any): boolean {
  return !!(r && r.$streams && ((r.$streams.updated && r.$streams.updated.length) || (r.$streams.new && r.$streams.new.length)));
}

/** A short reason from a failed response or an exception. */
export function reasonOf(r: any): string {
  if (r instanceof Error) return r.message.slice(0, 300);
  const errors = r && r.$summary && r.$summary.errors;
  return (errors && errors.length ? errors.join("; ") : JSON.stringify(r)).slice(0, 300);
}

/** Runs the load gate as the flags ask, printing while it waits. */
export async function gate(flags: Flags): Promise<GateResult | undefined> {
  if (!flags.gate) return undefined;
  let printed = false;
  const result = await waitForQuiet({
    maxLoad: flags.maxLoad,
    quietSeconds: flags.quietSeconds,
    timeoutSeconds: flags.gateTimeout,
    onWait: (load, waited) => {
      if (!printed || Math.round(waited) % 20 === 0) {
        console.log(`load gate: 1-minute load ${load.load1.toFixed(2)}, waiting for < ${flags.maxLoad} for ${flags.quietSeconds}s`);
        printed = true;
      }
    },
  });
  if (!result.quiet) {
    console.warn(`load gate: still busy after ${flags.gateTimeout}s (load ${result.load.load1.toFixed(2)}); running anyway, results flagged`);
  }
  return result;
}

export const loadNow = readLoad;

/**
 * Starts a harness network, runs `fn`, and always tears it down, including
 * on Ctrl-C or SIGTERM, so a stopped tool does not leave node processes
 * behind.
 */
export async function withNetwork<T>(
  options: NetworkHarnessOptions,
  fn: (harness: NetworkHarness, nodes: NetworkNode[]) => Promise<T>
): Promise<T> {
  const harness = new NetworkHarness(options);
  const teardown = async () => {
    await harness.stop().catch(() => undefined);
    try {
      harness.cleanup();
    } catch {
      // already gone
    }
  };
  const onSignal = () => {
    teardown().then(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const nodes = await harness.start();
    return await fn(harness, nodes);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await teardown();
  }
}

export const contractPath = (kind: string) => path.join(__dirname, "../../network/contracts", CONTRACT_FILES[kind]);

export interface Workload {
  namespace: string;
  contractId: string;
  /** one identity per client, each onboarded at a different entry node */
  identities: Identity[];
}

/**
 * Onboards an admin, registers a namespace, deploys the chosen contract and
 * onboards one identity per client (spread over the nodes). Everything goes
 * through the first node's consensus like any user would.
 */
export async function setupWorkload(nodes: NetworkNode[], contract: string, clients: number): Promise<Workload> {
  if (!CONTRACT_FILES[contract]) {
    throw new Error(`unknown contract "${contract}", expected one of ${Object.keys(CONTRACT_FILES).join(", ")}`);
  }
  const base = nodes[0].baseUrl;
  const admin = await onboard(base);
  const namespace = `s${Date.now().toString(36)}`;
  const ns = await registerNamespace(base, admin, namespace);
  if (!isCommitted(ns)) throw new Error(`namespace registration failed: ${reasonOf(ns)}`);
  const contractId = await deployContract(base, admin, namespace, contract, contractPath(contract));
  const identities: Identity[] = [];
  for (let i = 0; i < clients; i++) identities.push(await onboard(nodes[i % nodes.length].baseUrl));
  return { namespace, contractId, identities };
}

/** A signed contract transaction on the client's own stream (the "hot stream" case). */
export function hotTransaction(w: Workload, client: number, message: string): unknown {
  const id = w.identities[client];
  const body = { $namespace: w.namespace, $contract: w.contractId, $i: { [id.streamId]: {} }, $o: { [id.streamId]: { message } } };
  return { $tx: body, $sigs: { [id.streamId]: id.keyPair.sign(body) } };
}

/**
 * A self-signed onboard of a brand new identity: every transaction creates a
 * new stream (the "unique stream" case). It always runs the default onboard
 * contract, whatever --contract says.
 */
export function uniqueTransaction(): unknown {
  const keyPair = new ActiveCrypto.KeyPair("secp256k1");
  const keys = keyPair.generate(256, true);
  const body = {
    $namespace: "default",
    $contract: "onboard",
    $i: { identity: { type: "secp256k1", publicKey: keys.pub.pkcs8pem } },
    $o: {},
  };
  return { $tx: body, $selfsign: true, $sigs: { identity: keyPair.sign(body) } };
}

export interface Timed {
  ms: number;
  committed: boolean;
  reason?: string;
}

/** Submits one transaction and times it. Never throws. */
export async function timedSubmit(baseUrl: string, tx: unknown): Promise<Timed> {
  const start = process.hrtime.bigint();
  let committed = false;
  let reason: string | undefined;
  try {
    const r = await submit(baseUrl, tx);
    committed = isCommitted(r);
    if (!committed) reason = reasonOf(r);
  } catch (e) {
    reason = reasonOf(e);
  }
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, committed, reason };
}
