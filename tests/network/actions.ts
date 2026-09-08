/**
 * Domain-level actions built on top of http.ts's plain submit() - onboarding,
 * namespace registration, and contract deploy/run. Shapes verified live,
 * real transactions, repeatedly throughout the hpe-13/hpe-14 sessions (see
 * docs-v4/transactions.md and docs-v4/contracts.md on the hpe-13 branch).
 */

import * as fs from "fs";
import { ActiveCrypto } from "../../packages/crypto/src";
import { submit } from "./http";

export interface Identity {
  streamId: string;
  keyPair: ActiveCrypto.KeyPair;
}

export async function onboard(baseUrl: string): Promise<Identity> {
  const keyPair = new ActiveCrypto.KeyPair("rsa");
  const keys = keyPair.generate();
  const txBody = {
    $namespace: "default",
    $contract: "onboard",
    $i: { identity: { type: "rsa", publicKey: keys.pub.pkcs8pem } },
    $o: {},
  };
  const tx = {
    $tx: txBody,
    $selfsign: true,
    $sigs: { identity: keyPair.sign(txBody) },
  };
  const result = await submit(baseUrl, tx);
  if (!result.$streams?.new?.[0]?.id) {
    throw new Error(`Onboard failed: ${JSON.stringify(result)}`);
  }
  return { streamId: result.$streams.new[0].id, keyPair };
}

export async function registerNamespace(
  baseUrl: string,
  identity: Identity,
  namespace: string
): Promise<any> {
  const txBody = {
    $namespace: "default",
    $contract: "namespace",
    $i: { [identity.streamId]: { namespace } },
  };
  const tx = {
    $tx: txBody,
    $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
  };
  return submit(baseUrl, tx);
}

export async function deployContract(
  baseUrl: string,
  identity: Identity,
  namespace: string,
  contractName: string,
  sourcePath: string
): Promise<string> {
  const contractSrc = fs.readFileSync(sourcePath, "utf8");
  const txBody = {
    $namespace: "default",
    $contract: "contract",
    $i: {
      [identity.streamId]: {
        version: "0.0.1",
        namespace,
        name: contractName,
        contract: Buffer.from(contractSrc).toString("base64"),
      },
    },
  };
  const tx = {
    $tx: txBody,
    $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
  };
  const result = await submit(baseUrl, tx);
  const contractStreamId = result.$streams?.new?.[0]?.id;
  if (!contractStreamId) {
    throw new Error(`Contract deploy failed: ${JSON.stringify(result)}`);
  }
  return contractStreamId;
}

/**
 * Updates an already-deployed contract in place, the way a real redeploy
 * does: $entry "update" against the default contract system contract, with
 * the contract's own stream id as the OUTPUT.
 *
 * That output is what makes this different from every other transaction
 * this suite runs. The contract stream is revision-checked and locked like
 * any other output, so a node holding it at the wrong revision vetoes the
 * update - which is the only situation in which that stream is ever
 * arbitrated.
 */
export async function updateContract(
  baseUrl: string,
  identity: Identity,
  namespace: string,
  contractStreamId: string,
  contractName: string,
  sourcePath: string,
  version: string
): Promise<any> {
  const contractSrc = fs.readFileSync(sourcePath, "utf8");
  const txBody = {
    $entry: "update",
    $namespace: "default",
    $contract: "contract",
    $i: {
      [identity.streamId]: {
        version,
        namespace,
        name: contractName,
        contract: Buffer.from(contractSrc).toString("base64"),
      },
    },
    $o: { [contractStreamId]: {} },
  };
  const tx = {
    $tx: txBody,
    $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
  };
  return submit(baseUrl, tx);
}

/** Runs a deployed contract, writing to (and reading permission from) the caller's own identity stream. */
export async function runContract(
  baseUrl: string,
  identity: Identity,
  namespace: string,
  contractStreamId: string,
  outputPayload: Record<string, unknown>
): Promise<any> {
  const txBody = {
    $namespace: namespace,
    $contract: contractStreamId,
    $i: { [identity.streamId]: {} },
    $o: { [identity.streamId]: outputPayload },
  };
  const tx = {
    $tx: txBody,
    $sigs: { [identity.streamId]: identity.keyPair.sign(txBody) },
  };
  return submit(baseUrl, tx);
}
