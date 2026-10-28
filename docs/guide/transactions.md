# Sending a transaction

A transaction is a signed JSON message that asks a contract to change the ledger. This page shows what one looks like, how to sign it, and how to read the reply.

You need an identity first. See [Identities](identities.md).

## The shape

Every transaction is one JSON object posted to a node. The top level has three fields; the real content is inside `$tx`, which is the part you sign.

```json
{
  "$tx": {
    "$namespace": "myorg",
    "$contract": "…contract stream id…",
    "$entry": "transfer",
    "$i": { "…your stream id…": { "amount": 5 } },
    "$o": { "…another stream id…": {} },
    "$r": { "prices": "…a stream id…" }
  },
  "$selfsign": false,
  "$sigs": { "…your stream id…": "…base64 signature…" }
}
```

| Field | Required | What it is |
|---|---|---|
| `$tx.$namespace` | yes | The namespace the contract lives in. `default` for the contracts that ship with Activeledger. |
| `$tx.$contract` | yes | Which contract to run. In `default` this is a name (`onboard`, `namespace`, `contract`). In your own namespace it is the contract's stream id, optionally with a version: `<id>@=0.0.1`. |
| `$tx.$entry` | no | A word the contract can read to decide what to do. The built-in `contract` contract uses `update`, `lock` and `unlock`. Leave it out if the contract does not use it. |
| `$tx.$i` | yes | Inputs. The streams that are authorising this transaction. Each key is a stream id; each value is whatever data the contract expects. Every input must be signed. |
| `$tx.$o` | no | Outputs. Streams the contract may change but which do not have to sign. Keys are stream ids. |
| `$tx.$r` | no | Read-only streams. Key is a name of your choosing, value is a stream id. The contract can read them but not change them. A missing id does not fail the transaction: the contract reads `{ "notFound": true, "code": "LEVEL_NOT_FOUND" }` under that name instead. |
| `$tx.$expire` | no | A date and time (ISO 8601). After it, nodes refuse the transaction. Setting it also stops the same transaction being accepted twice; see below. |
| `$selfsign` | no | `true` only when onboarding, when the signer has no stream id yet. |
| `$sigs` | yes | One signature per key in `$i`, under the same key. |

In `$i` and `$o` you can use a label instead of a stream id as the key, as long as the value has a `$stream` field holding the real id, for example `"sender": { "$stream": "…id…", "amount": 5 }`. `$sigs` still uses the stream id. If you mix the two, put the labelled entries first.

Only the streams in `$i` and `$o` are locked while the transaction runs. Two transactions touching the same stream are run one after the other.

!!! warning
    Sending the same signed transaction twice runs it twice. The node stamps each arrival with its own time and that time is part of `$umid`, so a repeat is a new transaction. If you set `$tx.$expire`, the time is left out of `$umid` and a repeat is refused with `Transaction Exists`. Set it on anything you might retry.

## Signing

The node checks the signature against the public key stored in each input's identity stream. You sign the `$tx` object, as a JSON string, with your private key.

```js
const { ActiveCrypto } = require("@activeledger/activecrypto");
const fs = require("fs");

const keyPair = new ActiveCrypto.KeyPair("rsa", fs.readFileSync("identity.key", "utf8"));

const txBody = { $namespace: "myorg", $contract: "…", $i: { [streamId]: { amount: 5 } }, $o: {} };

const tx = {
  $tx: txBody,
  $sigs: { [streamId]: keyPair.sign(txBody) },
};
```

What `sign` does, if you are writing your own client:

- The message is `JSON.stringify($tx)`: the object exactly as it will be sent, with keys in the same order. Any change after signing, even reordering keys, makes the signature invalid.
- `rsa` signs with RSA-SHA256. `secp256k1` signs with ECDSA over SHA-256. The post-quantum types sign the raw UTF-8 bytes with their own scheme.
- The signature is base64.

Sign with every key named in `$i`. A stream can have more than one authorised key; if it does, give an object of signatures instead of a string, keyed by each key's hash (the SHA-256 of the public key).

## Sending

POST the JSON to the root path of any node. The default port is 5260.

```
curl -s -X POST http://127.0.0.1:5260/ \
  -H "Content-Type: application/json" \
  --data @tx.json
```

The node passes the transaction to the contract, asks the other nodes to vote, and when enough agree (the `consensus.reached` percentage in `config.json`, 60 by default) writes the result. The reply comes back when that has happened, or when it has failed.

## Reading the reply

On a 3-node network a successful reply looks like this:

```json
{
  "$umid": "f3a1…",
  "$summary": { "total": 2, "vote": 2, "commit": 1 },
  "$streams": {
    "new": [ { "id": "…", "name": "…" } ],
    "updated": [ { "id": "…", "prev": "…" } ]
  },
  "$responses": [ { "balance": 12 } ]
}
```

The node you sent to replies as soon as consensus is reached, so the counts in `$summary` cover only the nodes whose answers it had by then, not the whole network.

| Field | Meaning |
|---|---|
| `$umid` | The transaction's id: a SHA-256 of the transaction as received. Use it to look the transaction up later. |
| `$summary.total` | How many nodes' answers the node you sent to had when it replied. On 3 nodes expect `2`; on a single node, `1`. |
| `$summary.vote` | How many of those voted yes. |
| `$summary.commit` | How many of those it knows have written the result. Normally `1` (itself). If this is `0`, nothing changed. |
| `$summary.errors` | Present only when something went wrong. A list of messages, one per node that reported a problem. |
| `$streams.new` | Streams this transaction created: `id` and the `name` the contract gave each one. |
| `$streams.updated` | Streams it changed: `id` and `prev`, the `$umid` of the previous transaction that changed that stream. |
| `$responses` | Values the contract chose to return, one per node that returned something. Absent if none did. |

The HTTP status is 200 whether the transaction succeeded or failed; look at `$summary`. A status of 500 usually means the body was not a transaction at all (`Invalid Transaction`), and 413 means it was larger than the node allows (`security.maxRequestBytes`, 16 MB by default).

`commit` greater than zero means the transaction is on the ledger. `commit` of zero means it is not, and `errors` says why.

## Common errors

Each message in `$summary.errors` is the reason. A contract's own refusal is wrapped as `Vote Failure - "<reason>"`, for example `Vote Failure - "Namespace Reserved"`. One message per list, the one from the node you sent to, ends with ` - Error <umid>:<time>`: the id of that node's error-log entry. Some messages have no suffix: `$sigs not found`, `Transaction Expired : <time>` and `Transaction Exists : <umid>`. The reasons you are most likely to see:

| Reason | What it means | What to do |
|---|---|---|
| `$sigs not found` | The transaction had no `$sigs` field. | Add signatures for every input. |
| `Transaction Exists : <umid>` | The same transaction (one with `$expire` set) has already been accepted. | Nothing; it is already on the ledger. |
| `Transaction Expired : <date>` | `$tx.$expire` is in the past. | Build and sign a fresh transaction. |
| `Input Signature Incorrect` | A signature did not match the key on the input stream. | Check you signed `$tx` exactly as sent, with the right key, and that `type` matches the key. |
| `Input Signature Expired` | The key that signed has passed its expiry date. | Sign with a key that is still valid for that stream. |
| `Self signed signature not matching` / `Self signed publicKey property not found in $i <label>` | An onboarding transaction was wrongly formed: the signature does not match the `publicKey` in `$i`, or the `$i` entry (named by its label) has no `publicKey`. A bad self-signed signature can take about ten seconds to be refused, where other errors come back in milliseconds. | See [Identities](identities.md#onboard-the-identity). |
| `Stream(s) not found` (as `Stream(s) not found - Error Default Error Id`) | A stream id in `$i` or `$o`, or the contract id, does not exist on this node. A missing `$r` stream does not fail the transaction; see the `$r` row above. | Check the ids. If the node is new or behind, see [Restore](operate/restore.md). |
| `Input Stream Position Incorrect` / `Output Stream Position Incorrect` | This node's copy of a stream is at a different revision from the rest of the network. The node repairs itself. | Send the transaction again. |
| `Stream contract locked` / `Stream namespace locked` | The stream only accepts transactions from a particular contract or namespace. | Use that contract. |
| `Read Only Stream Error` | The node could not fetch the `$r` streams from its own storage at all (the request to the storage service failed). It is not raised for an `$r` id that does not exist. | Check the node's storage service is running. See [Troubleshooting](operate/troubleshooting.md). |
| `Failed Network Voting Round - No Quorum` | Not enough nodes voted yes. | Read the other errors in the list; they usually say why the nodes refused. |
| `Failed Network Voting Timeout - Voters Timed Out` | Nodes did not answer in time. | Check the network is up. See [Troubleshooting](operate/troubleshooting.md). |
| `Vote Failure - "<reason>"` | The contract itself refused the transaction in its `vote` step. The quoted text is the reason it gave, for example `Vote Failure - "Namespace Reserved"`. | Read the contract. |

Every error is also stored on the node in its error database, with a numeric code (signature errors are 1220 to 1260, position errors 1200, voting errors 1500 to 1510). You only need those if you are reading node logs; see [Troubleshooting](operate/troubleshooting.md).

## A worked example

Onboarding is the simplest complete transaction: it creates a stream and needs no existing identity.

The transaction, as sent (public key shortened):

```json
{
  "$tx": {
    "$namespace": "default",
    "$contract": "onboard",
    "$i": {
      "identity": {
        "type": "rsa",
        "publicKey": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq…\n-----END PUBLIC KEY-----\n"
      }
    },
    "$o": {}
  },
  "$selfsign": true,
  "$sigs": {
    "identity": "NhXdc4fz9yX7BSo1R/PUSuI+HmcCAGrNz1yeYZ5AXNbk75rJnLcK7Dk4kocNSwrD6TCQ…"
  }
}
```

What happens on the node:

1. The node adds a timestamp and works out `$umid` from the whole message.
2. `$selfsign` is set, so it checks the signature under `$sigs.identity` against `$i.identity.publicKey`.
3. It runs the `onboard` contract, which creates a new stream named `activeledger.default.identity.identity` and records the public key as the stream's authority.
4. The nodes vote, then write the stream.

The reply on a 3-node network, with the new stream id under `$streams.new`:

```json
{
  "$umid": "…",
  "$summary": { "total": 2, "vote": 2, "commit": 1 },
  "$streams": {
    "new": [ { "id": "…", "name": "activeledger.default.identity.identity" } ],
    "updated": []
  }
}
```

From now on that id goes in `$i` and `$sigs`, and `$selfsign` is left out. The next transaction to send is usually a namespace registration; see [Identities](identities.md#namespaces).
