# `definitions`: the shared type vocabulary

`@activeledger/activedefinitions` (`packages/definitions/`) has no runtime logic of its own — it's the TypeScript interfaces every other package agrees on for the shape of a transaction, a stream, and a node's response to one. Reading it directly turned up a couple of real, currently-undocumented capabilities worth knowing about if you're writing contracts. Checked against `v4.1.0`.

## The three layers of a stream

Every stream (a contract's persisted state — see [architecture.md](architecture.md)) is actually three separate documents (`packages/definitions/src/definitions/document.ts`):

- **`state`** (`IFullState`) — the data the contract itself defines and writes. Whatever your contract's `commit()` puts here.
- **`meta`** (`IMeta`) — ledger-managed metadata: authorities (see below), contract locks, ACLs, and removed-authority audit history. Not something a contract typically writes directly; the ledger maintains this.
- **`volatile`** (`IVolatile`) — and this is worth quoting directly, the interface's own doc comment says it plainly: **"Not Network Safe!"**. This is the backing type for `core`'s `/api/stream/*/volatile` endpoint (see [core.md](core.md)) — side-data that isn't part of consensus, isn't verified across nodes, and can genuinely diverge between them. Use it for things that don't need to be trustworthy ledger state (a cached display value, a scratch note), never for anything a contract's logic depends on being consistent network-wide.

## `LedgerEntry`: the full transaction-in-flight shape

This is the object that flows through the whole lifecycle described in [architecture.md](architecture.md) and [transactions.md](transactions.md) — what a client submits (`$tx`, `$sigs`, `$selfsign`) gets progressively filled in by the origin node (`$umid`, `$datetime`, `$origin`, `$nodes`) as it moves through gossip, vote, and commit. A few fields beyond what [transactions.md](transactions.md) already covers, worth knowing exist:

- **`$broadcast`** — gossip (the default) vs. territoriality/ring-relay (see [architecture.md](architecture.md#two-propagation-modes-gossip-broadcast-vs-ring-relay)).
- **`$multi`** — marks a transaction as touching multiple streams' authorities at once (multi-signature territory — see below).
- **`$instant`** — an expedited path, bypassing some of the normal broadcast waiting.
- **`$unanimous`** — require every participating node to agree, not just `consensus.reached`'s configured percentage (see [configuration.md](configuration.md)).
- **`$nolock`** — skip the per-stream locking described in [architecture.md](architecture.md#streams-are-the-unit-of-concurrency). Exists for specific internal paths; not something to reach for casually, since the locking exists to prevent exactly the kind of interleaving this bypasses.
- **`$encrypt`** — per-transaction opt-in to the `security.encryptedConsensus` behaviour (see [configuration.md](configuration.md)).

`$nodes` is typed `INodes` — `{ [reference: string]: INodeResponse }`, and `INodeResponse`'s fields (`vote`, `commit`, `early`, `leader`, `streams`, `error`, ...) are exactly what the early-vote consensus bug in [architecture.md](architecture.md#the-nodes-map-and-the-early-vote-pitfall) is about — this is the formal shape of the map that bug's `early: true` placeholder lived in.

`LedgerTypeChecks.isEntry(tx)` is the actual runtime gate `ExternalInitalise` (see [transactions.md](transactions.md)) uses to decide whether a submitted body even looks like a transaction, before doing anything else with it — it just checks that `$tx` exists and either `($tx.$i && $sigs)` or `($tx.$namespace && $tx.$contract)` are present. It's a shallow check (the class's own comment notes "TODO: cascade down the object") — don't rely on it as full schema validation.

## Multi-authority streams have a weighted stake model, not just a signer list

This doesn't show up anywhere in the older docs, and it's a real, working capability: `ILedgerAuthority` (the shape of one entry in a stream's `meta.authorities`) has a `stake: number` field, not just `public`/`type`. A freshly-onboarded identity gets `stake: 100` by default (full authority) — but a stream can have multiple authorities, each with their own stake, and contract code can require signatures to add up to a minimum combined stake rather than just accepting any one valid signature.

This is opt-in, not automatic — it's a helper method a contract calls from its own logic:

```ts
// Inside a contract, via the Stream/Activity base classes:
this.getMofSignatures(2);                    // plain M-of-N: at least 2 valid signatures present
this.hasAuthorityStake(51, activity);         // signatures present sum to at least 51 stake on this stream
```

If you're building anything resembling a "board of directors" or weighted-voting authorization model on top of a stream, this is the primitive to use — you don't need to invent your own signature-counting logic.

## Removed-authority auditing

When an authority key is revoked from a stream, a historical record (`ILedgerRemovedAuthority` — `hash`, `label`, `umid`, `revoked`) gets appended to that stream's `meta.removedAuthorities` rather than the old authority just disappearing. This is a non-repudiation feature: it lets you prove a given key *was* valid at some point in the past, signed something, and was later revoked — rather than a revoked key's history becoming unprovable. Gated behind the `build` config flag (`>= 40000` — see [configuration.md](configuration.md#build)), so it's only present for streams updated by nodes running a config that opts into it.

## Also here

- **`IActiveDSConnect`/`IActiveDSChanges`** — the interfaces `ActiveDSConnect`/`ActiveChanges` (see [options.md](options.md)) implement, shared so the embedded and CouchDB storage paths can be used interchangeably by calling code.
- **`IHybridNodes`** (`hybrid.ts`) — the shape of the `hybrid` config array (see [configuration.md](configuration.md#hybrid)).
