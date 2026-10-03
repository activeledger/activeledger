# Activehybrid v5 design

Status: draft for review · 2026-10-03

## Goal

Supernodes are the voting Activeledger nodes. Hybrids are lean, non-voting
nodes that keep their own copy of the ledger data. A hybrid re-runs every
contract locally and commits only what the supernodes agreed. Only after its
own local vote is yes does it relay a transaction: committed items to other
hybrids it has discovered, and its users' transactions to the supernodes.

Why someone would run a hybrid:

- to support the network;
- to own a copy of the data;
- to get first-class events.

Constraints:

- lightweight, fast, low storage;
- HTTP and P2P both supported (P2P preferred);
- ActiveCore is not used;
- the existing `packages/hybrid` is fully replaced.

## Decisions

| Topic | Decision |
|---|---|
| Delivery | Hybrids subscribe (dial out). Supernodes never push. |
| Admission | Open registration, gated by the on-ledger `hybrid.admission` setting: `"open"` or `{allowlist:[keys]}`. |
| Feed content | Committed transactions, plus failed transactions with at least one true vote. Failures with 0 true votes are omitted. |
| Divergence | Recorded locally and emitted as an event. It is not gossiped in v1; gossip belongs to the later evidence phase. |
| Storage | Current tips, plus a rolling window of transaction history. |
| Runtime | A single process that reuses `protocol`, `contracts` and `storage` as libraries (approach A). |
| Trust | Supernode-signed votes act as attestations, so items relayed between hybrids can be verified. |
| User transactions | Hybrids accept transactions from users. A hybrid casts a local yes vote before forwarding a transaction, and is recorded as its `$relay`. |
| Relaying rule | A hybrid relays nothing without its own yes vote. That covers forwarding user transactions to supernodes and gossiping committed items to other hybrids. |
| Code reuse | No duplicated logic. Code shared between supernode, restore, hybrid and nano-gateway moves into packages (see "Packages"). |
| External calls | On a hybrid, contracts cannot make outbound network calls. A contract that tries switches the hybrid to **adopt mode**: it saves the supernodes' signed outputs instead of computing them. |
| Verified yes | A yes vote can be **verified** (an adopted item whose outputs match the signed `revsOut`) or **conditional** (a user transaction that passed every check before its first external call). Both count as yes for relaying. |
| `:umid` doc | Byte-identical on every supernode and hybrid. Its hash is signed in the commit attestation, so the stored transaction record, `$relay` included, is itself agreed by consensus. |
| Volatile | Per-node by design. Never served over `/h/*` unless the owning contract marks that stream's volatile shareable. |
| History | Supernodes keep full history. Only hybrids use a rolling window, and `/h/umid` always serves old umids. |

## Sub-projects and build order

1. Supernode side.
2. Hybrid core, over HTTP.
3. Hybrid mesh, plus P2P.
4. Later, out of scope: hybrids give supernodes evidence that they are wrong.

## 1. Supernode side

### Registry contract `default/hybrid`

- Entries:
  - `register`: signed by the hybrid's own key. Stores the key, endpoints `[{transport:"p2p"|"http", host, port}]` and an optional label.
  - `update`: changes the endpoints.
  - `retire`: removes the registration.
- Each hybrid gets one stream: `activeledger.default.hybrid.<keyhash>`. There is no shared index stream, so registrations never contend for one lock.
- Admission comes from `hybrid.admission` in the setup stream.

### Config section, asserted on-ledger

```json
"hybrid": {
  "admission": "open",
  "required": ["<streamId>", {"id": "<streamId>", "volatile": true}],
  "window": {"days": 30}
}
```

- `--assert` and the `setup` contract copy this section into the setup stream, the same way `security` and `consensus` are handled. Every supernode therefore enforces the same rules.
- All contract streams, and their source umid docs, are implicitly required.

### Signed votes as attestations (build 40300)

- When it votes, each supernode signs `H(umid | vote | $revs)` with its node key.
- The signature goes in `$nodes[ref].sig`. That entry already travels in both broadcast and ring mode, so this adds no new network round.
- A hybrid verifies the signatures against the node keys in the setup stream. It derives the outcome from the vote tally and `consensus.reached`.
- Vote signatures are all a `failed` item has.

### Commit attestations (build 40300)

- After a supernode commits, it signs:
  `H(umid | outcome | $revs | revsOut | umidDocHash)`.
  - `revsOut` is `{streamId: {rev, sha256}}` for every output document: state, `:stream` meta, and `<contractId>:data`. The sha256 is taken over the stored document. It is needed because LevelMe `_rev` is only md5 and a fetched document must be verifiable against the attestation.
  - `umidDocHash` is the sha256 of the `<umid>:umid` doc that was written to LevelDB.
- Each supernode keeps its own attestation in the events DB, beside the `umid:` index, and serves it from `GET /h/attest/:umid`.
- A `committed` feed item carries the serving supernode's attestation. When a hybrid needs a quorum (adopt mode, or a mismatch), it fetches more from other supernodes until it holds `consensus.reached` matching attestations.
- Attestations cost no extra consensus round: they are produced after commit and fetched only on demand.

### `/h/*` endpoints, all authenticated

- Auth: a signature over `${key}:${timestamp}` made with the registered key, the same scheme as nano-gateway.
- Endpoints:
  - `GET /h/bootstrap`: the setup stream, the required list, the contract list and the current cursor.
  - `GET /h/feed?from=<cursor>`: an SSE stream of feed items:
    `{umid, outcome, umidDoc, $revs, revsOut, streams:{new,updated}, nodes:{ref:{vote,sig}}, attestation}`.
    - `umidDoc` is the exact `:umid` doc as stored, containing `tx`, `$relay` and events. A failed item carries `tx` instead, because nothing was stored for it.
    - The cursor is the events-DB key, `umid:<ms>,<umid>`.
    - Failed transactions get a new `fail:<ms>,<umid>` index.
  - `POST /h/streams`: state and meta for the requested streams. Accepts `{id, rev}` pairs. Volatile is included only when both of these hold:
    - the stream is listed as required-volatile;
    - its `:stream` meta has `volatileShared: true`.
  - `GET /h/umid/:umid`: always served. Supernodes keep full history.
  - `GET /h/attest/:umid`: this supernode's commit attestation.
  - `GET /h/peers`: the registered hybrids.
- The same message set is also served over the hybrid P2P channel (section 3).

### Contract API

- `isSupernode()` is added to the contract base classes. This is the intended way for contracts to handle supernode-only work: they wrap external calls (keygen, signing, chain RPC, health checks) and volatile writes in `if (this.isSupernode())`. Calling it marks the execution supernode-dependent, so a hybrid adopts the attested outputs instead of reporting a divergence (section 2).
- On a hybrid it returns `false`. `setVolatile` still writes locally there.
- `shareVolatile()` sets `volatileShared: true` in the stream's `:stream` meta during commit. Meta is part of consensus, so every node agrees on whether that stream's volatile may be served. Without it, volatile never leaves the node, whatever the supernode config lists. Volatile is per-node by design; contracts that keep secrets in it, such as key shares, simply never call this.
- Contracts always see the transaction's consensus time: `cDate` is `entry.$datetime`, the entry node's stamp (`process.ts` passes `date: this.entry.$datetime` to the VM). A hybrid never uses its own clock for contract execution.

### Relayed transactions (`$relay`)

- A hybrid submits a user's transaction to `POST /` with:
  `$relay: {key, sig}`, where `sig` is the hybrid's signature over `$umid`.
- The entry supernode removes `$relay` from the body **before** computing `$umid = hash(JSON(tx))` (`endpoints.ts` `ExternalInitalise`, which today hashes the whole body). It re-attaches `$relay` afterwards, beside `$origin` and `$remoteAddr`. The `$umid` is therefore identical whether or not the transaction arrived through a hybrid, and matches the hybrid's own computation.
- The entry supernode:
  - checks that `key` belongs to a registered, non-retired hybrid;
  - checks that `sig` is valid;
  - drops `$relay` silently if either check fails. The transaction itself is unaffected.
- `$relay` is saved inside the `<umid>:umid` document written to LevelDB. `compactTxEntry()` (`protocol/src/protocol/streamUpdater.ts`) adds `$relay: this.entry.$relay` next to `$origin` and `$remoteAddr`, and leaves it out when absent. It is therefore part of the transaction's permanent record on every node.
- Every supernode must write exactly the same `:umid` doc, because umid recovery (`backfillUmid`, restore) takes the majority by content hash. That is why `$nodes` is already kept out of the doc. To keep `$relay` identical everywhere:
  - only the entry supernode verifies `$relay`; it either drops it or keeps it, before the transaction is broadcast or forwarded on the ring;
  - from then on `$relay` travels inside the entry, like `$origin`, and no other node adds, changes or removes it.
- Hybrids store the `:umid` doc they receive in the feed byte-for-byte, after checking its sha256 against `umidDocHash` in the commit attestation. A hybrid never builds its own `:umid` doc; when it executes locally, it compares its result to the received doc instead. The transaction record, `$relay` included, is therefore identical across every supernode and hybrid, and consensus-verified.
- A hybrid keeps this doc in its rolling window like any other `:umid`. Docs whose `$relay` is the hybrid itself are kept permanently. A pruned doc can be fetched again from `/h/umid` and checked against the same attestation.

### Fixes and removals

- A new shared `ContractSource.resolve(stream, version)` in `contracts` (see "Packages") handles both the base64 format and the v5 umid-reference format (build 40100 and later). Supernode, `restore` and hybrid all use it. This fixes the broken contract rebuild in `restore` and in the old hybrid.
- Removed:
  - `processHybridNodes`;
  - the error-DB `q` backlog;
  - the `/streamState` and `/q` flows;
  - `config.hybrid[]` URL lists.

## 2. Hybrid node core

### Process layout

The hybrid is one process: no worker forks and no separate storage process. Modules:

- `identity`: the hybrid keypair, in `./.identity`.
- `store`: embedded LevelMe with the same document shapes and the same `_rev` scheme, so revisions match the supernodes'.
- `bootstrap`.
- `feed`.
- `executor`: `ActiveProtocol.Process` in hybrid mode — a single local node, no votes, no broadcast. Contracts run in a sandbox where `http`, `https`, `net`, `tls`, `dgram` and `fetch` throw `SupernodeOnly`. Contracts load modules with plain `require`, so the block has to be enforced by the sandbox; it cannot rely on each contract. The VM marks an execution **supernode-dependent** when any of these happen:
  - the contract calls `isSupernode()`;
  - a blocked call throws;
  - the contract uses inter-node comms: `getInterNodeComms()`, `setThisInterNodeComms()` or `clearAllInterNodeComms()` (`contracts/src/stream.ts`). Inter-node comms data comes from the supernodes' `$nodes` exchange during voting, which a hybrid never sees.
- `lookup`.
- `mesh`.
- `api`.
- `pruner`.

### Config

```json
{
  "upstreams": [{"host": "", "port": 0, "transport": "p2p|http"}],
  "peers": [],
  "api": {"bind": "127.0.0.1", "port": 5260},
  "window": {"days": 30}
}
```

### Bootstrap

1. Register with the registry contract, if not already registered.
2. Authenticate.
3. Call `/h/bootstrap`.
4. Pull the setup stream, the required streams (with volatile where flagged) and every contract. Build each contract's source.
5. Store the cursor and mark the node ready.

The feed starts only after the node is ready.

### Processing a feed item

1. **Verify.**
   - The signatures must be valid against the setup-stream keys.
   - For `committed`, the tally must be at least `consensus.reached`.
   - On failure, drop the item and log it.
2. **Prepare inputs.** Every input and output stream must be at exactly the item's `$revs`.
   - If a stream is unknown or behind, `lookup` fetches it at that revision. This is how the node lazily learns streams it doesn't know.
3. **Committed.**
   - Execute locally, without writing, then compare the outputs with the signed `revsOut` and the `:umid` doc with `umidDocHash`.
   - **Match:** save the outputs, and save the received `:umid` doc byte-for-byte. Local vote: **yes**.
   - **Mismatch, and the execution was supernode-dependent:** this is expected, because the contract behaves differently off a supernode. Switch to **adopt mode**:
     - gather `consensus.reached` matching commit attestations (feed item plus `GET /h/attest/:umid`);
     - fetch each output by `{id, rev}` from hybrid peers first, then supernodes;
     - check each fetched document's sha256 against `revsOut` and save it.
     - No divergence record. Local vote: **verified yes**.
   - **Mismatch, not supernode-dependent:** run SPI (section 3), adopt the attested state and write a divergence record. Local vote: **yes** once repaired.
4. **Failed.**
   - Do a dry run with no writes.
   - If it passes locally and was not supernode-dependent, write a divergence record. A supernode-dependent failure cannot be judged by a hybrid, so it writes nothing.
5. **Ordering.**
   - Items that share streams apply in `$revs`-chain order. An out-of-order item waits in a holding buffer; after a timeout, `lookup` fetches what it is missing.
   - Items that share no streams run concurrently, up to a small cap.

A divergence record contains: `{umid, kind, supernodeTally, localResult, $revs, revsOut, localRevs, at}`.

### Storage window

- Kept: current state and meta for every known stream, its local volatile (or the shared volatile, where `volatileShared`), and the `:umid` doc that each stream's `meta.umid` points to.
- Kept permanently: `:umid` docs whose `$relay` is this hybrid. These are its own users' transactions.
- Kept only inside the window: other `:umid` docs and events.
- Older history is fetched on demand through `/h/umid`.
- The pruner runs hourly.

### Events

- A local commit writes:
  - the contract's own events;
  - `tx.committed`, `tx.failed` and `divergence`.
- `GET /events` is SSE with `Last-Event-ID`. It reads by events key range, not by sequence entries, because those are no longer written.
- Binds to localhost by default. It can optionally be exposed with signed auth.

### API

- `GET /stream/:id` and `GET /umid/:umid`. An unknown stream is fetched lazily and cached.
- `POST /` accepts a user transaction and handles it as follows:
  1. Compute the `$umid` and run basic checks: entry shape, signatures, `$expire`.
  2. Refresh the input and output streams to their current tips with `lookup`, so a stale local copy cannot cause a false "no".
  3. Run a **local dry-run vote** with no writes. If the contract reaches an `isSupernode()` check, or a blocked external call, and everything before that point passed, the vote is a **conditional yes**. Examples of what has passed by then: signatures, permissions, inputs, and the contract's own checks.
  4. If the vote is no, return the contract's error to the user. Nothing is forwarded.
  5. If the vote is yes or conditional yes, attach `$relay` and forward the transaction to a healthy upstream supernode. If no supernode is reachable, forward it to a mesh peer that has one; that peer sends it on as-is and keeps the original `$relay`.
  6. Return the supernode's response to the user unchanged.
- The committed transaction comes back through the feed like any other item.

### Failure handling

- Supernodes unreachable: continue from mesh peers.
- No sources at all: pause, retry with backoff, and stay readable.
- Execution error: retry once, then run SPI. If that also fails, write a divergence record and continue; the feed is never blocked.

## 3. Mesh and transports

### Discovery

- Peers come from three places:
  - the config's `peers`;
  - `/h/peers` on supernodes;
  - `/h/peers` on hybrids, served from the registry streams they hold.
- A peer's key must match a registry stream on the ledger.
- About 8 outbound peers are chosen at random. Inbound connections are capped.

### Gossip by subscription

- Every hybrid serves `/h/feed`. An item goes on it only when both of these hold:
  - its supernode signatures verify;
  - this hybrid's local vote on the item was yes.
- For `committed` items, a local yes is one of:
  - executed locally and matched the signed `revsOut`;
  - adopted with verified outputs (verified yes);
  - repaired by SPI.
- A relayed item carries every commit attestation the relayer gathered, so a peer can adopt without going back to supernodes.
- `failed` items are never relayed between hybrids in v1. A local yes on a supernode-failed item is a divergence, and divergences stay local in v1. As a consequence, hybrids that only consume from peers do not see failed items and cannot detect that kind of divergence; only hybrids with a supernode upstream can. Relaying them is part of the later evidence phase.
- The supernode signatures stay on every item.
- A hybrid consumes its supernode feeds and its peer feeds at the same time.
- Duplicates are dropped by umid. Each source keeps its own cursor, and ordering comes from the `$revs` chain.
- A hybrid behind NAT dials out and pulls. Over P2P, items are pushed down open connections.

### P2P transport (new, authenticated)

- Handshake:
  - each side creates an ephemeral X25519 key;
  - both sides sign the transcript with their registered identity keys;
  - session keys are derived with HKDF.
- Uses Node's built-in crypto only.
- Frames are length-prefixed ChaCha20-Poly1305, carrying msgpack via `ActiveClone`.
- Request/response with ids, and push in both directions.
- Channels: `feed`, `streams`, `umid`, `peers`, `tx-forward`.
- Supernodes expose this listener on a configurable port.

### HTTP transport

- The same message set as REST plus SSE, with signed-header auth.
- Pull only.

### SPI across hybrids

1. Ask up to 5 peers for `{id, rev}`.
2. Accept if a majority agrees and the answer matches the signed `revsOut` (rev and sha256). A document matching a quorum-signed `revsOut` can be accepted from a single source.
3. Otherwise escalate to the supernodes and take the majority by revision, as `restore` does.
4. Write a divergence record in every case.

### Abuse controls

- Per-peer rate limits.
- `maxRequestBytes` size caps.
- A peer that serves an item with invalid signatures is dropped and temporarily banned.

### Follow-ups (out of scope)

- Move supernode↔supernode P2P onto the same handshake.
- Authenticate `/a/stream`.

## Packages (no duplicated code)

Rule: `packages/hybrid` holds only the hybrid-specific orchestration — bootstrap, feed, mesh wiring, API and pruner. Any logic that the supernode, restore, hybrid or nano-gateway also need lives in a package they share.

| Package | New? | Contents moved in | Used by |
|---|---|---|---|
| `@activeledger/activesync` | new | SPI tally (`spiConsensus`, `shouldTriggerSpiLookup`), `backfillUmid`, `walkUmidHistory`, majority-by-rev (restore's `checkConsensus`/`reduceStreamInformation`), fetch-at-rev, adopt-document. It is transport-agnostic and works through a `PeerSource` interface: `streams`, `umid`, `all`. | network endpoints, restore, hybrid |
| `@activeledger/activep2p` | new | Authenticated handshake, encrypted framing, and request/response/push channels | hybrid, the supernode's hybrid listener, and later supernode↔supernode |
| `contracts` | existing | `ContractSource.resolve` (base64 and umid-reference formats), `transpile`, and `ContractFiles`: writing `<ns>/<id>.js` and `@ver`, link symlinks, and `_LOCK` files | default `contract` contract, restore, hybrid |
| `crypto` | existing | Signed-request auth (`${key}:${timestamp}`, taken from nano-gateway), and vote-attestation sign/verify | supernode `/h/*`, hybrid, nano-gateway |
| `definitions` | existing | Feed item, attestation, `$relay`, registry entry and divergence record types | all |
| `storage` | existing | An embedded `ActiveDSConnect`-compatible adapter over LevelMe with no HTTP hop. `events.ts`'s `eventsSince` is reused for SSE resume. | hybrid, and later the supernode |
| `protocol` | existing | A hybrid mode for `Process`: one local node, no vote broadcast, a dry-run option, and `isSupernode` passed to the VM | supernode, hybrid |

Each extraction is a move-and-import, and the existing tests must pass unchanged before any hybrid code depends on the moved code. Extraction is the first part of sub-project 1.

## 4. Versioning, testing, rollout

### Versioning

- Ship as v5.1.0.
- Signed votes are gated by build 40300.
- Hybrids require 40300.
- The CHANGELOG notes the removal of `config.hybrid[]` and the push flow.

### Unit tests

- vote and commit-attestation signing and verification, including `revsOut` sha256 and `umidDocHash`;
- the sandbox blocks each egress module and marks the execution supernode-dependent;
- holding buffer and ordering;
- pruner window;
- P2P handshake: success, wrong key, replay;
- `ContractSource.resolve` with both formats.

### Network tests

Add `test:network:hybrid`, running 3 supernodes and 3 hybrids: one HTTP-only, one P2P, and one that is peer-only. Scenarios:

- bootstrap with required streams and volatile;
- lazily learning an unknown stream;
- a contract deployed or updated mid-run;
- a failed-with-votes transaction produces a divergence record;
- tampered local state is repaired by SPI from hybrid peers;
- every supernode down, with the feed continuing over the mesh;
- a forged item causes that peer to be dropped;
- allowlist admission rejects an unknown key;
- a user transaction submitted to a hybrid that votes no locally is rejected there and never reaches a supernode;
- a user transaction submitted to a hybrid that votes yes commits, with the same `$umid` as a direct submission. Its `$relay` is in the `:umid` doc on every supernode and every hybrid, and the doc hashes the same on all of them, so a `backfillUmid` majority still forms;
- a forged or unregistered `$relay` is dropped while the transaction still commits;
- a supernode-failed item is not relayed between hybrids;
- a contract that wraps an external call in `isSupernode()` commits on supernodes and is adopted on hybrids with verified outputs: no divergence record, and the service is never called from a hybrid;
- a contract that calls out without the wrap is blocked by the hybrid sandbox and adopted the same way;
- a user transaction that reaches `isSupernode()` gets a conditional yes and is forwarded;
- a contract that uses inter-node comms in its vote is adopted on hybrids, with no divergence record;
- volatile is not served for a stream without `volatileShared`, even when the stream is listed as required-volatile;
- adopted output whose sha256 does not match `revsOut` is rejected.

### Docs

- Rewrite `packages/hybrid/README.md`.
- Add `docs/en-gb/hybrid.md`, covering:
  - the operator guide;
  - the supernode `hybrid` config;
  - for contract authors: `isSupernode()`, `shareVolatile()`, and that volatile is per-node by design;
  - that with open admission, hybrids replicate all non-volatile state.
