# Contracts

A contract is the code that decides what a transaction may do. This page says what a contract is, how the ledger runs it, and where to go next.

## What a contract is

A contract is a small TypeScript class. When a transaction names it, every node in the network runs the same class against the same data. The class decides whether the transaction is acceptable and, if it is, what changes to make. Nothing is saved until the nodes agree.

A contract works on activity streams. A stream is one record in the ledger with its own id, its own data (its *state*) and a list of keys allowed to change it (its *authorities*). A transaction lists the streams it uses: `$i` (inputs, which must be signed) and `$o` (outputs, which the contract may change without a signature from their owner). The contract reads them, changes them, or creates new ones.

## The three steps

The ledger calls three methods on your class, in order. Each returns a promise. Resolving means "carry on"; rejecting means "refuse this transaction", and the reason you give is returned to whoever sent it.

| Step | Method | What it is for |
| --- | --- | --- |
| Verify | `verify(selfsigned)` | Can this contract understand this transaction at all? The one argument tells you whether the transaction was self-signed, which is a transaction signed by a key that is not yet an identity on the ledger. Most contracts reject those. This step is optional. |
| Vote | `vote()` | Should this transaction be allowed? Check the data, check who signed, check the streams. Each node votes on its own. A node that rejects here votes no. |
| Commit | `commit()` | Make the changes. Set state on streams, create new streams, hand data back to the caller. This runs only when enough nodes voted yes. |

Commit runs on every node separately, so it must produce the same result everywhere. Do not write the current time or a random number into a stream; each node would save something different.

Two optional steps exist for rarer cases: `reconcile()` runs when this node voted no but the rest of the network went ahead, so the contract can catch up; `postProcess()` runs after commit for work that should happen once the data is saved. [The contract API](reference.md) lists them.

## Where contracts live

The source of a contract is stored in the ledger itself, as a stream under a namespace. A namespace is a name an identity claims so that its contracts cannot clash with anyone else's. See [Keys, identities and namespaces](../identities.md).

When a contract is deployed, each node compiles the TypeScript to JavaScript and keeps the result on disk under the folder the node runs from. The files are named by the contract's stream id, not by the name you gave it:

```
contracts/<namespace>/<id>.js             the latest version
contracts/<namespace>/<id>@<version>.js   one file per version
contracts/<namespace>/_LOCK.<id>          present while the whole contract is locked
contracts/<namespace>/_LOCK.<id>@<version>   present while that one version is locked
contracts/<namespace>/<label>.js          a link (see Deploy), pointing at <id>.js
```

The contracts that ship with Activeledger (identity onboarding, namespaces, deployment) are in the `default` namespace and live in `default_contracts/`. Only the `default` namespace is trusted with system work; your contracts run with the limits described in [Writing a contract](write.md).

## Entry points

A transaction can carry an optional `$entry` string next to `$contract`. It is a name for what the caller wants, such as `"create"` or `"add"`. The engine does not act on it for a normal transaction; your contract reads `this.transactions.$entry` and branches on it. One contract can therefore offer several operations without becoming several contracts.

The exception is a read-only transaction: one with no `$i` at all. Leave the field out entirely; an empty `$i: {}` still runs the vote. Send `"$sigs": {}`, because the node refuses a body without `$sigs`. For a read-only transaction the engine runs `verify`, then calls the method named by `$entry` directly (or `read` when there is no `$entry`), and returns whatever that method returns in `$responses`. Nothing is voted on and nothing is saved, and only the node you sent to runs it.

```json
{
  "$tx": { "$namespace": "myorg", "$contract": "<contract stream id>", "$r": { "nb": "<stream id>" } },
  "$sigs": {}
}
```

If the contract has no method of that name, the reply has no `$responses` at all: `{ "$umid": "…", "$summary": { "total": 1, "vote": 0, "commit": 1 } }`. [Running a contract](run.md) shows a reply with data.

## The contract pages

- [Writing a contract](write.md): a first contract from a blank file, and the rules on what a contract can and cannot do.
- [The contract API](reference.md): every method you can call from inside a contract.
- [Deploy, update, lock and unlock](deploy.md): getting the contract into the ledger and managing versions.
- [Running a contract](run.md): the transaction that calls it and what comes back.
- [Contracts on hybrids](hybrid.md): what to do when the contract also runs on hybrid nodes.
