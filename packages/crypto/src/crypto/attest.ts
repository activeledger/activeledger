/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
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

import { KeyPair } from "./keypair";
import { Hash } from "./hash";

/**
 * Stable JSON: object keys sorted at every depth, so the same data always
 * hashes the same on every node.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
};

/**
 * Identifier for a key in signed requests and the registry: sha256 of its PEM
 */
export const keyHash = (publicPem: string): string => Hash.getHash(publicPem);

/**
 * Name of a hybrid's registry stream, `activeledger.default.hybrid.<keyhash>`
 */
export const hybridStreamName = (publicPem: string): string =>
  `activeledger.default.hybrid.${keyHash(publicPem)}`;

/**
 * Id of a hybrid's registry stream. `default/hybrid` creates it with the
 * keyhash as the deterministic seed, and an Activity id is
 * sha256(seed + name), so any node or hybrid can derive it from the key alone.
 */
export const hybridStreamId = (publicPem: string): string =>
  hybridStreamIdFromKeyHash(keyHash(publicPem));

/**
 * The same id from the key hash alone, for a supernode that is handed the
 * hash in a signed request and looks the stream up before it has the key.
 */
export const hybridStreamIdFromKeyHash = (hash: string): string =>
  Hash.getHash(hash + `activeledger.default.hybrid.${hash}`, "sha256");

/**
 * Signed requests: a signature over `${key}:${timestamp}` made with the
 * caller's registered key. Used by /h/* and by nano-gateway.
 */
export interface SignedRequest {
  key: string;
  timestamp: number;
  signature: string;
}

export const signRequest = (
  pair: KeyPair,
  key: string,
  timestamp: number = Date.now()
): SignedRequest => ({
  key,
  timestamp,
  signature: pair.sign(`${key}:${timestamp}`),
});

/**
 * True when the signature verifies and the timestamp is within the window
 * (anti-replay). Never throws: a malformed key or signature is just false.
 */
export const verifyRequest = (
  publicPem: string,
  type: string,
  request: SignedRequest,
  windowSeconds: number,
  now: number = Date.now()
): boolean => {
  const ts = Number(request.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > windowSeconds * 1000) {
    return false;
  }
  try {
    return new KeyPair(type, publicPem).verify(
      `${request.key}:${request.timestamp}`,
      request.signature
    );
  } catch {
    return false;
  }
};

/**
 * Vote attestation: what a supernode signs when it votes,
 * H(umid | vote | $revs).
 */
export const voteDigest = (
  umid: string,
  vote: boolean,
  revs: unknown
): string => Hash.getHash(`${umid}|${vote}|${canonicalJson(revs)}`);

export interface RevOut {
  rev: string;
  sha256: string;
}

/**
 * Commit attestation: what a supernode signs after it commits,
 * H(umid | outcome | $revs | revsOut | umidDocHash).
 */
export const commitDigest = (
  umid: string,
  outcome: string,
  revs: unknown,
  revsOut: Record<string, RevOut>,
  umidDocHash: string
): string =>
  Hash.getHash(
    `${umid}|${outcome}|${canonicalJson(revs)}|${canonicalJson(
      revsOut
    )}|${umidDocHash}`
  );

export const signDigest = (pair: KeyPair, digest: string): string =>
  pair.sign(digest);

export const verifyDigest = (
  publicPem: string,
  type: string,
  digest: string,
  signature: string
): boolean => {
  try {
    return new KeyPair(type, publicPem).verify(digest, signature);
  } catch {
    return false;
  }
};
