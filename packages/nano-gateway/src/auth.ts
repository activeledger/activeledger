/*
 * MIT License (MIT)
 * Copyright (c) 2026 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveDSConnect } from "@activeledger/activeoptions";
import { Allowlist } from "./allowlist";
import { looksLikeDoc } from "./routes/stream";

/** Matches the (loosely typed, not in @activeledger/activedefinitions) shape of meta.authorities - see packages/contracts/src/stream.ts's addAuthority()/ILedgerAuthority. */
interface IMetaAuthority {
  public: string;
  type: string;
}

export interface IAuthResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies a nano client's signed connection handshake:
 *   x-nano-identity:  the identity stream id it onboarded on this ledger
 *   x-nano-timestamp: unix ms, must be within authWindowSeconds of now (anti-replay)
 *   x-nano-signature: signature over `${identity}:${timestamp}`
 *
 * Three checks, in order (cheapest/most likely-to-fail first, so a bad
 * actor doesn't get a free DB read before failing the allowlist check):
 * allowlist membership -> timestamp freshness -> signature verifies
 * against a public key actually read live off this identity's own
 * `:stream` meta doc (not a key handed to the gateway out of band - the
 * ledger itself is the source of truth for what a nano's current keys
 * are, same as PermissionsChecker's own signature checks use).
 */
export async function verifyHandshake(
  headers: { identity?: string; timestamp?: string; signature?: string },
  allowlist: Allowlist,
  db: ActiveDSConnect,
  authWindowSeconds: number
): Promise<IAuthResult> {
  const { identity, timestamp, signature } = headers;
  if (!identity || !timestamp || !signature) {
    return { ok: false, reason: "missing x-nano-identity/x-nano-timestamp/x-nano-signature headers" };
  }

  if (!allowlist.isApproved(identity)) {
    return { ok: false, reason: "identity is not on the allowlist" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > authWindowSeconds * 1000) {
    return { ok: false, reason: "timestamp is missing, invalid, or outside the allowed window" };
  }

  let meta: { authorities?: IMetaAuthority[] };
  try {
    const doc = await db.get(`${identity}:stream`);
    // ActiveRequest.send() never rejects on non-2xx (this session's own
    // earlier finding) - a missing key on the self-hosted backend resolves
    // with a LevelDB error object instead of throwing. See routes/stream.ts's
    // looksLikeDoc() doc comment for the full explanation.
    if (!looksLikeDoc(doc)) {
      return { ok: false, reason: "identity has no on-ledger record" };
    }
    meta = doc as { authorities?: IMetaAuthority[] };
  } catch {
    return { ok: false, reason: "identity has no on-ledger record" };
  }

  const authorities = meta.authorities ?? [];
  if (authorities.length === 0) {
    return { ok: false, reason: "identity has no registered authorities on-ledger" };
  }

  const payload = `${identity}:${timestamp}`;
  for (const authority of authorities) {
    try {
      const key = new ActiveCrypto.KeyPair(authority.type, authority.public);
      if (key.verify(payload, signature)) {
        return { ok: true };
      }
    } catch {
      // Try the next authority - a malformed key on one authority shouldn't fail every check.
    }
  }

  return { ok: false, reason: "signature did not verify against any of the identity's registered authorities" };
}
