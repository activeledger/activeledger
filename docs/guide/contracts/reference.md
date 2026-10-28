# The contract API

Every method a contract author can call, grouped by what it is for. Names and signatures are those of `@activeledger/activecontracts`.

## Base classes

Your contract is the `export default` class of its file and extends one of these.

| Class | Adds | Use it when |
| --- | --- | --- |
| `Standard` | The three steps and everything below | Most contracts |
| `Event` | `this.event` for raising events | You want to raise events on commit |
| `PostProcess` | An extra `postProcess` step after commit | You need work done once the data is saved |
| `PostProcessEvent` | Both of the above | You need both |

## The steps you write

All return a promise. Resolve to continue, reject to refuse. A rejected string, or a thrown `Error`, becomes the reason the caller sees in `$summary.errors` of the reply.

| Method | Required | Called when |
| --- | --- | --- |
| `verify(signatureless: boolean): Promise<boolean>` | No | First, on every node. `signatureless` is `true` for a self-signed transaction. Without a `verify`, the transaction passes this step. |
| `vote(): Promise<boolean>` | Yes | After verify, when the transaction has `$i` inputs. Rejecting makes this node vote no. |
| `commit(possibleTerritoriality?: boolean): Promise<any>` | Yes | When enough nodes voted yes. `possibleTerritoriality` is `true` on the node named by the transaction's `$territoriality`, when it set one. |
| `reconcile(): Promise<any>` | No | When this node voted no but the network reached consensus without it. Resolve `true` once you have brought the streams into line. |
| `postProcess(territoriality: boolean, who: string): Promise<any>` | With `PostProcess` | After commit. `territoriality` is `true` on the node named by the transaction's `$territoriality`; `who` is that node's reference. |
| `shutdown(): Promise<any>` | No | When the engine discards the contract instance after the transaction. |

For a read-only transaction, the engine calls the method named by `$entry`, or `read`, instead of vote and commit, and returns its result to the caller in `$responses`. Read-only means `$i` is left out of `$tx` entirely (an empty `$i: {}` still runs vote), and the message carries `"$sigs": {}`. Streams the caller lists under `$r` are available through `getReadOnlyStream(name)`. If the contract has no method of that name, nothing comes back and the reply has no `$responses`. See [Entry points](index.md#entry-points) for the shape of the message.

## What the contract can see

| Member | Type | What it holds |
| --- | --- | --- |
| `this.transactions` | `LedgerTransaction` | The `$tx` of the transaction: `$namespace`, `$contract`, `$entry?`, `$expire?`, `$i`, `$o`, `$r?` |
| `this.umid` | `string` | The transaction's unique id |
| `this.ActiveLogger` | | Logging: `info`, `debug`, `warn`, `error`, `trace`, `fatal`, each taking a message or an object and a message. Also importable from the package. |
| `this.ActiveCrypto` | | Hashing and key tools, for example `ActiveCrypto.Hash.getHash(data, "sha256")` |

In `$i` and `$o`, each key is either a stream id or a label, in which case the value carries `$stream` with the id. `getActivityStreams` understands both.

## Streams in the transaction

Methods on the contract itself for finding and creating streams.

| Method | Returns | What it does |
| --- | --- | --- |
| `getActivityStreams()` | `{ [id]: Activity }` | Every input and output stream of the transaction |
| `getActivityStreams(stream)` | `Activity` | One stream by id. You may pass the `$i` or `$o` entry itself; if it has `$stream`, that id is used. An id that is not in the transaction creates a new stream of that name instead. |
| `newActivityStream(name, deterministic?)` | `Activity` | Creates a stream. Its id is the sha256 of the transaction id and `name`, so every node makes the same id. Pass `deterministic` to use that seed instead, which makes the id reproducible outside the ledger; a seed that was used before is refused at commit. |
| `getReadOnlyStream(name)` | `any` or `false` | The state of a stream listed in `$r` under `name`, without `_id` and `_rev`. Marked deprecated in favour of the next method, but it is synchronous, which is what a `read` method needs. |
| `getAnyStreamReadOnly(streamId)` | `Promise<IStream>` | Fetches any stream's state from the ledger, read-only |
| `getMofSignatures(m)` | `boolean` | True when the transaction carries at least `m` signatures |
| `hasAuthorityStake(minimum, activity)` | `boolean` | True when the signers of `activity` hold at least `minimum` stake between them |
| `getContractData<T>()` | `T` | Data kept for the contract itself, across transactions |
| `setContractData<T>(data)` | `void` | Replaces that data |

Stream names beginning `activeledger.default.` are reserved; creating one outside the `default` namespace throws.

## Working with one stream

`Activity` is one stream. Everything here applies to the object returned by `getActivityStreams` or `newActivityStream`.

| Method | Returns | What it does |
| --- | --- | --- |
| `getId()` | `string` | The stream id (`getName()` is the same) |
| `getState()` | `IState` | A copy of the stream's data, without `_id` and `_rev` |
| `setState(state)` | `void` | Merges `state` into the stream's data. The write is saved at commit. A `namespace` field is dropped unless the contract is in the `default` namespace. |
| `hasSignature()` | `boolean` | True when this transaction carries a signature for this stream |
| `getAuthorities()` | `ILedgerAuthority[]` | The keys allowed to sign for this stream |
| `getAuthority(type?)` | `string \| undefined` | The first authority's public key, or its key type when `type` is `true`. Deprecated. |
| `setAuthorities(authority \| authority[])` | `void` | Adds or renews authorities. Only on an input stream or a stream created in this transaction. Re-adding a public key replaces its entry. Refused if it would leave no authority without an `expire`. |
| `setAuthority(pubKey, type = "rsa")` | `void` | Replaces all authorities with one key at stake 100. Same limits. Deprecated. |
| `deleteAuthorities(pubKey \| pubKey[] \| filter)` | `void` | Removes authorities by public key, list of keys, or a function that returns `true` for each to remove. Refused if nothing would be left, or nothing permanent. |
| `setContractLock(script \| script[])` | `boolean` | Only the named contract(s) may write this stream. New streams only. |
| `setNamespaceLock(namespace \| namespace[])` | `boolean` | Only contracts in the named namespace(s) may write this stream. New streams only. |
| `getCng(buffer?)` | `number` | A number derived from the stream's revisions. Not random; the same on every node. |

An authority (`ILedgerAuthority`) has `public`, `type` and `stake`, and optionally `hash`, `label`, `metadata`, `umid` and `expire` (an ISO date after which the key may no longer sign).

## Volatile data

Each stream can hold a second document of data that is kept outside consensus.

| Method | Returns | What it does |
| --- | --- | --- |
| `getVolatile()` | `Promise<IVolatile>` | A copy of the stream's volatile data, fetched from this node |
| `setVolatile(volatile)` | `void` | Merges into the volatile data. Saved at commit on this node. |

!!! warning
    Volatile data belongs to one node only. It is never shared with other nodes and never synced. Use it for a cache or a local note, never for anything another node must also know.

## Replying to the caller

| Method | What it does |
| --- | --- |
| `returnToRemote(data)` | Sends `data` back in the reply's `$responses` list. One entry per node that ran the contract. |
| `getRemoteAddr()` | The address the transaction arrived from |
| `findRemoteAddr(address \| address[])` | True when the transaction arrived from one of the given addresses |

## Events

Available on `Event` and `PostProcessEvent` contracts through `this.event`.

| Method | What it does |
| --- | --- |
| `this.event.emit(name, data)` | Records an event with the contract, the current step and `data`. Events are stored on the node and can be followed as they happen; see [The HTTP endpoints](../api.md). |

## Time

| Method | What it does |
| --- | --- |
| `this.setTimeout(ms)` | Asks for `ms` more milliseconds before the current step is timed out. Capped by the node's `contractMaxTimeout`. |

## Hybrids

A contract can also run on a hybrid node, which follows the network rather than taking part in consensus. These methods exist for that; [Contracts on hybrids](hybrid.md) explains when and how to use them.

| Method | On | What it is for |
| --- | --- | --- |
| `isSupernode()` | contract | True on a network node, false on a hybrid |
| `adoptFromSupernode(shape, options?)` | `Activity` | Declares what the network nodes write to this stream, so a hybrid can accept it |
| `adoptStreamsFromSupernode(streams, shape, options?)` | contract | The same for a list of candidate streams |

## Less common

| Method | What it does |
| --- | --- |
| `getInterNodeComms()` | Messages the other nodes' contract instances sent during their vote |
| `setThisInterNodeComms(data)` | The message this node's instance sends to the others |
| `clearAllInterNodeComms()` | Asks every node to clear those messages |
| `isExecutingOn(host)` | True when this node is `host` (as `host:port`) |
| `throw(location)` | Passes the transaction on to another ledger at `location` |
| `attemptDecrypt(data, safeMode = true)` | Decrypts data secured for this node's keys. With `safeMode` on, which is the default, the contract may no longer change state, authorities or locks, or create streams, because each node would decrypt something different. |

Using inter-node communications or `isSupernode()` makes the contract depend on the network nodes when it runs on a hybrid; see [Contracts on hybrids](hybrid.md).
