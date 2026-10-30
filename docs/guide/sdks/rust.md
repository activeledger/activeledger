# Rust SDK

The `activeledger` crate builds, signs and submits Activeledger transactions from Rust. It is async, pure Rust (no OpenSSL, no C toolchain, no `unsafe`) and supports `ml-dsa-65` and `secp256k1` identities. It needs Rust 1.88 or later. The SDK does not declare a minimum node version; ML-DSA-65 identities need Activeledger 4.7.0 or later, which is where post-quantum identities arrived.

This page covers version 2.x. The 0.1.x releases on crates.io share only the name.

## Install

```toml
[dependencies]
activeledger = "2"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
futures-util = "0.3"
```

The crate has no cargo features; there is nothing to switch on. It uses `rustls` for TLS. It does not bring a runtime with it, so you add `tokio` (or another runtime that `reqwest` works with) yourself.

## Quick start

Start a node, then onboard an identity and send a transaction signed by it. A contract is needed to receive the transaction; see [Sending a transaction](../transactions.md) for what the fields mean.

```rust
use activeledger::{Client, KeyPair, Object, Transaction};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new("http://localhost:5260");

    let key = KeyPair::generate()?;
    let identity = client.onboard(&key).await?;
    println!("{}", identity.stream_id);

    let tx = Transaction::builder()
        .namespace("default")
        .contract("mycontract")
        .input_with(&identity.stream_id, &key, Object::new().set("amount", 100))
        .output("someotherstream")
        .build()?;

    let response = client.submit(&tx).await?;
    if !response.committed() {
        eprintln!("{:?}", response.errors());
    }
    Ok(())
}
```

`onboard` returns an `Identity` with `stream_id` and `public_key`. It returns an error if the ledger did not create a stream.

## Keys

Two key types are supported. Both implement the `Signer` trait, so either can be passed to `onboard` and to the transaction builder. See [Identities](../identities.md) for what each type is.

| Type | Rust type | Wire string | Public key | Private key | Signature | Encoding |
|---|---|---|---|---|---|---|
| ML-DSA-65 | `KeyPair` | `ml-dsa-65` | 1952 bytes | 4032 bytes | 3309 bytes | base64 |
| secp256k1 | `Secp256k1KeyPair` | `secp256k1` | 33 or 65 bytes | 32 bytes | about 70 to 72 bytes | `0x` hex |

`rsa` and `falcon-512` are not supported. There is no Falcon key type in this crate, so there is no way to create or load one. `KeyType::Falcon512` exists only so that `recovery::derive_seed` can produce a Falcon seed.

Both types have the same shape:

```rust
use activeledger::{KeyPair, Secp256k1KeyPair};

let pq = KeyPair::generate()?;
let public = pq.public_key();                         // base64 String
let private = pq.private_key().expect("can sign");    // Option<String>
let restored = KeyPair::from_keys(&public, &private)?;
let verifier = KeyPair::from_public(&public)?;        // cannot sign
assert!(!verifier.can_sign());

let ec = Secp256k1KeyPair::generate();                // compressed public key
let ec_full = Secp256k1KeyPair::generate_with(false); // uncompressed
let ec_public = ec.public_key();                      // "0x02..."
```

`verify` is a method on both types. `sign` comes from the `Signer` trait, so add `use activeledger::Signer;`. `private_key()` returns `None` for a key made with `from_public`.

!!! warning
    secp256k1 keys are `0x`-prefixed hex, not base64. The prefix is required.

Signing with ML-DSA-65 is hedged: signing the same message twice gives different bytes. Never compare signatures for equality; verify them. secp256k1 signing is deterministic (RFC 6979, low-S). secp256k1 verification accepts high-S signatures, because the node produces them.

If you have no reason to choose ML-DSA-65, use secp256k1. Its signatures are about 22 times smaller, and every signature is stored on the ledger permanently.

## Seeds and recovery phrases

A 32-byte seed or a BIP-39 phrase gives the same identity in every Activeledger SDK, so this is how a private key moves between languages.

```rust
use activeledger::{KeyPair, Secp256k1KeyPair};

let seed = [0x11u8; 32];
let phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";

let pq = KeyPair::from_seed(&seed)?;
let pq2 = KeyPair::from_phrase(phrase, "")?;           // second argument: passphrase

let ec = Secp256k1KeyPair::from_seed(&seed, true)?;    // true = compressed
let ec2 = Secp256k1KeyPair::from_phrase(phrase, "", true)?;
```

| Call | Notes |
|---|---|
| `KeyPair::from_seed(&[u8])` | Exactly 32 bytes. |
| `Secp256k1KeyPair::from_seed(&[u8], compressed)` | 32 bytes, used directly as the private scalar. |
| `from_phrase(phrase, passphrase)` | Checks the wordlist and the checksum. |
| `Secp256k1KeyPair::from_legacy_phrase(phrase, compressed)` | Recovers a phrase made by the older `@activeledger/sdk-bip39` package. For recovery only. |

The `recovery` module exposes `validate`, `to_seed`, `seed_size` and `derive_seed`. `derive_seed` also handles `KeyType::Falcon512`, so a phrase here can produce the seed for a Falcon identity created by another SDK, even though this crate cannot sign with it.

!!! warning
    A seed of the wrong length is refused, not padded. A secp256k1 seed of zero, or at or above the curve order, is refused rather than reduced. A mistyped phrase fails the checksum instead of deriving a valid key for an identity nobody owns.

## Sending transactions

`Transaction::builder()` collects the fields, signs, and returns a `Transaction`. `build()` returns an error if the namespace, contract or any input is missing.

```rust
let tx = Transaction::builder()
    .namespace("default")
    .contract("mycontract")
    .entry("transfer")                                          // optional
    .input_with(stream_id, &key, Object::new().set("amount", 100))
    .output(other)                                              // optional
    .readonly("label", label_target)                            // optional
    .build()?;
```

| Method | Sets |
|---|---|
| `namespace`, `contract`, `entry` | `$namespace`, `$contract`, `$entry` |
| `input(stream_id, &signer)` | An entry in `$i` and a signature for it |
| `input_with(stream_id, &signer, Object)` | The same, with payload fields |
| `output(stream_id)`, `output_with(stream_id, Object)` | An entry in `$o` |
| `readonly(label, stream_id)` | An entry in `$r` |

Payloads are built with `Object`, an insertion-ordered JSON object: `Object::new().set("key", value)`. Values convert from `&str`, `String`, `bool`, `i32`, `u32`, `i64`, `f64` and nested `Object`. Order matters because the signature covers the exact bytes; see [Sending a transaction](../transactions.md).

Send it with `client.submit(&tx).await`. The `Response` has:

| Method | Returns |
|---|---|
| `committed()` | `true` when the ledger reported no errors |
| `errors()` | The messages in `$summary.errors` |
| `new_streams()` | Ids of streams the transaction created |
| `responses()` | Values the contract returned with `returnToRemote` |
| `raw()` | The body exactly as the node sent it |

`client.submit_raw(&str)` posts an envelope you built yourself. Use `Client::with_http` to supply your own `reqwest::Client` (for timeouts or proxies).

## Reading state

There is no read API. Name the streams in `$r` and have the contract hand values back with `returnToRemote`:

```rust
let tx = Transaction::builder()
    .namespace("default")
    .contract("mycontract")
    .entry("read")
    .input(stream_id, &key)
    .readonly("target", stream_to_read)
    .build()?;

let response = client.submit(&tx).await?;
for value in response.responses() {
    println!("{}", value["balance"]);
}
```

`responses()` returns `serde_json::Value` items. The contract has to be written to return something.

## Events

!!! warning
    Events are deprecated in the Rust SDK and will be removed in the next major version. ActiveCore no longer serves events, and a node's event service listens only on the node's own host, so a client has nothing to connect to. Run your own server-sent events listener on the node's host and relay what you need. The rest of this section describes the existing behaviour.

Event streams come from Activecore, which is a separate service on its own port, not from the node. Give the client its URL with `with_core`. Subscribing without it returns `ClientError::NoCoreUrl`.

```rust
use activeledger::Client;
use futures_util::StreamExt;

let client = Client::new("http://localhost:5260").with_core("http://localhost:5261");

// Every stream change on the ledger
let mut stream = Box::pin(client.subscribe_to_activity(None).await?);
while let Some(event) = stream.next().await {
    println!("{}", event?.data);
}

// One stream, or contract events (all, one contract, one named event)
let mut one = Box::pin(client.subscribe_to_activity(Some("streamid")).await?);
let mut all = Box::pin(client.subscribe_to_contract_events(None, None).await?);
let mut named = Box::pin(
    client.subscribe_to_contract_events(Some("mycontract"), Some("transfer")).await?,
);
```

Each `Event` has `data`, and `name` and `id` when the server sent them. Dropping the stream closes the connection. `Client::subscribe` takes a raw path or full URL for anything else. An event name without a contract returns `ClientError::EventWithoutContract`.

!!! warning
    Activity and contract events are different feeds. An ordinary transaction produces activity. Contract events carry only what a contract explicitly emitted, so subscribing there for a transaction that emits nothing correctly receives nothing.

## Signing elsewhere

The builder and `onboard` take anything that implements `Signer`, so keys can live in an HSM, a remote service or a wallet.

```rust
use activeledger::{KeyError, KeyPair, KeyType, Signer};

/// Wraps another signer. Replace the body of `sign` with a call to your
/// HSM or signing service.
struct AuditedSigner {
    inner: KeyPair,
}

impl Signer for AuditedSigner {
    fn key_type(&self) -> KeyType {
        KeyType::MlDsa65
    }
    fn public_key(&self) -> String {
        self.inner.public_key()
    }
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, KeyError> {
        eprintln!("signing {} bytes", message.len());
        self.inner.sign(message)
    }
}
```

`sign` receives the exact bytes of `$tx` and returns the raw signature; the SDK base64-encodes it. The SDK has no "build unsigned" step: `build()` always signs, by calling your `Signer`. A signer that calls out to another service is the way to sign elsewhere.

## Things that will bite you

- **A rejected transaction is an HTTP 200.** Check `response.committed()`, not the status. If the body is not valid JSON, `errors()` is empty and `committed()` is `true`; check `raw()` if the node might be returning something else, such as a proxy error page.
- **Every signature problem is reported as 1220 "Signature Incorrect".** Wrong key type, wrong-length key material and bad bytes all give the same message. `tx.signed_bytes()` shows exactly what was signed.
- **The builder cannot set `$expire`.** There is no method for it. A transaction sent twice runs twice; see [Sending a transaction](../transactions.md). To set it, build the `$tx` object yourself with `Object`, sign its `canonical::to_bytes` with a `Signer`, wrap it in an envelope and send it with `submit_raw`.
- **Falcon-512 is not supported.** Use `ml-dsa-65` or `secp256k1`.
- **ML-DSA-65 keys are not validated on load.** Any 1952 bytes decode to some key; a wrong key fails at verification, not at construction.
- **Namespaces are claimed permanently.** A test that registers a fixed namespace passes once and fails on re-runs against the same network.
- **Consensus is a majority.** When `submit` returns, most nodes have committed and the rest may still be writing. Reading straight away from one node is a race.
- **`serde_json` cannot produce signable bytes.** It sorts keys and writes `1.0` for `1`. Use the crate's `Object`, `Value` and `canonical` module for anything that is signed.

## Testing and further reading

```
cargo test
```

The offline tests (vectors, canonical JSON, seeds, secp256k1, builder, event parsing) run without a network. The live tests skip unless `AL_NODES` and `AL_STORAGE` point at a running network; the SDK's README explains how to start one from an `activeledger` checkout.

- Source and README: [github.com/activeledger/SDK-Rust](https://github.com/activeledger/SDK-Rust)
- Crate: [crates.io/crates/activeledger](https://crates.io/crates/activeledger), API docs on [docs.rs](https://docs.rs/activeledger)
- [Sending a transaction](../transactions.md) and [Identities](../identities.md)
