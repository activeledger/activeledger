# C# / .NET SDK

The C# SDK builds, signs and submits Activeledger transactions from .NET. It is published on NuGet as `Activeledger.SDK` and targets `netstandard2.0` and `net8.0`, so modern .NET, .NET Framework, Unity and Mono all work. Its one dependency is BouncyCastle, which is pure managed code. It supports the post-quantum key types (`ml-dsa-65`, `falcon-512`) as well as `secp256k1`. The SDK does not state a minimum Activeledger node version; the key types it signs with must be ones your node accepts (see [Identities](../identities.md#key-types)).

## Install

```bash
dotnet add package Activeledger.SDK
```

On `netstandard2.0` the package also pulls in `System.Text.Json` and `Microsoft.Bcl.AsyncInterfaces`. A `net8.0` project pulls in nothing extra.

## Quick start

This onboards a new post-quantum identity, then sends a transaction signed by it. The node URL is the one from [Your first network](../first-network.md).

```csharp
using Activeledger;

using var client = new ActiveledgerClient("http://localhost:5260");

var key = KeyPair.Generate(KeyType.MlDsa65);
var identity = await client.OnboardAsync(key);

Console.WriteLine(identity.StreamId);

var tx = Transaction.Builder()
    .Namespace("default")
    .Contract("mycontract")
    .Input(identity.StreamId, identity.Signer,
        new JsonObject().Set("amount", 100))
    .Output("someotherstream")
    .Build();

var response = await client.SubmitAsync(tx);

if (!response.Committed)
{
    Console.WriteLine(string.Join(", ", response.Errors));
}
```

`OnboardAsync` throws `InvalidOperationException` if the ledger did not create a stream, so you never get an `Identity` with an empty id. `SubmitAsync` does not throw for a rejected transaction; see [Things that will bite you](#things-that-will-bite-you).

!!! warning
    `JsonObject` here is `Activeledger.JsonObject`, not a `System.Text.Json` type. See [Things that will bite you](#things-that-will-bite-you).

## Keys

`KeyType` has four values. Three can be generated and used to sign.

| `KeyType` | Wire string | Public key | Private key | Encoding |
|---|---|---|---|---|
| `MlDsa65` | `ml-dsa-65` | 1952 bytes | 4032 bytes | base64 |
| `Falcon512` | `falcon-512` | 897 bytes | 1281 bytes | base64 |
| `Secp256k1` | `secp256k1` | 33 or 65 bytes | 32 bytes | `0x` hex |
| `Rsa` | `rsa` | | | not implemented |

`KeyPair.Generate`, `Sign` and `Verify` throw `NotSupportedException` for `Rsa`. For the underlying key formats, see [Identities](../identities.md#key-types).

```csharp
var mldsa  = KeyPair.Generate(KeyType.MlDsa65);
var falcon = KeyPair.Generate(KeyType.Falcon512);
var ec     = KeyPair.Generate(KeyType.Secp256k1);                    // compressed
var ecFull = KeyPair.Generate(KeyType.Secp256k1, compressed: false); // uncompressed

string pub  = mldsa.PublicKey;   // exactly the string the ledger stores
string priv = mldsa.PrivateKey;

// Restore a stored key pair
var restored = KeyPair.FromKeys(KeyType.MlDsa65, pub, priv);

// Verify only: no private key, and Sign() throws
var verifier = KeyPair.FromPublic(KeyType.MlDsa65, pub);
Console.WriteLine(verifier.CanSign);   // False
```

`PublicKey` and `PrivateKey` are not named for an encoding because it depends on the scheme: base64 for the post-quantum keys, `0x`-prefixed hex for `secp256k1`. Put the string in a transaction as it is.

`FromKeys` needs both halves. A Falcon private key does not contain its public key, so the SDK cannot rebuild one from the private half alone.

`KeyTypes.FromWire("ml-dsa-65")` and `KeyTypes.ToWire()` convert between the enum and the wire string. `FromWire` is case-sensitive and also accepts `bitcoin` and `ethereum` as `Secp256k1`; `ToWire` always returns `secp256k1`.

## Seeds and recovery phrases

A seed gives the same identity in every Activeledger SDK, so it is the way to move a private key between languages.

```csharp
var a = KeyPair.FromSeed(KeyType.MlDsa65, seed);     // 32 bytes
var b = KeyPair.FromSeed(KeyType.Falcon512, seed);   // 48 bytes
var c = KeyPair.FromSeed(KeyType.Secp256k1, seed);   // 32 bytes, the private scalar

var d = KeyPair.FromPhrase(KeyType.MlDsa65, phrase);          // BIP-39
var e = KeyPair.FromPhrase(KeyType.Secp256k1, phrase, "pass"); // with a passphrase
```

A seed of the wrong length is refused, not padded. For `secp256k1`, a seed of zero or one at or above the curve order is refused rather than reduced. Either would otherwise give you a working key for a different identity.

`FromPhrase` checks the word list and the checksum. One phrase can back an identity of each type, because each type derives its own seed from it. `RecoveryPhrase` exposes the steps if you need them: `Validate`, `ToSeed`, `DeriveSeed` and `SeedSize`.

`KeyPair.FromLegacyPhrase(phrase)` recovers a `secp256k1` key from a phrase made by the older `@activeledger/sdk-bip39` package. It does not validate the phrase, because that package never did. Use it for recovery only.

The SDK has no function that generates a new phrase. Make one with another tool, then derive keys from it with `FromPhrase`.

## Sending transactions

`Transaction.Builder()` builds and signs in one step. Field names match [Sending a transaction](../transactions.md); the builder adds the `$` for you.

```csharp
var tx = Transaction.Builder()
    .Namespace("myorg")                      // required
    .Contract("…contract stream id…")        // required
    .Entry("transfer")                       // optional
    .Input(streamId, signer, payload)        // required, repeat for more signers
    .Output(otherStream, payload)            // optional
    .ReadOnly("label", someStreamId)         // optional
    .Build();

var response = await client.SubmitAsync(tx);
```

`Build()` throws `InvalidOperationException` if the namespace, the contract or every input is missing. Every input takes its own signer, and every signer signs the same bytes: the canonical form of `$tx`.

`Transaction.Onboard(signer)` makes the self-signed onboarding transaction (`$selfsign` true, `$sigs` keyed by the `$i` label). `client.OnboardAsync(signer)` does that and submits it. See [Identities](../identities.md#onboard-the-identity).

What comes back is a `LedgerResponse`:

| Member | What it holds |
|---|---|
| `Committed` | `true` when `$summary.errors` is empty or absent |
| `Errors` | the messages from `$summary.errors` |
| `NewStreams` | ids from `$streams.new` |
| `Responses` | the values in `$responses`, as `JsonElement` |
| `Raw` | the body as the node sent it |

`SubmitRawAsync(string body)` posts an envelope you built yourself.

## Reading state

There is no read call. Reading is a transaction: name the streams in `$r` and let the contract return values.

```csharp
using System.Text.Json;

var tx = Transaction.Builder()
    .Namespace("myorg")
    .Contract("…contract stream id…")
    .Entry("read")
    .Input(identity.StreamId, identity.Signer)
    .ReadOnly("target", streamToRead)
    .Build();

var response = await client.SubmitAsync(tx);

foreach (JsonElement value in response.Responses)
{
    Console.WriteLine(value.GetProperty("balance").GetInt32());
}
```

`Responses` has one entry per node that returned something. A missing `$r` stream does not fail the transaction; see [Sending a transaction](../transactions.md).

## Events

Event streams come from Activecore, a separate service on its own port, not from the node. Give the client its address as `coreUrl`.

```csharp
using var client = new ActiveledgerClient(
    "http://localhost:5260",
    coreUrl: "http://localhost:5261");

using var cts = new CancellationTokenSource();

// Every stream change
await foreach (var e in client.SubscribeToActivityAsync(cancellationToken: cts.Token))
{
    Console.WriteLine(e.Data);
}

// Changes to one stream
await foreach (var e in client.SubscribeToActivityAsync(streamId, cts.Token)) { }

// Events a contract emitted: all, one contract, or one named event
await foreach (var e in client.SubscribeToContractEventsAsync()) { }
await foreach (var e in client.SubscribeToContractEventsAsync("mycontract")) { }
await foreach (var e in client.SubscribeToContractEventsAsync("mycontract", "transfer")) { }
```

Each `LedgerEvent` has `Data`, and `Name` and `Id` when the server sent them. Cancelling the token closes the connection. `SubscribeAsync(pathOrUrl)` takes a raw path or absolute URL for any other event endpoint.

!!! warning
    Activity and contract events are different feeds. An ordinary transaction produces activity, not contract events. If you subscribe to contract events and the contract emitted nothing, you receive nothing, which looks like a broken subscription.

Without `coreUrl`, a subscribe call throws and names the missing setting. Pointing at the node instead returns 403.

## Signing elsewhere

The SDK needs only `ISigner`, so keys can stay in an HSM, a remote signing service or a wallet.

```csharp
public sealed class HsmSigner : ISigner
{
    public KeyType KeyType => KeyType.MlDsa65;
    public string PublicKey => "…";                    // as the ledger stores it
    public byte[] Sign(byte[] message) => RemoteSign(message);
}
```

`Sign` receives the canonical bytes of `$tx` and returns the raw signature. The SDK base64-encodes it. Pass the signer to `Input(...)` or `OnboardAsync(...)` as you would a `KeyPair`. To see what was handed to it, call `tx.SignedBytes()` on a built transaction.

## Things that will bite you

**A rejected transaction is an HTTP 200.** Check `response.Committed`. `SubmitAsync` does not throw for a ledger rejection; only `OnboardAsync` does.

**Use the SDK's JSON types for anything signed.** `System.Text.Json` escapes non-ASCII and HTML characters and does not promise key order, so it cannot reproduce the bytes the ledger signs. Payloads are built with `Activeledger.JsonObject` and `JsonArray`, which keep insertion order. The key order you write is the order that is signed.

```csharp
var payload = new JsonObject()
    .Set("zebra", 1)                                    // stays first
    .Set("alpha", "text")
    .Set("nested", new JsonObject().Set("flag", true))
    .Set("list", new JsonArray().Add(1).Add("two"));

string json = CanonicalJson.Stringify(payload);
```

Numbers follow JavaScript, so `1.0` becomes `1`. `NaN` and infinity are refused.

**Every signature fault is reported as 1220.** A wrong key type, wrong-length key and bad bytes all give the same message. `tx.SignedBytes()` and `tx.ToJson()` show what was signed and sent.

**Post-quantum signatures differ every time.** Signing the same message twice gives different bytes, so verify, never compare. `secp256k1` signing is deterministic. Falcon signatures vary in length (about 649 to 662 bytes), and `secp256k1` signatures are DER of 70 to 72 bytes. Do not size buffers or columns to a fixed length.

**The builder cannot set `$expire`.** A transaction signed by it and sent twice runs twice. See the warning in [Sending a transaction](../transactions.md). To retry safely, build the envelope yourself and use `SubmitRawAsync`.

**Each input takes one signature.** `$sigs` is a single base64 string per stream, so a stream that has several authorised keys (see [Identities](../identities.md)) cannot be signed through the builder.

**`secp256k1` keys are `0x` hex, not base64.** The SDK requires the prefix.

**The client owns its `HttpClient` unless you pass one.** It creates one with a 30 second timeout and disposes it with the client. A client you pass in is yours to dispose.

**Namespaces are claimed for good.** A test that registers a fixed namespace passes once and fails on every rerun against the same network.

## Testing and further reading

```bash
dotnet test
```

The live-network tests skip unless `AL_NODES` and `AL_STORAGE` are set to the URLs of a running test network. The test project targets `net9.0`, so you need the .NET 9 runtime to run them.

- Source and issues: <https://github.com/activeledger/SDK-CSharp>
- Package: <https://www.nuget.org/packages/Activeledger.SDK>
- [Sending a transaction](../transactions.md) and [Identities](../identities.md) for the ledger side.
