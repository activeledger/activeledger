# Crypto

Everything key-related goes through one class, `KeyPair` (`packages/crypto/src/crypto/keypair.ts`), used both for network node identities and for signing/verifying transactions. Checked against `v4.1.0`; supersedes [`docs/en-gb/crypto.md`](../docs/en-gb/crypto.md).

## Supported key types

```ts
new ActiveCrypto.KeyPair("rsa");        // default if omitted
new ActiveCrypto.KeyPair("secp256k1");
new ActiveCrypto.KeyPair("bitcoin");    // same curve as secp256k1, different framing/compat handling
new ActiveCrypto.KeyPair("ethereum");   // same curve as secp256k1, different framing/compat handling
```

RSA signs/verifies with `RSA-SHA256`. The `bitcoin`/`ethereum`/`secp256k1` family all use the same underlying `secp256k1` curve and sign/verify with plain `sha256` — they're kept as distinct type strings because each ecosystem's tooling expects slightly different key encodings, not because the cryptography differs. There's a `compatMode` fallback (`enableCompatMode()`) for older EC key formats that don't verify cleanly on the first attempt.

## Key formats

`KeyPair`'s constructor accepts either a PEM string or a raw hex string prefixed `0x` — the latter matters for interop with Bitcoin/Ethereum tooling that doesn't speak PEM. For a raw hex key, length is the heuristic used to tell a public key from a private one (private keys are 32 bytes → 66 characters including the `0x` prefix; public keys are longer). Internally, everything normalises to PKCS8 PEM via `AsnParser` (`packages/crypto/src/crypto/asn.ts`) regardless of which format it came in as.

## Generating a key

```ts
const kp = new ActiveCrypto.KeyPair("rsa");
const { pub, prv } = kp.generate(); // bits defaults to 2048 for RSA
// pub.pkcs8pem / prv.pkcs8pem are PEM strings
```

Outside a full Node environment (the constructor checks `isFullNodeEnv()`), RSA generation falls back to a pure-JS implementation (`node-rsa`) rather than `crypto.generateKeyPairSync`. This matters for anything meant to also run in a browser/webpack context.

## Sign and verify

```ts
const sig = kp.sign(txObject);        // string | Object | Buffer all accepted
const ok = otherKp.verify(txObject, sig);
```

Both convert their input to a canonical string first (`getString()`) before hashing/signing — pass the same object shape you'll later verify against; don't pre-stringify it yourself with your own `JSON.stringify` unless you've confirmed it matches. This is also exactly what `protocol/shared.ts`'s `signatureCheck()` does to validate a transaction's `$sigs`: `key.verify(this.entry.$tx, signature)`, i.e. the entire `$tx` object is what's signed, not a subset of it.

**`verify()`'s public key parsing is cached** (`cachedVerifyKey`, keyed by the PEM it was parsed from) — this was a real performance fix from earlier `v4.1` work (commit `ffd0159`): parsing a PEM/DER into a `crypto.KeyObject` is the expensive part of a verify call, and a given `KeyPair` instance's public key is immutable, so there was no reason to re-parse it on every call. If you're instantiating a fresh `KeyPair` per verification instead of reusing one, you don't benefit from this cache — reuse the instance where you can.

## Encrypt / decrypt

`KeyPair` also exposes `encrypt()`/`decrypt()`, used when `security.encryptedConsensus` is enabled (see [configuration.md](configuration.md)) — the sending node encrypts consensus payloads so only the intended recipient can read them in transit, on top of (not instead of) `signedConsensus`'s sender-authenticity guarantee.

## Hashing

`Hash.getHash(value, algorithm = "sha256")` (`packages/crypto/src/crypto/hash.ts`), both as a static method and an instance method with the same signature. Used throughout the codebase for things like a public/private key's identity hash and a transaction's `$umid` (see [transactions.md](transactions.md)).
