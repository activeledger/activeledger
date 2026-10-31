# Go SDK

The Go SDK builds, signs and submits Activeledger transactions from Go. The module path is `github.com/activeledger/SDK-Golang/v2`. It needs Go 1.25 or later (the version in its `go.mod`) and, according to its README, Activeledger 4.7.0 or later, which is the release that added `ml-dsa-65`. It supports `secp256k1` and `ml-dsa-65` keys. It does not support `falcon-512` or `rsa` keys.

For what the transaction fields mean, see [Transactions](../transactions.md). For what an identity is, see [Identities](../identities.md).

## Install

```bash
go get github.com/activeledger/SDK-Golang/v2@latest
```

The `/v2` suffix is required. Go insists that a module's path carries its major version from v2 onward, so `go get github.com/activeledger/SDK-Golang` will not resolve. Imports carry it too.

| Package | Import path | What is in it |
|---|---|---|
| `activeledger` | `github.com/activeledger/SDK-Golang/v2` | `Client`, `Builder`, `Transaction`, `Object`, `Signer`, `KeyType` |
| `eckeys` | `.../v2/eckeys` | `secp256k1` keys |
| `pqkeys` | `.../v2/pqkeys` | `ml-dsa-65` keys |
| `recovery` | `.../v2/recovery` | BIP-39 phrase checking and seed derivation |

## Quick start

This creates an `ml-dsa-65` key, onboards it as a new identity and prints the identity's stream id.

```go
package main

import (
	"context"
	"fmt"

	activeledger "github.com/activeledger/SDK-Golang/v2"
	"github.com/activeledger/SDK-Golang/v2/pqkeys"
)

func main() {
	client := activeledger.NewClient("http://localhost:5260")
	ctx := context.Background()

	key, err := pqkeys.Generate()
	if err != nil {
		panic(err)
	}

	identity, err := client.Onboard(ctx, key)
	if err != nil {
		panic(err)
	}
	fmt.Println("identity:", identity.StreamID)
}
```

`NewClient` takes the address of one node and sets a 30 second timeout on ordinary requests. `Onboard` returns an error unless the reply is committed (see [Sending transactions](#sending-transactions)) and created a stream, so you never get an `Identity` with an empty `StreamID`.

## Keys

| Type | Constant | Wire string | Public key | Private key | Signature | Encoding |
|---|---|---|---|---|---|---|
| ML-DSA-65 | `KeyTypeMLDSA65` | `ml-dsa-65` | 1952 bytes | 4032 bytes | 3309 bytes | base64 |
| secp256k1 | `KeyTypeSecp256k1` | `secp256k1` | 33 or 65 bytes | 32 bytes | 68 to 71 bytes, varies | `0x` hex |

`KeyTypeRSA` and `KeyTypeFalcon512` exist as constants so that `ParseKeyType` can recognise them, but the SDK cannot create or sign with either. Asking for Falcon gives `ErrFalconUnsupported`. `ParseKeyType` is case-sensitive and also accepts `bitcoin` and `ethereum`, which it treats as `secp256k1`.

Use `secp256k1` unless the identity has to resist quantum computers. Its signatures are far smaller, and every signature is stored on the ledger for good.

```go
import "github.com/activeledger/SDK-Golang/v2/eckeys"

key, err := eckeys.Generate()            // compressed public key
full, err := eckeys.GenerateWith(false)  // uncompressed public key

public := key.PublicKey()                // "0x02a1b2…"
private, err := key.PrivateKey()

restored, err := eckeys.FromKeys(public, private) // errors if they are not a pair
verifier, err := eckeys.FromPublicKey(public) // cannot sign
```

```go
import "github.com/activeledger/SDK-Golang/v2/pqkeys"

key, err := pqkeys.Generate()

public := key.PublicKey()                // base64
private, err := key.PrivateKeyB64()

restored, err := pqkeys.FromKeys(public, private) // errors if they are not a pair
verifier, err := pqkeys.FromPublic(public)    // cannot sign

sig, err := key.Sign([]byte("some bytes"))
ok := key.Verify([]byte("some bytes"), sig)
```

`FromKeys` checks that the private key produces the public key you passed, in both packages. A mismatched pair returns an error ("private key does not match the public key") instead of a key that signs for the wrong identity. `eckeys.FromPublicKey` and `eckeys.FromKeys` also reject a public key that is not a point on the secp256k1 curve, and one whose length and SEC1 prefix disagree.

Both key pair types have `CanSign()`, `Sign`, `Verify` and `KeyType()`. `Verify` returns `false` for a malformed signature rather than an error.

!!! warning
    `secp256k1` keys are `0x`-prefixed hex, not base64, and the prefix is required. A private key must be exactly 32 bytes; a value that lost a leading zero byte is a different key. `secp256k1` signing is deterministic and low-S. Verification accepts both low-S and high-S, because nodes produce both.

## Seeds and recovery phrases

A seed is the portable form of a private key: the same seed gives the same identity in every Activeledger SDK. A BIP-39 recovery phrase is the human-friendly form of one.

```go
ec, err := eckeys.FromSeed(seed, true)            // 32 bytes; true = compressed
ec, err := eckeys.FromPhrase(phrase, "", true)    // phrase, passphrase, compressed
pq, err := pqkeys.FromSeed(seed)                  // 32 bytes
pq, err := pqkeys.FromPhrase(phrase, "")
```

- A seed of the wrong length is refused, never padded. A padded seed would be a different identity.
- For `secp256k1` the seed is the private key itself, so it must be a valid one. `FromSeed` refuses zero and values that are too large, rather than silently reducing them.
- The phrase is checked against the BIP-39 wordlist and its checksum. A mistyped phrase is an error, not a key for an identity nobody owns.
- One phrase can back both a `secp256k1` and an `ml-dsa-65` identity. Each type derives its own seed.

The `recovery` package has the lower-level pieces: `recovery.Validate(phrase)`, `recovery.ToSeed(phrase, passphrase)`, `recovery.SeedSize(keyType)` and `recovery.DeriveSeed(keyType, bip39Seed)`. `DeriveSeed` also accepts `falcon-512`, so a phrase can give you the seed of a Falcon identity made elsewhere, even though this SDK cannot sign with it.

`eckeys.FromLegacyPhrase(phrase, compressed)` recovers a phrase made by the older `@activeledger/sdk-bip39` package. It does not check the phrase, because that package never did. Use it to recover old keys, never to make new ones.

## Sending transactions

`NewBuilder` assembles the `$tx` object, signs it and returns a `*Transaction`. `Submit` posts it.

```go
tx, err := activeledger.NewBuilder().
	Namespace("mynamespace").
	Contract("mycontract").
	Entry("update").
	Input(identity.StreamID, identity.Signer,
		activeledger.NewObject().Set("message", "hello")).
	Output(target, activeledger.NewObject().Set("amount", 10)).
	Build()
if err != nil {
	panic(err)
}

response, err := client.Submit(ctx, tx)
if err != nil {
	panic(err)
}
if !response.Committed() {
	panic(response.Errors())
}

fmt.Println(response.NewStreams())  // ids of streams created
fmt.Println(response.Responses())   // values the contract returned
```

| Method | Sets |
|---|---|
| `Namespace(v)` | `$namespace`. Required. |
| `Contract(v)` | `$contract`. Required. |
| `Entry(v)` | `$entry`. Optional. |
| `Input(streamID, signer, payload)` | One entry in `$i`, and the key that signs for it. At least one is required. A `nil` payload becomes `{}`. |
| `Output(streamID, payload)` | One entry in `$o`. |
| `ReadOnly(label, streamID)` | One entry in `$r`. |

`Build` returns an error if the namespace, the contract or every signer is missing. The `$tx` keys always appear in the order `$entry` (if set), `$namespace`, `$contract`, `$i`, `$o`, `$r`, whatever order you call the methods. Streams inside `$i`, `$o` and `$r` keep the order you added them. The signature covers those exact bytes.

On the response, `Committed()` is true only when all of these hold:

- the HTTP status is 2xx
- the body is a JSON object
- it contains a `$summary` object
- `$summary.errors` is absent or empty

`Errors()`, `NewStreams()` and `Responses()` read the matching parts of the reply described in [Transactions](../transactions.md#reading-the-reply). `Raw` holds the reply text unparsed.

!!! warning
    A reply that is not a clear commit is never reported as one. A non-2xx status, a body that is empty, HTML, `[]` or `null`, and a bare `{}` or any object without `$summary` are all not committed. `Errors()` then holds an entry such as `HTTP status 502`, `response body is not a JSON object` or `response has no $summary`. These are usually a proxy or a failed node, not the ledger. The accessors never panic on such a reply: `NewStreams()` and `Responses()` return empty values. `SubmitRaw` records the HTTP status in the same way. The old rule that a commit needs a positive `commit` count no longer applies.

The SDK does not set `$expire`, so a retry of a signed transaction runs it again. See the warning in [Transactions](../transactions.md#the-shape).

## Reading state

There is no separate read call. You read a stream by naming it in `$r` and having the contract return what you need.

```go
tx, err := activeledger.NewBuilder().
	Namespace("mynamespace").
	Contract("mycontract").
	Input(identity.StreamID, identity.Signer, nil).
	ReadOnly("target", someStreamID).
	Build()
if err != nil {
	panic(err)
}

response, err := client.Submit(ctx, tx)
if err != nil {
	panic(err)
}
for _, value := range response.Responses() {
	fmt.Println(value)
}
```

The contract must return the values itself. The SDK has no helper for reading a stream directly.

## Events

!!! warning
    Events are deprecated from SDK v2.4.0 and will be removed in the next major version. ActiveCore no longer serves events, and a node's event service listens only on the node's own host, so a client has nothing to connect to. Run your own server-sent events listener on the node's host and relay what you need. The rest of this section describes the existing behaviour.

`Subscribe` opens a server-sent events stream and returns two channels. A non-2xx reply is sent on the error channel as `event stream refused: HTTP status N`. Cancel the context to close the connection.

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel()

events, errs := client.Subscribe(ctx, "/events")
for event := range events {
	fmt.Println(event.Name, event.ID, event.Data)
	if event.Name == "stop" {
		cancel()
	}
}
if err := <-errs; err != nil {
	panic(err)
}
```

An empty path means `/events`. Both channels close when the stream ends. Each `Event` has `Name`, `ID` and `Data`; several `data:` lines in one event are joined with newlines, and heartbeat comment lines are skipped. The stream has no client-side timeout, so it stays open while the node is quiet.

## Signing elsewhere

The builder accepts anything that satisfies `Signer`, so a hardware module or a remote signing service needs no change to the SDK.

```go
type Signer interface {
	KeyType() activeledger.KeyType
	PublicKey() string
	Sign(message []byte) ([]byte, error)
}
```

`PublicKey` must return the key exactly as the ledger stores it: base64 for `ml-dsa-65`, `0x` hex for `secp256k1`. `Sign` receives the exact bytes of `$tx`. For other envelopes built elsewhere, `client.SubmitRaw(ctx, body)` posts a JSON string as it is, and `tx.SignedBytes()` returns the bytes that were signed.

## Things that will bite you

- **A rejected transaction is still HTTP 200.** `Submit` returns no Go error for a rejection, and also none for a 502 or an HTML error page. Check `response.Committed()` every time, never the status code. It is false for a non-2xx status or a reply with no `$summary`; `response.Errors()` says why.
- **Do not build `$tx` with `map` or `encoding/json`.** Go maps sort their keys and `encoding/json` escapes `<`, `>` and `&`, so the bytes would differ from what the nodes verify. Use `activeledger.NewObject().Set(key, value)`, which keeps insertion order, and `activeledger.CanonicalJSON` to see the output. Whole-number floats print as integers, the way JavaScript prints them.
- **Signature failures are vague.** A wrong key type, a wrong-length key or one changed byte all come back as 1220 "Signature Incorrect". The SDK checks key lengths before sending so that these fail locally, and `tx.SignedBytes()` shows what you signed.
- **The key type is always sent.** The ledger treats a missing type as `rsa`. `Onboard` sends the type for you.
- **`falcon-512` and `rsa` cannot be used.** Use `ml-dsa-65` or `secp256k1`.
- **`Subscribe` reports connection errors on the second channel.** Read it after the first channel closes, or you will miss them.

## Testing and further reading

```bash
go test ./...
```

The unit tests run offline. The integration tests need a running network and are skipped unless `AL_NODES` is set; the repository README explains how to start one.

- Source and issues: [github.com/activeledger/SDK-Golang](https://github.com/activeledger/SDK-Golang)
- API reference: [pkg.go.dev/github.com/activeledger/SDK-Golang/v2](https://pkg.go.dev/github.com/activeledger/SDK-Golang/v2)
