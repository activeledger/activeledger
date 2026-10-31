# JVM SDK (Kotlin and Java)

The JVM SDK is one library for Kotlin, Java and Android. It is published to Maven Central as `io.github.activeledger:activeledger`. It needs JDK 11 or later (Android: `minSdk` 26) and Activeledger 4.7.0 or later, which is the first release that accepts `ml-dsa-65` and `falcon-512`. It is licensed under MIT.

It builds transactions, signs them, submits them to a node and listens for events. Key types are explained in [Identities](../identities.md) and the transaction shape in [Transactions](../transactions.md); this page covers only the SDK calls.

## Install

Gradle (Kotlin DSL):

```kotlin
dependencies {
    implementation("io.github.activeledger:activeledger:1.0.0")
}
```

Maven:

```xml
<dependency>
  <groupId>io.github.activeledger</groupId>
  <artifactId>activeledger</artifactId>
  <version>1.0.0</version>
</dependency>
```

The published metadata pulls in BouncyCastle 1.85.2, OkHttp 4.12.0, kotlinx-coroutines 1.9.0 and Gson 2.11.0. If you add the bare jar by hand, declare these yourself or you will get `NoClassDefFoundError` at run time. The 1.0.0 POM lists them with runtime scope, so a Maven build must also declare Gson, OkHttp and kotlinx-coroutines itself to compile against `responses()`, `Connection(baseUrl, OkHttpClient)` or `Flow`.

!!! warning
    BouncyCastle 1.84 or later is required. If another dependency in your build pins an older BouncyCastle, ML-DSA fails at run time with `NoClassDefFoundError: org/bouncycastle/crypto/generators/MLDSAKeyPairGenerator`, not at compile time. Override the version upwards (`org.bouncycastle:bcprov-jdk18on:1.85.2`).

!!! note
    Maven Central currently serves only 1.0.0. The source is at 1.1.0 plus fixes that have been merged but not released. Where this page says "from the next release", that behaviour is in the source on `master` and not in the 1.0.0 jar you can download today. Check that the version you use includes it before you rely on it.

!!! note
    The 1.0.0 POM on Maven Central wrongly names the licence as Apache 2.0. The SDK is MIT, as its `LICENSE` file says. Later versions declare it correctly.

## Quick start

This onboards a new post-quantum identity, then sends a transaction signed by it. Replace `mynamespace` and `mycontract` with your own namespace and contract (see [Transactions](../transactions.md)). The calls are `suspend` functions, so run them from a coroutine.

```kotlin
import io.activeledger.sdk.Activeledger
import io.activeledger.sdk.crypto.KeyPair
import io.activeledger.sdk.crypto.KeyType
import io.activeledger.sdk.tx.Transaction

suspend fun main() {
    val ledger = Activeledger("http://localhost:5260")

    val key = KeyPair.generate(KeyType.ML_DSA_65)
    val identity = ledger.connection.onboard(key)
    println("identity: ${identity.streamId}")

    val tx = Transaction.builder()
        .namespace("mynamespace")
        .contract("mycontract")
        .input(identity.streamId, identity.keyPair, mapOf("message" to "hello"))
        .build()

    val response = ledger.connection.submit(tx)
    check(response.committed) { "rejected: ${response.errors}" }
}
```

The same thing from Java uses `ActiveledgerClient`, which blocks instead of suspending:

```java
import io.activeledger.sdk.Identity;
import io.activeledger.sdk.LedgerResponse;
import io.activeledger.sdk.crypto.KeyPair;
import io.activeledger.sdk.crypto.KeyType;
import io.activeledger.sdk.java.ActiveledgerClient;
import io.activeledger.sdk.tx.Transaction;

try (ActiveledgerClient client = new ActiveledgerClient("http://localhost:5260")) {
    KeyPair key = KeyPair.generate(KeyType.FALCON_512);
    Identity identity = client.onboard(key);

    Transaction tx = Transaction.builder()
            .namespace("mynamespace")
            .contract("mycontract")
            .input(identity.getStreamId(), identity.getKeyPair())
            .build();

    LedgerResponse response = client.submit(tx);
    if (!response.getCommitted()) {
        throw new IllegalStateException("rejected: " + response.getErrors());
    }
}
```

`Activeledger(baseUrl)` gives you `connection` (submit and onboard) and `events` (deprecated). `onboard` returns an `Identity(streamId, keyPair)`, and throws `IllegalStateException` if the node did not create a stream. Check `response.committed` after `submit`, as above; see the rule under Sending transactions.

## Keys

`KeyType` is an enum. `KeyType.fromWire("ml-dsa-65")` goes the other way, and also accepts the `bitcoin` and `ethereum` aliases for `secp256k1`.

| `KeyType` | Wire string | Generate with |
|---|---|---|
| `ML_DSA_65` | `ml-dsa-65` | `KeyPair.generate(KeyType.ML_DSA_65)` |
| `FALCON_512` | `falcon-512` | `KeyPair.generate(KeyType.FALCON_512)` |
| `SECP256K1` | `secp256k1` | `KeyPair.generate(KeyType.SECP256K1)` or `KeyPair.generateSecp256k1(compressed = false)` |
| `RSA` | `rsa` | Not supported |

`RSA` exists in the enum so that a type string round-trips, but this SDK cannot generate, sign with or verify RSA keys: those calls throw `UnsupportedOperationException`. If your identity uses RSA, sign elsewhere (see below) or choose another type.

Load and save keys as strings:

```kotlin
val pub = key.exportPublic()
val prv = key.exportPrivate()

val loaded = KeyPair.fromKeys(KeyType.ML_DSA_65, pub, prv)
val verifyOnly = KeyPair.fromPublic(KeyType.ML_DSA_65, pub)
```

The post-quantum types are base64 of the raw key bytes. `secp256k1` is `0x`-prefixed hex; the prefix is required. Lengths are checked on load and a wrong one throws `IllegalArgumentException` naming the problem. `canSign` is false for a key made with `fromPublic`, and `sign` then throws. `verify(message, signature)` returns a boolean.

!!! warning
    From the next release, `fromKeys` checks that the public and private key belong together and throws `IllegalArgumentException` if they do not. For `secp256k1` it derives the public key from the private scalar and compares; for ML-DSA-65 and Falcon-512 it signs a fixed message and verifies it. In 1.0.0 only the lengths were checked, so a mismatched pair loaded fine, signed fine, and was rejected by the ledger as `1220 Signature Incorrect`. `fromPublic` cannot do this check, because it has no private key.

From the next release, a `secp256k1` public key that is the right length and prefix but is not a point on the curve is also rejected, by `fromPublic` and `fromKeys`, with `IllegalArgumentException`. `secp256k1` hex must contain only hex digits; a sign character or non-ASCII digit that 1.0.0 might have decoded is now refused.

`generateSecp256k1(compressed = true)` makes a 33-byte public key, which is the default. `compressed = false` makes the 65-byte form. The ledger accepts both.

## Seeds and recovery phrases

A seed is the portable private key: the same seed gives the same identity in every Activeledger SDK.

```kotlin
val a = KeyPair.fromSeed(KeyType.ML_DSA_65, seed32)    // 32 bytes
val b = KeyPair.fromSeed(KeyType.FALCON_512, seed48)   // 48 bytes
val c = KeyPair.fromSeed(KeyType.SECP256K1, seed32)    // 32 bytes, the private scalar

val d = KeyPair.fromPhrase(KeyType.ML_DSA_65, phrase)
val e = KeyPair.fromPhrase(KeyType.SECP256K1, phrase, "passphrase")
val f = KeyPair.fromLegacyPhrase(oldPhrase)            // secp256k1 only
```

- A seed of the wrong length is refused, never padded. A `secp256k1` seed of zero, or at or above the curve order, is refused rather than reduced.
- A phrase is BIP-39 (12, 15, 18, 21 or 24 words). Both the word list and the checksum are checked, so a mistyped phrase throws instead of deriving a key for an identity nobody owns.
- One phrase can back all three key types, because each derives its own seed. `RecoveryPhrase.seedSize(type)` returns the seed length.
- `fromLegacyPhrase` recovers a phrase made by the older `@activeledger/sdk-bip39` package. Use it for recovery only.

The SDK does not generate new phrases. Make one with another BIP-39 tool, or keep the key and export it.

## Sending transactions

`Transaction.builder()` collects the fields and signs on `build()`. The builder methods map to the fields in [Transactions](../transactions.md).

| Builder method | Sets |
|---|---|
| `namespace(String)` | `$namespace` (required) |
| `contract(String)` | `$contract` (required) |
| `entry(String)` | `$entry` |
| `input(streamId, keyPair, payload = emptyMap())` | An entry in `$i`, and the key that signs for it |
| `output(streamId, payload = emptyMap())` | An entry in `$o` |
| `readonly(label, streamId)` | An entry in `$r` |

`build()` throws `IllegalStateException` if namespace or contract is missing, and `IllegalArgumentException` if there is no input. Each input gets its own signature, so a transaction with several inputs needs a key for each.

Payload values may be `String`, `Int`, `Long`, `Double`, `Boolean`, `null` or a `JsonObject` (from `io.activeledger.sdk.json`). Anything else, including nested `Map` and `List`, throws. Build nested data as a `JsonObject`; what is signed is exact bytes, so the SDK does not guess a conversion.

`$expire` is not available on the builder. If you need it to stop a retry running twice (see [Transactions](../transactions.md)), build the JSON yourself and send it with `submitRaw` (see Signing elsewhere).

`submit` returns a `LedgerResponse`:

| Member | Meaning |
|---|---|
| `committed` | `true` only if the reply is a commit (see below) |
| `errors` | The error strings from the reply summary, plus an entry for each reason the reply is not a commit |
| `newStreams` | Ids of streams the transaction created |
| `responses()` | Whatever the contract returned with `returnToRemote` |
| `raw` | The reply body as received |

Java uses `getCommitted()`, `getErrors()`, `getNewStreams()`, `responses()` and `getRaw()`.

!!! warning
    From the next release, a reply counts as committed only if all of these hold: the HTTP status is 2xx, the body is a JSON object, the body has a `$summary` object, and `$summary.errors` is absent or empty. Anything else is not committed and `errors` has an entry saying why, for example `HTTP 502`, `response is not a JSON object` or `response has no $summary`. That covers an empty body, `{}`, `null`, an array and a proxy's HTML error page. The getters never throw on a bad body.

    In 1.0.0 `committed` was simply "no errors in `$summary`". A `{}` reply or one with no `$summary` counted as committed, a non-2xx status was ignored, and a body that was not a JSON object made the getters throw. Do not treat a missing `$summary` as success on 1.0.0; check `response.raw` yourself.

`onboard` throws `IllegalStateException` (with the reply in the message) when the reply names no new stream, so an onboarding that did not happen cannot hand you an empty identity.

## Reading state

The SDK has no separate read call. A node's storage service is only reachable from the node's own host, so reads go through a transaction: name the streams in `$r` and have the contract return what you want.

```kotlin
val tx = Transaction.builder()
    .namespace("mynamespace")
    .contract("mycontract")
    .input(identity.streamId, identity.keyPair)
    .readonly("target", someStreamId)
    .build()

val response = ledger.connection.submit(tx)
response.responses().forEach { println(it) }
```

`responses()` returns Gson `JsonObject`s.

## Events

!!! warning
    Events are deprecated from SDK 1.1.0 (tagged but not yet on Maven Central) and will be removed in the next major version. ActiveCore no longer serves events, and a node's event service listens only on the node's own host, so a client has nothing to connect to. Run your own server-sent events listener on the node's host and relay what you need. The rest of this section describes the existing behaviour, including fixes that are in the source but not yet released.

In Kotlin, `ledger.events.subscribe()` returns a `Flow<LedgerEvent>` over the node's server-sent events endpoint (`/events` by default; pass another path to change it). Collecting starts the connection and cancelling the collector closes it. From the next release this works as described. In 1.0.0 the blocking read ran before the cancellation hook was reached, so cancelling did not interrupt a read that was waiting for the next event.

```kotlin
ledger.events.subscribe().collect { event ->
    println("${event.name}: ${event.data}")
}
```

`LedgerEvent` has `name`, `data` (the raw string) and `id`; `name` and `id` can be null. The data is not parsed for you.

In Java, pass a listener. `subscribe` returns a `Subscription`, which you close to stop:

```java
try (var subscription = client.subscribe(event ->
        System.out.println(event.getName() + ": " + event.getData()))) {
    Thread.sleep(10_000);   // throws InterruptedException: catch it or declare it
}
```

An overload takes a path as the second argument. From the next release:

- A non-2xx reply fails the flow with an `IOException` ("Event stream returned HTTP 404"). In 1.0.0 the body of an error reply was read as if it were events.
- There is no read timeout on the stream, so a quiet stream stays open.
- `Subscription.close()` cancels the stream and then waits up to 5 seconds for the connection to be released. Called from inside the listener it does not wait.
- Only one leading space after `event:`, `id:` and `data:` is removed, as the server-sent events specification says. 1.0.0 trimmed all surrounding whitespace.

If the stream ends, the flow completes (or fails with an error if the connection broke) and the Java listener simply stops receiving; reconnecting is up to you.

## Signing elsewhere

There is no signer callback, so the builder cannot hand the signing to a hardware module or another service. You can still do it by hand:

1. Build the `$tx` body as a `JsonObject` and get the exact bytes to sign with `CanonicalJson.bytes(body)`. (For a transaction you built normally, `signedBytes()` gives the same bytes.)
2. Sign those bytes elsewhere and base64 the signature.
3. Assemble the envelope (`$tx`, `$sigs`, and `$selfsign` when onboarding) and send it with `submitRaw(json)`. Java has `client.submitRaw(json)` too.

Sign the same bytes you send. The ledger checks the signature against the exact JSON string, so do not reformat the body between steps 1 and 3. Use `KeyPair.fromPublic` and `verify` to check a signature you got back before you send it.

## Things that will bite you

- **A rejected transaction is HTTP 200.** Check `response.committed`, not the status code. From the next release a non-2xx status or a reply without `$summary` is also not committed.
- **A mismatched key pair is caught late on 1.0.0.** Until `fromKeys` verifies the pair (next release), the ledger reports it as `1220`.
- **Errors are vague.** A wrong type string, a wrong-length key or a signature that is one byte out all appear as `1220 Signature Incorrect`. The SDK validates key lengths and type strings first, so most of these fail locally with a clearer message.
- **Always send the key type.** The ledger treats a missing `type` as `rsa`. The SDK always sends it; if you build an envelope by hand, do the same.
- **Falcon and secp256k1 signatures vary in length.** Do not assume a fixed size.
- **Post-quantum signing is hedged.** Two signatures over the same message differ, and both verify. `secp256k1` signing is deterministic and low-S.
- **Keys and seeds are secrets.** `exportPrivate()` returns the private key as a plain string. Do not log it.
- **Blocking from Java.** `ActiveledgerClient` blocks the calling thread with `runBlocking`. Do not call it from an Android main thread.
- **Timeouts.** The default OkHttp client uses a 10 second connect timeout and a 30 second read timeout. Pass your own `OkHttpClient` to `Connection(baseUrl, client)` to change that. `Activeledger` and `ActiveledgerClient` do not take one. The events client ignores the read timeout (next release).
- **Payload numbers become JSON doubles.** `Int` and `Long` are written the way JavaScript's `JSON.stringify` would write them, which matters for very large integers.

## Testing and further reading

The unit tests run offline with `./gradlew build`, which also runs the Android API 26 check. The integration tests need a live network and are skipped unless `AL_NODES` is set. The signing and canonical JSON code is checked against test vectors generated by the JavaScript SDK.

- Source and issues: [github.com/activeledger/SDK-JVM](https://github.com/activeledger/SDK-JVM)
- Package: [Maven Central](https://central.sonatype.com/artifact/io.github.activeledger/activeledger)
- The wider guide: [Transactions](../transactions.md) and [Identities](../identities.md)
