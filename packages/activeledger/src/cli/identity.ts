import * as fs from "fs";
import { ActiveCrypto } from "@activeledger/activecrypto";

/**
 * A node's identity file holds its RSA identity key and, beside it, an
 * Ed25519 key it can attest with (signed votes and commit attestations).
 * Signing with it is far cheaper than RSA. It only takes effect once the
 * node's neighbourhood entry lists its public key as `attest`.
 */
export function withAttestKey(identity: any): any {
  const pair = new ActiveCrypto.KeyPair("ed25519");
  const keys = pair.generate();
  return {
    ...identity,
    attest: {
      type: "ed25519",
      prv: { pkcs8pem: keys.prv.pkcs8pem, hash: keys.prv.hash },
      pub: { pkcs8pem: keys.pub.pkcs8pem, hash: keys.pub.hash },
    },
  };
}

/**
 * Adds an attestation key to an identity file that predates it, keeping the
 * file's permissions and never leaving it half written. An identity that
 * already has one is left untouched. Returns the public key to list, and
 * whether it was just made.
 */
export function ensureAttestKey(
  file: string
): { public: string; created: boolean } | undefined {
  let identity: any;
  try {
    identity = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (identity?.attest?.pub?.pkcs8pem) {
    return { public: identity.attest.pub.pkcs8pem, created: false };
  }
  const upgraded = withAttestKey(identity);
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(upgraded), { mode });
  fs.renameSync(tmp, file);
  return { public: upgraded.attest.pub.pkcs8pem, created: true };
}
