# Multi-chain nodes

Status: draft for review · 2026-11-19

## Goal

Let one Activeledger node take part in more than one network, in the way a
Cosmos SDK application chain can be joined by validators of other chains. A
node keeps its home chain exactly as it is, and additionally:

- **follows** another chain: it pulls that chain's transactions, re-runs the
  contracts itself and keeps the result, so its own users and contracts can
  read that chain's data;
- later, **is a member** of another chain: it votes and writes there like any
  supernode of that chain.

The motivating picture is a node (for example a Varnir green node) that is a
supernode for one chain and a participant in others, with a connector layer
(IBC-like) possible on top later.

Out of scope here: the connector itself, cross-chain writes, and a
neighbourhood/handshake redesign (that follows this release).

## What already exists

- **The hybrid.** `activehybrid` already is a follower of one network. It
  subscribes to supernodes, verifies their signed votes and commit
  attestations, re-runs every contract locally in a sandbox with the network
  blocked, stores the result in its own LevelMe store with the same document
  shapes and `_rev` scheme, and never relays without its own yes vote. See
  `2026-10-03-activehybrid-v5.md`. Following another chain reuses all of that;
  the new work is running it for a named chain beside a home chain.
- **Chain id (PR #279).** `chain.id` is required in `config.json`, recorded in
  `.chain`, carried on the neighbour status knock (a neighbour on another
  chain is not paired), and `chain?` exists on stream meta. A meta without
  `chain` belongs to the node's own chain.
- **Contract storage guard (PR #278).** Contracts cannot reach the node's
  storage or loopback by default; a foreign contract is third-party code, so
  this matters here (see Security).

## Terms

| Term | Meaning |
|---|---|
| Chain | One network: its own supernodes, ledger, consensus settings and build level, identified by `chain.id`. |
| Home chain | The chain a node is configured to run as a normal Activeledger node (`chain.id` in config). |
| Follower | A node that pulls a foreign chain, re-runs its transactions and keeps the results read-only. Never votes there. |
| Member | A node that votes and writes on a chain (a supernode of it). |
| Foreign stream | A stream that belongs to a chain other than the node's home chain. |
| Connector | A later layer that proves a foreign stream's state to another chain. Not designed here. |

Roles describe what a node is configured to do. They are not permissions; the
only hard rule is the write guard below.

## Decisions

| Topic | Decision |
|---|---|
| Chain id | A whole number from 1, set in config, fixed at network creation. `1` means test or local, not production (convention only). Built in #279. |
| Missing chain on a stream | Means the node's own chain. Existing data is never rewritten. A foreign stream always carries its chain explicitly, so absent can never be mistaken for foreign. |
| Stamping | New and updated streams get `chain` in meta, behind a build gate, in its own PR. Verify first that nothing hashes or compares meta across nodes. |
| Reference syntax | `<chain>~<id>`, for example `5~abc`. An unprefixed reference is the home chain. The home chain is never written with a prefix: `<home>~<id>` is refused, so a stream has one spelling. |
| Why `~` | `:` already separates a stream id from a suffix (`<id>:volatile`, `<id>:stream`, `<id>:umid`) and is split on the first `:` in `contracts/src/stream.ts`, `protocol/src/protocol/shared.ts` and `hybrid/src/orderer.ts`. `~` is not used in ids and is safe in URLs and keys. |
| Storage keys | Foreign documents are stored under the same prefix. Home keys stay unprefixed. A suffix follows the id: `5~abc:stream`. |
| Writes | A local transaction can never write a foreign stream. The commit guard refuses it (like guard 1238). Only the follower's apply step writes foreign documents. |
| Reads | A foreign stream is a read-only input (`$i`/`$io`) addressed with `~`. Read locks and the `_rev` check apply. |
| Foreign contracts | Run by the follower under the hybrid sandbox: no network, storage guard on. The follower derives state itself instead of copying documents. |
| Roles | Documentation and config description, not permissions. |
| First deliverable | Chain stamping, then follower. Member inside one process comes last. |

## 1. Chain identity (done)

See PR #279. Two safeguards matter for everything below:

- a node cannot start without `chain.id`, and cannot change it by editing the
  config (the `.chain` record), so a typo never stamps data under the wrong
  chain;
- nodes on different chains are not paired. Without this, a node on chain 1
  and a node on chain 5 in one network would stamp different meta for the same
  transaction and their votes would stop matching.

## 2. Stamping

- On creating or updating a stream, set `meta.chain` to the node's own chain.
  It sits next to `meta.umid`, which `streamUpdater` already sets on every
  write.
- Gated on a new `build` level so every node starts at once; before that,
  behaviour is unchanged. Streams written earlier gain the field only when next
  written; reads treat absent as home regardless.
- Check before building: nothing compares or hashes `meta` across nodes in a
  way an extra field changes (the `:umid` document is hashed and signed in the
  commit attestation; confirm meta is not part of it).

## 3. References and keys

### The reference

`$i`/`$io` keys and any stream reference may be `<chain>~<id>`. Parsing is
one helper, `parseStreamRef(ref, home)`, returning `{chain, id, suffix}`:

1. split the suffix off the first `:` as today;
2. split a leading `<digits>~` off the remainder;
3. no prefix means `chain = home`; a prefix equal to `home` is refused.

Every place that splits on `:` today (listed above) or handles the `:volatile`,
`:stream` and `:umid` suffixes (among them `permissionsChecker`, `quick-restore`,
`endpoints` and `streamUpdater`; a search will find the rest) must go through
the helper; this
is the largest mechanical part of the work and is done before any foreign data
exists, so it is a no-op for home streams.

### Storage

A foreign document is stored as `5~abc`, its meta as `5~abc:stream`, its
volatile (if the follower keeps one) as `5~abc:volatile`. Because home ids are
hashes with no `~`, a prefixed key can never collide with an existing one.

Two stores are possible:

- **A. The node's main storage**, prefixed keys. Local transactions read
  foreign streams through the existing path; no second store to open.
- **B. The hybrid's own embedded store**, one per followed chain. Isolated, and
  reuses the hybrid code unchanged, but a local transaction would need a
  read-through into it.

Recommendation: **A**, because local reads are the point. The cost is that
every process that walks the home database must be taught about prefixed keys:
SPI (sync between neighbours must not push or pull foreign keys between home
nodes unless they follow the same chain), restore, prune, the explorer, the
event indexes and backup. A list of those, with a "skips foreign" or "handles
foreign" decision for each, is part of the follower design review.

## 4. Local transactions reading foreign streams

Consensus needs every home supernode to read **the same revision**. A
foreign stream moves on its own chain; if node A holds revision 3 and node B
holds revision 4, the same transaction would vote differently.

Rule: a transaction that reads a foreign stream pins the revision it reads
(the hybrid feed already works this way, with exact `$revs`). A node that
does not yet hold that revision fetches it, verifies it, or votes "not yet"
(retryable), the same as the hybrid's `lookup` and holding buffer. A node never
substitutes a newer revision.

Verification of a fetched revision uses the foreign chain's signed commit
attestations (`consensus.reached` signatures against that chain's setup-stream
keys), as the hybrid does. This means a home node does not need to follow a
chain continuously to read one pinned revision of it; it can fetch and prove
it. Following is the efficient way; verified fetch is the fallback, and it is
also the seed of the later connector.

Open: where the pin is declared on the transaction (a revision on the `$i`
entry, or a separate field) and the exact retry behaviour. Decide with the
transaction-format owners before building.

## 5. The follower

The follower is the hybrid core run for a named chain inside the node process:

- **Feed:** subscribes to that chain's supernodes (`upstreams`), verifies
  signatures and tallies against that chain's setup stream.
- **Execute:** re-runs the foreign transaction with the foreign contract. On a
  mismatch for a supernode-dependent contract, adopt mode applies as in the
  hybrid (signed outputs, shape safety nets).
- **Apply:** writes the result under prefixed keys, stamped with the foreign
  chain. This is the only write path to foreign documents.
- **Per-chain state:** contract files live under a per-chain path
  (`contracts/<chain>/<namespace>/...`), and the namespace-bound contract cache
  is keyed by chain, so `ns/contract` on two chains cannot share an entry.
  Namespace policy (`security.namespace.<ns>.policy`) is per chain, read from
  that chain's own ledger settings, never the home chain's.
- **Build level:** the foreign contract runs at the foreign chain's `build`,
  not the home node's. A follower below a chain's required build is "outdated"
  for that chain only, as the hybrid is today (`minVersion`).

## 6. Roles and config

Today: `chain: { id }`. Follower adds a list; the home entry can stay as is:

```json
{
  "chain": { "id": 5 },
  "follow": [
    { "id": 9, "upstreams": [{ "host": "", "port": 0, "transport": "p2p" }] }
  ]
}
```

`follow` entries carry what the hybrid config carries today (`upstreams`,
`window`, `maxLagSeconds`, and so on) plus the chain `id`, which is checked
against the upstream's own `chain.id` at bootstrap (a mismatch refuses to
start, like `.chain`). The follower's chain id is pinned the same way home is.

A **member** of a second chain is not a `follow` entry: it needs that chain's
neighbourhood, consensus settings, identity decision (same key or a separate
one per chain) and workers. A member can already be done today by running a
second Activeledger instance with its own config and ports, each pinned to its
own chain id by #279. Running both in one process is a later step.

## 7. Security

- A foreign contract is code written by someone else, run by the follower.
  Keep the hybrid sandbox: `http`, `https`, `net`, `tls`, `dgram` and `fetch`
  throw, and the storage guard stays on, so a foreign contract cannot reach the
  node's storage or its home chain's data.
- Foreign contracts must not see the home chain's volatile data or private
  state; their `$i` resolves only to the foreign chain's documents.
- The commit guard refusing local writes to foreign streams is a hard rule, not
  a policy, and is covered by tests for every write path (updater, volatile,
  read lock, deploy).
- A follower trusts the foreign chain's signatures, so it only follows chains
  whose setup-stream keys it has pinned in config at first contact.
- Chain id `1` on a node with outside peers already warns; a follower of
  chain `1` from a production chain should warn too.

## 8. Phases

1. Chain id and pairing (**#279**).
2. Stamping `chain` into meta (separate PR; build-gated).
3. `parseStreamRef` and refusing `<home>~<id>`, routed through every place
   that splits on `:` today. No behaviour change for home data.
4. Commit guard for foreign writes, with tests, before any foreign data exists.
5. Follower for one chain: feed, execute, apply under prefixed keys, per-chain
   contract files and cache.
6. Pinned-revision reads from local transactions, and verified fetch.
7. The audit of every process that walks the database (SPI, restore, prune,
   explorer, events, backup).
8. Member inside one process, and the connector, each with its own design.

Phases 2-4 can ship before any follower exists, so the format is settled first.

## Tests

- Unit: `parseStreamRef` (prefix, suffix, home refused, garbage), stamping
  (absent as home, gate on and off), the foreign-write guard on every path.
- Two-chain network test: two small networks on different ids, one follower
  node, a transaction on chain A, the follower serving it to a home
  transaction that reads it at a pinned revision.
- Negative: a node with a changed chain id, a neighbour on another chain, a
  foreign contract trying the network, a home transaction writing `5~abc`.

## Open questions

- Where the pinned revision is declared on a transaction, and the retry
  behaviour when a node is behind (section 4).
- Prefixed keys in the main storage (A) against a store per chain (B), once the
  database audit in phase 7 has a list.
- Numeric id against a genesis-hash check when a follower joins, so two
  unrelated networks that picked the same number are not confused.
- Whether a member uses the same identity key on each chain or one per chain.
- Whether foreign `:umid` documents (transactions) are kept, and under what
  key, for history and events, or only the streams.
