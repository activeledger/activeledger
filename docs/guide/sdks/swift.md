# Swift SDK

The Swift SDK builds, signs and sends Activeledger transactions from Swift code. It is a port of the JavaScript SDK: the same key file format and byte-for-byte the same signatures, checked against the JavaScript SDK's test vectors. It ships two Swift Package Manager products: `Activeledger` (secp256k1, ML-DSA-65 and legacy RSA) and `ActiveledgerFalcon`, an add-on that brings Falcon-512 and its native code. It needs Swift 5.9 or later (`swift-tools-version: 5.9`) and supports iOS 15, macOS 12, tvOS 15, watchOS 8 and Linux. The README says the post-quantum key types need Activeledger 4.7.0 or later on the network; the SDK does not state a minimum node version for secp256k1.

## Install

The package is installed from its GitHub URL through Swift Package Manager. It is not on a package registry. The tags are `v1.0.0`, `v1.0.1` and `v1.0.2`. Add the dependency to `Package.swift`:

```swift
.package(url: "https://github.com/activeledger/SDK-Swift.git", from: "1.0.2")
```

Then add the product to your target:

```swift
.product(name: "Activeledger", package: "SDK-Swift")
```

For Falcon-512 as well, add the add-on:

```swift
.product(name: "ActiveledgerFalcon", package: "SDK-Swift")
```

In Xcode, use **File > Add Package Dependencies** and paste the repository URL.

!!! note
    The fixes described on this page for response checking, PEM handling, key validation and connection timeouts are on the `main` branch but are not in `v1.0.2`, the latest tag. Until the next tag, depend on `branch: "main"` to get them.

On Apple platforms the SDK sends requests with `URLSession`. On Linux it uses AsyncHTTPClient instead, so a Linux build also pulls in swift-nio. Apple builds do not.

## Quick start

This connects to a node, makes a key, onboards it (see [Keys, identities and namespaces](../identities.md)) and prints the new identity:

```swift
import Activeledger

let ledger = try Activeledger("http://localhost:5260")

let key = try ledger.generateKey("identity")
try await ledger.onboard(key)
print(key.identity!)   // the new identity's stream id
```

`Activeledger` holds four public handlers: `keys`, `transactions`, `payloads` and `connection`. `generateKey`, `onboard` and `send` are shorthands over them. There is also `Activeledger("http", "localhost", 5260)` for scheme, address and port separately. Both initialisers throw `ActiveledgerError.invalidArgument` if the URL is not `http` or `https`.

## Keys

A `Key` has a `name`, a `type`, a `key` holding `publicKey` and `privateKey` strings, an `identity` (nil until onboarded) and an optional `phrase`.

| `KeyType` | Wire string | Encoding | Notes |
|---|---|---|---|
| `.secp256k1` | `secp256k1` | `0x` hex | The default. Signatures are about 70 bytes. |
| `.mlDsa65` | `ml-dsa-65` | base64 | 3309-byte signatures. In the core product. |
| `.falcon512` | `falcon-512` | base64 | signatures of about 650 bytes, varying. Needs `ActiveledgerFalcon`. |
| `.rsa` | `rsa` | PEM | Legacy. Existing PEM keys sign and verify; new ones cannot be generated. |

```swift
let keys = KeyHandler()

let ec = try keys.generateKey("me")                         // secp256k1, 65-byte public key
let small = try keys.generateKey("me", compressed: true)    // 33-byte public key
let pq = try keys.generateKey("me", type: .mlDsa65)

ec.key.publicKey    // "0x04..." - this goes on the ledger
ec.key.privateKey   // keep this
```

`compressed` is ignored by the post-quantum types. `KeyType.fromWire("bitcoin")` and `"ethereum"` parse as `.secp256k1`, as the ledger treats them the same way; they are never sent.

To use Falcon-512, enable the add-on once at start-up:

```swift
import Activeledger
import ActiveledgerFalcon

ActiveledgerFalcon.enable()
let key = try keys.generateKey("me", type: .preferredPostQuantum)   // Falcon-512
```

`KeyType.preferredPostQuantum` is Falcon-512 once the add-on is enabled and ML-DSA-65 otherwise, so the same code runs either way. Asking for `.falcon512` without enabling the add-on throws `ActiveledgerError.keyTypeUnavailable`.

Save and load a key file. The format is the JavaScript SDK's, so files move between the two:

```swift
try keys.exportKey(key, to: "keys", createDir: true)   // keys/<name>.json
let loaded = try keys.importKey("keys/identity.json")
```

!!! warning
    The key file contains the private key. `exportKey` refuses to overwrite an existing file unless you pass `overwrite: true`. Keep the file out of version control.

`importKey` checks that the two halves belong together. A secp256k1 key whose public half is not a valid point, or does not match the private scalar, fails to load. So does an ML-DSA-65 pair where a test signature made with the private key does not verify under the public key. A key file with invented keys therefore no longer loads. PEM keys (RSA and older secp256k1 PEM) are not checked at import, and neither is Falcon-512 unless the add-on is enabled.

The public `Key(name:type:key:identity:phrase:)` initialiser does no checking and does not throw. If you build a `Key` by hand from stored strings, you get no consistency check; go through `importKey` or the `KeyHandler` generators when you can.

Public keys are also checked when a signature is verified. A secp256k1 public key that is off the curve, has a coordinate at or above the field prime, is the point at infinity, is all zero or uses the hybrid encoding is rejected, so `verify` returns `false`.

Why the post-quantum types are worth their size, and which to pick, is covered in [Keys, identities and namespaces](../identities.md).

## Seeds and recovery phrases

A seed or a BIP-39 phrase recreates the same identity in every Activeledger SDK.

```swift
let key = try keys.generateBip39Key("me")
print(key.phrase!)                                       // 12 words: store them

let same = try keys.restoreBip39Key("me", phrase: key.phrase!)
let withPassphrase = try keys.restoreBip39Key("me", phrase: key.phrase!, passphrase: "extra words")

let fromSeed = try keys.generateKeyFromSeed("me", seed: [UInt8](repeating: 7, count: 32))
```

Each key type derives its own seed from the phrase, so one phrase can back a secp256k1, an ML-DSA-65 and a Falcon-512 identity at once. Pass `type:` to `generateBip39Key` and `restoreBip39Key` to choose.

| Type | Raw seed length for `generateKeyFromSeed` |
|---|---|
| `.secp256k1` | 32 bytes |
| `.mlDsa65` | 32 bytes |
| `.falcon512` | 48 bytes |

!!! warning
    A seed of the wrong length is refused, not padded. A padded seed is a different identity. For secp256k1 the seed is the private scalar, so zero, or a value at or above the curve order, is also refused.

Phrases are checked against the word list and the checksum unless you pass `validate: false`. `legacy: true` recovers a phrase made by the old `@activeledger/sdk-bip39` package; it works for secp256k1 only and is for recovery, not new keys. The `Recovery` enum exposes each step (`validate`, `toSeed`, `deriveSeed`, `deriveBip32MasterKey`, `generateMnemonic`) if a recovered identity is not the one you expected.

## Sending transactions

The structure of a transaction, and what `$i`, `$o` and `$r` mean, is on [Transactions](../transactions.md). Here is how to build one in Swift. `labelledTransaction` builds a transaction with one input and signs it. The key must already be onboarded.

```swift
let tx = try ledger.transactions.labelledTransaction(
    key: key,
    namespace: "mynamespace",
    contract: "mycontract",
    inputLabel: "input",
    stream: key.identity!,
    inputData: .object([("message", .string("hello"))]),
    entry: "update",                       // optional $entry
    outputs: .object([("target-stream", .object([("amount", .integer(10))]))]))

let response = try await ledger.send(tx)
if !response.committed {
    throw ActiveledgerError.ledger(response.errors.joined(separator: "; "))
}
response.umid       // the transaction id
response.created    // [StreamRef] of streams created
response.updated    // [StreamRef] of streams updated
```

`labelledTransaction` also takes `readonly:` (`$r`) and `selfsign:`. `inputData` must be a `.object`. Swift needs labelled arguments in declaration order, so `entry:` goes before `outputs:`, then `readonly:`, then `selfsign:`. Code written with `outputs:` first will not compile.

`committed` is true only when the reply has a `$summary` object and its `errors` are absent or empty. `errors` reports a problem, rather than an empty list, when `$summary` is missing, is not an object, or has an `errors` that is not a list. So a `{}` reply or one without `$summary` is not committed, while `commit: 0` with no errors is. `committed` is always `errors.isEmpty`.

`send` throws `ActiveledgerError.http` for a non-2xx status, and throws if the body is not a JSON object. A connection that is refused fails within about 5 seconds; a request that connects but gets no answer times out after 30 seconds.

JSON values are the `JSONValue` enum: `.null`, `.bool`, `.integer(Int64)`, `.number(Double)`, `.string`, `.array` and `.object`. An object is an ordered array of `(String, JSONValue)` pairs, because the ledger does not sort keys and the signature covers the exact bytes.

For several inputs or several signers, build the `$tx` body yourself and sign it once per key:

```swift
let tx = Transaction(tx: .object([
    ("$namespace", .string("ns")),
    ("$contract", .string("c")),
    ("$i", .object([(alice.identity!, .object([])), (bob.identity!, .object([]))])),
]))
try ledger.transactions.signTransaction(tx, key: alice)
try ledger.transactions.signTransaction(tx, key: bob)
let response = try await ledger.send(tx)
```

`signTransaction` stores the signature in `$sigs` under `selfSignLabel` if you pass one, otherwise the key's identity, otherwise its name. If you change the body after signing, sign again.

## Reading state

The SDK has no read endpoint. A node's storage service listens only on the node's own host, so the SDK never talks to it. Read state the way [Transactions](../transactions.md) describes: name the streams in `readonly` (`$r`) and have the contract return values with `returnToRemote`. They arrive in `response.responses`, an array of `Any`.

```swift
let tx = try ledger.transactions.labelledTransaction(
    key: key, namespace: "mynamespace", contract: "mycontract",
    inputLabel: "input", stream: key.identity!,
    readonly: .object([("my-stream", .object([]))]))
let response = try await ledger.send(tx)
print(response.responses)
```

`response.raw` is the decoded JSON dictionary, for anything the typed accessors do not cover. `response.total`, `vote` and `commit` give the consensus totals; each is `nil` if the reply lacks it.

## Events

The Swift SDK has no event subscription. It sends transactions and reads their responses; it does not listen to a node's event stream.

## Signing elsewhere

To sign outside the process, say in a Secure Enclave or an HSM, you have two routes.

Sign the transaction bytes yourself. `signedString` is the exact string the ledger checks, and `setSignature` stores the result:

```swift
let tx = Transaction(tx: body)
let toSign = tx.signedString                        // sign this string elsewhere
tx.setSignature(base64Signature, for: key.identity!)
let response = try await ledger.send(tx)
```

Or replace the crypto for every handler. Implement the `CryptoProvider` protocol (`generate`, `generateFromSeed`, `sign` and `verify`) and pass it in: `Activeledger("http://localhost:5260", crypto: myProvider)`, `KeyHandler(crypto:)`, `TransactionHandler(crypto:)` and `PayloadHandler(crypto:)` all take one. A custom post-quantum scheme can be added with the `PostQuantumScheme` protocol and `PostQuantum.register(_:for:)`.

`PayloadHandler` signs and verifies things that are not transactions, such as an order or a login challenge:

```swift
let payloads = PayloadHandler()
let order: JSONValue = .object([("pair", .string("VNR/USDT")), ("side", .string("sell"))])
let signature = try payloads.sign(order, key: key)
let ok = payloads.verify(order, signature: signature, publicKey: key.publicKey, type: .secp256k1)
```

`verify` returns `false` for malformed input rather than throwing, including a malformed RSA PEM key. `sign` with a malformed PEM private key throws `ActiveledgerError.invalidArgument`. On Linux, swift-crypto can abort the whole process on PEM that is framed correctly but is not a real key, so the SDK checks the PEM structure first (`PEMGuard`) and only then hands it on. `try payloads.canonical(order)` is the exact string signed. It depends on key order, so store it next to the signature.

## Things that will bite you

!!! warning
    **A rejected transaction is HTTP 200.** `send` only throws `ActiveledgerError.http` for a non-2xx status. Always check `response.committed` and read `response.errors`. A reply with no `$summary` is not treated as success.

!!! warning
    **Signature errors are vague.** A wrong type string, a key of the wrong length or one stray byte in the signed text all come back as `1220 Signature Incorrect`. Compare `tx.signedString` with what you meant to sign.

- **Key order is part of the signature.** Build `$tx` with `JSONValue.object` and do not reorder it. Swift's `JSONEncoder` does not match `JSON.stringify`, so the SDK has its own `canonicalJSON`. It refuses `NaN`, infinities and integers that a JavaScript number cannot hold, rather than sign something you did not write.
- **Onboard before building transactions.** `labelledTransaction` throws `invalidArgument` if `key.identity` is nil.
- **Onboarding keys on the key name.** The onboarding transaction uses `key.name` as its `$i` label, and `onboard` throws `ActiveledgerError.onboard` if the reply is not committed or the ledger creates no stream.
- **Onboarding does not check `committed`.** `onboard` only requires that a stream was created. It sets `key.identity` from the first created stream and returns the response without checking `committed`, so a reply that creates a stream but also lists errors is accepted. This is a known gap. Check `committed` on the response `onboard` returns if that matters to you.
- **The key type is always sent.** The ledger treats a missing `type` as `rsa`; the SDK never omits it, so do the same if you build an envelope by hand.
- **Falcon needs enabling.** Call `ActiveledgerFalcon.enable()` once, or `.falcon512` throws `keyTypeUnavailable`.
- **Falcon signatures vary in length.** Never assume a fixed width.
- **`Key` is a class.** `onboard` sets `key.identity` on the object you pass.
- **Signing is not constant across schemes.** secp256k1 signatures are deterministic; post-quantum signatures are hedged, so two signatures over one message differ and both verify.

## Testing and further reading

```
swift test
```

The unit tests run offline against the cross-language vectors in the SDK's `vectors/` directory. `LiveNetworkTests` runs the full lifecycle against real nodes and skips unless `AL_NODES` is set; see the SDK README for how to start a local network and set it. `swift run Example [nodeURL] [keyType]` runs a small end-to-end demo against a node.

The source, README and issue tracker are at [github.com/activeledger/SDK-Swift](https://github.com/activeledger/SDK-Swift).
