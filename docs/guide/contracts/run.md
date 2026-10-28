# Running a contract

How to send a transaction to a contract you have deployed, choose which version runs, and read what comes back. The examples run the notebook from [Writing a contract](write.md), deployed and updated to `0.0.2` in [Deploy, update, lock and unlock](deploy.md).

## The transaction

A run is an ordinary transaction (see [Sending a transaction](../transactions.md)). `$namespace` is the namespace the contract was deployed into, and `$contract` is the contract's stream id or its label. This `$tx` adds a note to a notebook that a `create` transaction made earlier (see [Call it](write.md#5-call-it)):

```json
{
  "$namespace": "myorg",
  "$contract": "<contract stream id>",
  "$entry": "add",
  "$i": { "<identity>": { "note": "Second note" } },
  "$o": { "<notebook stream id>": {} }
}
```

`$i` names the streams that sign the transaction; `$o` names the streams it may change. What goes inside them is up to the contract: the notebook takes a `note` from the signer and appends it to the notebook named in `$o`. `$entry` is only needed when the contract reads it to choose what to do, as the notebook does.

## By id or by label

- **By id:** `"$contract": "<contract stream id>"`. The id came back in `$streams.new[0].id` when you deployed (see [Deploy](deploy.md)).
- **By label:** `"$contract": "notebook"`, once a `link` has been made for the contract. A label always runs the latest version.

Both run the contract's highest version number.

## Pin a version

Add `@=` and the version to the id:

```json
"$contract": "<contract stream id>@=0.0.1"
```

That exact version runs, even after newer ones have been deployed. Pin with the stream id, not a label: a label only resolves to the latest version. If the version has been locked, the transaction fails with `Init Contract Error - Contract Version Lock 0.0.1`.

## What comes back

On a 3-node network:

```json
{
  "$umid": "a3f9...",
  "$summary": { "total": 2, "vote": 2, "commit": 1 },
  "$streams": {
    "new": [],
    "updated": [{ "id": "<notebook stream id>", "prev": "<umid of the previous transaction on that stream>" }]
  },
  "$responses": [{ "notebook": "<notebook stream id>", "count": 2 }]
}
```

| Field | What it means |
|---|---|
| `$umid` | The transaction's id. Use it to look the transaction up later. |
| `$summary.total` | How many nodes' answers the node you sent to had when it replied. It replies once consensus is reached, so on 3 nodes expect `2`. |
| `$summary.vote` | How many of those voted yes. |
| `$summary.commit` | How many of those it knows have written the result, normally `1` (itself). `0` means nothing was written. |
| `$summary.errors` | Only present when something went wrong. One message per node that reported a problem. |
| `$streams.new` | Streams the contract created: `id` and `name`. |
| `$streams.updated` | Streams the contract changed: `id` and `prev`, the `$umid` of the previous transaction that changed that stream. |
| `$responses` | Only present when the contract called `returnToRemote()`. One entry per node that returned data. |

A transaction is committed when `$summary.commit` is above zero and `errors` is absent.

## Read without changing anything

A transaction with no `$i` is read-only: the node runs the contract's `read` method (or the one named by `$entry`) and returns its result, without a vote and without saving. Leave `$i` out of `$tx` entirely, and send `"$sigs": {}` since nothing is signed. Name the streams to read under `$r`.

```json
{
  "$tx": {
    "$namespace": "myorg",
    "$contract": "<contract stream id>",
    "$r": { "nb": "<notebook stream id>" }
  },
  "$sigs": {}
}
```

Only the node you sent to runs it, so `$summary` counts one node. With the notebook updated to `0.0.2` the reply is:

```json
{
  "$umid": "...",
  "$summary": { "total": 1, "vote": 0, "commit": 1 },
  "$responses": [{ "version": "0.0.2", "notebook": { "owner": "<identity>", "notes": ["First note", "Second note"] }, "count": 2 }]
}
```

Pin `@=0.0.1` and the same read answers `"version": "0.0.1"` with no `count`.

A contract with no matching method returns nothing: the same reply with no `$responses`.

## Common failures

| In `$summary.errors` | What it means |
|---|---|
| `Init Contract Error - Contract not found` | No contract matches `$contract` in `$namespace`. Check the id or label, and that `$namespace` is the one it was deployed into. With `@=`, that version does not exist. |
| `Init Contract Error - Namespace not found - ENOENT` | Nothing has been deployed into `$namespace` on this node. |
| `Init Contract Error - Contract Version Lock 0.0.1` | The pinned version is locked. |
| `Init Contract Error - Contract Global Lock` | The whole contract is locked. |
| `Vote Failure - "..."` | The contract itself voted no. The quoted text is the reason its `vote()` gave, for example `"Only the owner can add a note"`. |
| `Input Signature Incorrect` | The signature in `$sigs` does not match the signer's key. |
| `Failed Network Voting Round - No Quorum` | Not enough nodes voted yes. Look at the other errors for the cause. |

If `$summary.errors` is absent but `commit` is `0`, the transaction is still waiting. Look it up by `$umid` (see [The HTTP endpoints](../api.md)).
