# Concepts shared by every SDK

The SDKs differ in names and style, but they do the same few jobs. This page describes those jobs once. For the wire formats themselves, see [Identities](../identities.md) and [Sending a transaction](../transactions.md).

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

## Signing is exact

A signature covers the JSON text of `$tx` exactly as it will be sent. Change the order of the keys, or the way a number is written, after signing and the signature no longer matches. Each SDK builds the text the same way (a canonical form), so a transaction signed in one language verifies the same on the node as one signed in another. If you sign somewhere else, such as a hardware module, each language page has a "Signing elsewhere" section showing how to get the exact bytes.

## Reading state

None of the SDKs has a call that reads a stream directly. To read state you send a transaction that names the stream under `$r`, or you call the node's HTTP API. See [The HTTP API](../api.md).

## Retrying and expiry

Sending the same signed transaction twice runs it twice, unless it carries `$tx.$expire`; see the warning in [Sending a transaction](../transactions.md). Most SDKs do not set `$expire` for you. The language pages say where you have to add it by hand.

## Events

Some SDKs can listen to a node's event stream. Others do not (Dart and Swift say so on their pages), and the JavaScript client for it is marked deprecated. Check the language page before you design around it.

## Where the SDKs differ

Names, async style and error handling follow each language's habits. When the READMEs and the code disagreed during the writing of these pages, the pages follow the code. If you find a place where a page and an SDK differ, trust the SDK and open an issue on the docs repository.
