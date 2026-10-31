# Concepts shared by every SDK

The SDKs differ in names and style, but they do the same few jobs. This page describes those jobs once. For the wire formats themselves, see [Identities](../identities.md) and [Sending a transaction](../transactions.md).

!!! note "Which version these pages describe"
    The behaviour on these pages is what the SDK source did on 31 October 2026. Some of it, for example how a reply is judged to be committed and the checks on imported keys, is in each SDK's next release and not in the versions on the package registries on that date. If you are on an older release, treat a reply that is empty, not JSON, or not a 2xx status as a failure yourself, and check imported keys before you trust them. Each language page says where its behaviour changed.

## What an SDK does

1. **Makes keys.** It generates a key pair, or loads one you saved earlier.
2. **Onboards an identity.** It sends the public key to a node, and the node answers with the stream id of your new identity. See [Identities](../identities.md).
3. **Builds and signs transactions.** You give it the namespace, contract and inputs; it signs the `$tx` object with your key and fills in `$sigs`. See [Sending a transaction](../transactions.md).
4. **Sends them.** It posts the transaction to a node and gives you the reply.

## Keys

All the SDKs can sign with `secp256k1` and `ml-dsa-65`. `falcon-512` is available in most, sometimes through an add-on package or an optional dependency; the language page says how. None of them can generate an `rsa` key. Some list RSA as a key type that exists but cannot be used, and in Dart and Swift an existing RSA key can be loaded to sign. If you need RSA, see the [key types table](../identities.md).

The post-quantum types need Activeledger 4.7.0 or later on the node. Their signatures are much larger than `secp256k1` signatures, and every signature is stored on the ledger for good.

!!! warning
    Keep the private key somewhere safe. The ledger only ever holds the public key, so a lost private key cannot be recovered from the network.

When you load or import a key, the SDKs check it rather than trust it. A `secp256k1` public key that is not a point on the curve is rejected, in both the compressed and the uncompressed form. Where a loader takes a private and a public key together, it checks that they belong together and fails if they do not, by deriving one from the other for `secp256k1` and by signing and verifying a test message for the post-quantum types. The language pages name the loaders and the error each one raises. Loading a post-quantum pair this way needs the post-quantum library to be present.

## Signing is exact

A signature covers the JSON text of `$tx` exactly as it will be sent. Change the order of the keys, or the way a number is written, after signing and the signature no longer matches. Each SDK builds the text the same way (a canonical form), so a transaction signed in one language verifies the same on the node as one signed in another. If you sign somewhere else, such as a hardware module, each language page has a "Signing elsewhere" section showing how to get the exact bytes.

## Replies and `committed`

A node answers a rejected transaction with HTTP 200 and the reason in `$summary.errors`, so the status code alone tells you nothing. Every SDK gives you a response with a `committed` result, and it is true only when all of these hold:

1. the HTTP status is 2xx;
2. the body is a JSON object;
3. the body has a `$summary` object;
4. `$summary.errors` is absent or empty.

A reply that is empty, is not JSON, is an HTML error page from a proxy, is `null`, is a list, is `{}`, or has no `$summary` is therefore not committed. `$summary.commit` is not part of the test. Onboarding also needs the new stream id in the reply.

How a failure reaches you differs by SDK:

- **Python, Go, Rust, PHP, C# and the JVM SDK** give you a response that is not committed and carries an error entry saying why, such as "HTTP status 502" or "response has no $summary". Reading it never throws or panics.
- **JavaScript, Dart and Swift** throw for a non-2xx status. JavaScript also throws for a 2xx reply with no `$summary`, and Dart throws for a 2xx body that is not JSON. A 200 reply of `{}` gives Dart and Swift a response with `committed` false.

The language page has the exact exception names.

!!! warning
    Always check `committed`. Do not infer success from the absence of an exception.

## Reading state

None of the SDKs has a call that reads a stream directly. To read state you send a transaction that names the stream under `$r`, or you call the node's HTTP API. See [The HTTP API](../api.md).

## Retrying and expiry

Sending the same signed transaction twice runs it twice, unless it carries `$tx.$expire`; see the warning in [Sending a transaction](../transactions.md). Most SDKs do not set `$expire` for you. The language pages say where you have to add it by hand.

## Events

The event clients in the SDKs (Python, Go, JVM, PHP, C#, Rust, JavaScript) are deprecated and will be removed in the next major version. ActiveCore no longer serves events, and a node's event service listens only on the node's own host, so a client has nothing to connect to. Dart and Swift have no events client. To react to events, run your own server-sent events listener on the node's host and relay what you need; see [The HTTP API](../api.md#events-get-activeledgereventsevents).

## Where the SDKs differ

Names, async style and error handling follow each language's habits. When the READMEs and the code disagreed during the writing of these pages, the pages follow the code. If you find a place where a page and an SDK differ, trust the SDK and open an issue on the docs repository.
