# Python SDK

`activeledger` is the Python client for Activeledger. It builds and signs transactions, and onboards identities. It needs Python 3.9 or later and, for the post-quantum key types, Activeledger 4.7.0 or later. The core uses only the standard library, so installing it never needs a C compiler; the key types that need extra packages are opt-in.

The SDK has no dependencies of its own. It does not generate or hold RSA keys (see [Keys](#keys)).

## Install

```
pip install activeledger
```

Pick the extras for the key types you use:

```
pip install 'activeledger[ec]'   # secp256k1 (python-ecdsa, pure Python)
pip install 'activeledger[pq]'   # ml-dsa-65 and falcon-512 (liboqs-python)
```

!!! warning
    `liboqs-python` does not bundle liboqs. On first import it builds liboqs from source, which needs git, CMake, a C compiler and the OpenSSL headers. If you do not need post-quantum keys, use `[ec]` and skip it. Importing `activeledger` never triggers the build; only using a post-quantum key does, and the error then names the extra.

The import root is `activeledger`. Older releases imported `activeledgerPythonSDK`; that name is gone and the API changed throughout.

## Quick start

This generates a secp256k1 key, onboards it and sends a transaction. It needs the `[ec]` extra and a node listening on port 5260.

```python
from activeledger import Activeledger, Secp256k1KeyPair, TransactionBuilder

ledger = Activeledger("http://localhost:5260")

key = Secp256k1KeyPair.generate()
identity = ledger.onboard(key)
print(identity.stream_id)

tx = (
    TransactionBuilder()
    .namespace("myorg")
    .contract(contract_id)
    .input(identity.stream_id, identity.signer, {"message": "hello"})
    .build()
)

response = ledger.submit(tx)
if not response.committed:
    raise RuntimeError(response.errors)
```

`contract_id` is the stream id of a contract you have deployed. `ledger.onboard` raises `RuntimeError` if the ledger created no identity. Save `key.private_key` somewhere safe first: it is the only way back to the identity (see [Keys](#keys)).

For post-quantum keys, swap in `KeyPair.generate(KeyType.ML_DSA_65)`, imported from `activeledger`.

## Keys

| Class | Key types | Extra | Key encoding |
|---|---|---|---|
| `Secp256k1KeyPair` | `secp256k1` | `[ec]` | `0x` hex |
| `KeyPair` | `KeyType.ML_DSA_65`, `KeyType.FALCON_512` | `[pq]` | base64 |

`KeyType` is a string enum with the wire strings `rsa`, `secp256k1`, `ml-dsa-65` and `falcon-512`. `KeyType.from_wire()` is strict and case-sensitive, except that `bitcoin` and `ethereum` parse as `secp256k1`. The SDK has no RSA key class: `KeyType.RSA` exists only so an existing RSA identity can be named. To sign for one, supply your own signer (see [Signing elsewhere](#signing-elsewhere)).

Use secp256k1 unless the identity has to outlive a quantum computer. ML-DSA-65 signatures are 3309 bytes, against roughly 70 for secp256k1, and every signature is stored on the ledger for good. See [Identities](../identities.md) for the key types and what the ledger does with them.

### secp256k1

```python
from activeledger import Secp256k1KeyPair

key = Secp256k1KeyPair.generate()                    # compressed public key
full = Secp256k1KeyPair.generate(compressed=False)   # uncompressed

key.public_key     # "0x02a1b2..." - what the ledger stores
key.private_key    # "0x..." - 32 bytes; keep it safe

restored = Secp256k1KeyPair.from_keys(key.public_key, key.private_key)
verifier = Secp256k1KeyPair.from_public_key(key.public_key)   # verify only
```

Keys must carry the `0x` prefix. Public keys are 33 bytes (compressed) or 65 bytes (uncompressed); the ledger accepts both. Signing is deterministic and low-S, and verification accepts high-S signatures, because the ledger produces them.

### Post-quantum

```python
from activeledger import KeyPair, KeyType

key = KeyPair.generate(KeyType.FALCON_512)

key.public_key          # base64, give this to the ledger
key.private_key_b64     # base64, keep this
key.key_type            # KeyType.FALCON_512

signature = key.sign(b"some bytes")
key.verify(b"some bytes", signature)     # True

same = KeyPair.from_keys(KeyType.FALCON_512, public_b64, private_b64)
checker = KeyPair.from_public(KeyType.FALCON_512, public_b64)   # verify only
```

Sizes are 1952-byte public and 4032-byte private keys for ML-DSA-65, and 897 and 1281 bytes for Falcon-512. A Falcon signature is 649 to 662 bytes, so never assume a fixed length. Signing is hedged for both schemes: two signatures over the same message differ and both verify.

`verify()` returns `False` for a malformed signature instead of raising. A verify-only pair raises `ValueError` if you ask it to sign or read its private key. `can_sign` tells you which kind you hold.

## Seeds and recovery phrases

Secp256k1 keys can be derived from a seed or a BIP-39 phrase:

```python
from activeledger import Secp256k1KeyPair

key = Secp256k1KeyPair.from_seed(seed)                     # 32 bytes
key = Secp256k1KeyPair.from_phrase(phrase)
key = Secp256k1KeyPair.from_phrase(phrase, "passphrase")
```

The same seed gives the same identity in every Activeledger SDK, so a seed is the way to move a key between languages. A seed of the wrong length is refused, not padded. For secp256k1 the seed is the private scalar, so a seed of zero, or at or above the curve order, is refused rather than reduced. The phrase is checked against the English wordlist and its checksum: a mistyped phrase raises `ValueError` instead of quietly deriving a key for an identity nobody owns.

`Secp256k1KeyPair.from_legacy_phrase()` recovers a phrase made by the older `@activeledger/sdk-bip39` package. It skips validation on purpose and is for recovery only, never for new keys.

`activeledger.recovery` also has `validate`, `to_seed` and `derive_seed`. `derive_seed` produces the seed for any of the three types, so you can derive a post-quantum seed here and use it in an SDK that can consume one.

!!! warning
    Post-quantum keys cannot be derived from a seed in this SDK. liboqs offers no seeded signature key generation, so `KeyPair.from_seed()` raises `NotImplementedError`. Generate, sign, verify and export all work; only seed recovery does not. Back up post-quantum private keys as key bytes.

## Sending transactions

`TransactionBuilder` makes a signed `Transaction`. It does not change what [a transaction](../transactions.md) is: the methods map straight onto `$namespace`, `$contract`, `$entry`, `$i`, `$o` and `$r`.

```python
from activeledger import TransactionBuilder

tx = (
    TransactionBuilder()
    .namespace("myorg")
    .contract(contract_id)
    .entry("update")
    .input(identity.stream_id, identity.signer, {"message": "hello"})
    .output(target_stream, {"amount": 10})
    .build()
)

response = ledger.submit(tx)
if not response.committed:
    raise RuntimeError(response.errors)

print(response.new_streams)   # ids of streams created
print(response.responses)     # values from returnToRemote
```

`.input()` takes the stream id, the signer and an optional payload. Each input is signed on `build()`, and `build()` raises `ValueError` if the namespace or contract is missing or no input was given. Key order is kept as you wrote it, because the signature covers the order. `Activeledger.transaction()` is a shortcut for `TransactionBuilder()`.

The builder has no method for `$expire`, and `submit` does not retry. Read the warning about repeats in [Sending a transaction](../transactions.md) before you retry anything. To post an envelope you built yourself, use `ledger.connection.submit_raw(json_string)`.

## Reading state

There is no read API. A node's storage service listens only on the node's own host, so a client cannot reach it. Read through a transaction: name streams with `.readonly()`, which fills `$r`, and have the contract return values with `returnToRemote`.

```python
tx = (
    TransactionBuilder()
    .namespace("myorg")
    .contract(contract_id)
    .input(identity.stream_id, identity.signer)
    .readonly("target", some_stream_id)
    .build()
)

for value in ledger.submit(tx).responses:
    print(value)
```

## Events

!!! warning
    Events are deprecated from SDK 1.4.0 and will be removed in the next major version. ActiveCore no longer serves events, and a node's event service listens only on the node's own host, so a client has nothing to connect to. Run your own server-sent events listener on the node's host and relay what you need. The rest of this section describes the existing behaviour.

`ledger.events.subscribe()` is a generator over the node's server-sent events. Leaving the loop closes the connection.

```python
for event in ledger.events.subscribe():
    print(event.name, event.id, event.data)
    if finished:
        break
```

Each event is a `LedgerEvent(name, data, id)`; `name` and `id` are `None` if the node did not send them. Several `data:` lines in one event are joined with newlines, comment lines such as heartbeats are ignored, and an event still pending when the stream ends is delivered. Pass a path to subscribe elsewhere, for example `subscribe("/events/mystream")`.

There is no read timeout by default, since a quiet stream is normal. The generator does not reconnect; if the connection drops, the loop ends and you resubscribe.

## Signing elsewhere

Anything with `key_type`, `public_key` and `sign(message: bytes) -> bytes` satisfies the `Signer` protocol. That covers an HSM, a remote service or a wallet, and means the core needs no crypto dependency.

```python
from activeledger import KeyType, TransactionBuilder

class HsmSigner:
    key_type = KeyType.SECP256K1

    @property
    def public_key(self):
        return my_hsm.public_key()      # "0x..." for secp256k1

    def sign(self, message: bytes) -> bytes:
        return my_hsm.sign(message)

tx = TransactionBuilder().namespace("n").contract(contract_id).input(stream_id, HsmSigner()).build()
```

`public_key` must be in the form the ledger expects for the key type: `0x` hex for secp256k1, base64 for post-quantum. `sign` returns raw signature bytes; the SDK base64-encodes them.

## Things that will bite you

- **A rejected transaction is HTTP 200.** Check `response.committed` (or `response.errors`), never the status code.
- **Signature errors are vague.** A wrong key type, a wrong-length key or a single changed byte all come back as 1220 "Signature Incorrect". The SDK checks key lengths and type strings first so most mistakes fail locally with a clear message. When you still get a 1220, compare `tx.signed_bytes()` with what you expect: signatures cover the canonical bytes of `$tx` only, not the envelope.
- **Always send the key type.** The ledger treats a missing `type` as `rsa`. The SDK always sends it; if you build an envelope by hand, do the same.
- **Do not use `json.dumps` for signed bytes.** The default escapes non-ASCII, adds spaces and prints `1.0` where JavaScript prints `1`. Use `activeledger.canonical_json` or `canonical_bytes`, which are checked against vectors from the JavaScript SDK.
- **Importing is lazy.** `from activeledger import KeyPair` works without `[pq]`; the failure (`PostQuantumUnavailable`) arrives when you first generate a key. Likewise `Secp256k1KeyPair` without `[ec]` raises `ImportError`.
- **The key is the identity.** Lose the private key (or seed) and nobody can sign for it again. [Identities](../identities.md) covers this.

## Testing and further reading

```
pip install -e '.[pq,dev]'
pytest
```

The vector tests run offline. The integration tests need a live network and skip unless `AL_NODES` is set; the README explains how to start one from an Activeledger checkout.

- Source and issues: [github.com/activeledger/SDK-Python](https://github.com/activeledger/SDK-Python)
- Package: [pypi.org/project/activeledger](https://pypi.org/project/activeledger/)
