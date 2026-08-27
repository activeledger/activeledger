# Transactions

A transaction is a single JSON document POSTed to any node's root URL (`http://<host>:<port>/`, handled by `Endpoints.ExternalInitalise` in `packages/network/src/network/endpoints.ts`). The node that receives it becomes the origin and starts the gossip/vote/commit cycle described in [architecture.md](architecture.md).

## Shape

```json
{
  "$tx": {
    "$namespace": "default",
    "$contract": "onboard",
    "$i": {
      "<streamId>": {
        "publicKey": "<PEM public key>",
        "type": "rsa"
      }
    },
    "$o": {}
  },
  "$selfsign": true,
  "$sigs": {
    "<streamId>": "<base64 signature of the $tx object>"
  }
}
```

- **`$tx.$namespace`** / **`$tx.$contract`** — which deployed contract handles this transaction. `default`/`onboard` is the contract bundled with every node, for registering new identities.
- **`$tx.$i`** / **`$tx.$o`** — input and output streams. Each key is a stream ID the transaction reads or writes; the contract decides what those keys mean.
- **`$sigs`** — one signature per stream ID referenced in `$i`, covering the entire `$tx` object (not just that stream's portion of it). The signing key must correspond to the identity already on that stream — except for onboarding, see below.
- **`$selfsign`** — set when a brand-new identity is authorising its own onboarding transaction. There's no existing ledger authority to sign against yet, so the transaction is signed by the very key it's registering.

The signature itself is `KeyPair.sign($tx)` (`packages/crypto/src/crypto/keypair.ts`) — RSA-SHA256 over the JSON-stringified `$tx` object, base64-encoded. If you're generating transactions programmatically, use the real `ActiveCrypto.KeyPair` class from `@activeledger/activecrypto` rather than reimplementing the signing scheme — the exact stringification it uses to turn an object into signable bytes isn't guaranteed to match a naive `JSON.stringify` in ordering or formatting, and using the real class guarantees compatibility with what the network's `signatureCheck` (`protocol/shared.ts`) verifies against.

## What the node adds server-side

The origin node fills in a few fields before broadcasting: `$datetime` (unless `$tx.$expire` is set and hasn't passed), `$umid` (a hash of the whole transaction, used for dedup — a second submission of the identical transaction is rejected as already existing), `$origin` (this node's reference), `$remoteAddr`, and `$broadcast: true` unless territoriality is already set.

## Response

On success:

```json
{
  "$umid": "e0b99c48b1547389a8a71b0543a9b95dfd9c4991989419959242a67ca5e4d356",
  "$summary": {
    "total": 30,
    "vote": 30,
    "commit": 30
  },
  "$streams": {
    "new": [
      { "id": "aedc2f06256a284c9f0be7ba914bf8c80d7fb765d489c2387be1b1d674776180", "name": "activeledger.default.identity.name" }
    ],
    "updated": []
  }
}
```

`$summary` reports how many nodes voted and committed out of the total participating. The new stream ID under `$streams.new` is what you reference as `$i`/`$o`/`$r` in future transactions involving this identity.

## A verified example

The request shape above (minus wrapping the public key under an `identity` sub-object — a flat `{ publicKey, type }` under the stream ID works too) was used to submit 200 real self-signed onboarding transactions against a live 4-node network during this session's transport benchmark ([transport.md](transport.md)) — every one succeeded, using the genuine `ActiveCrypto.KeyPair` class for key generation and signing, and a plain Node.js `http` POST to the node's root. If you're writing your own client, that combination (real `KeyPair`, root-path POST, JSON body) is a confirmed-working starting point as of `v4.1.0`.
