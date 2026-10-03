# Activehybrid v5 design

Status: draft for review · 2026-10-03

## Goal

Supernodes are the voting Activeledger nodes. Hybrids are lean, non-voting
nodes that keep their own copy of the ledger data. A hybrid re-runs every
contract locally and commits only what the supernodes agreed. It then relays
the transaction to other hybrids it has discovered.

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
- Each supernode records the hybrid's last subscribe time in that stream's volatile. This is node-local and used for display only.

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

### `/h/*` endpoints, all authenticated

- Auth: a signature over `${key}:${timestamp}` made with the registered key, the same scheme as nano-gateway.
- Endpoints:
  - `GET /h/bootstrap`: the setup stream, the required list, the contract list and the current cursor.
  - `GET /h/feed?from=<cursor>`: an SSE stream of feed items:
    `{umid, outcome, tx, $revs, revsOut, streams:{new,updated}, nodes:{ref:{vote,sig}}}`.
    - The cursor is the events-DB key, `umid:<ms>,<umid>`.
    - Failed transactions get a new `fail:<ms>,<umid>` index.
    - `revsOut` is an unsigned hint, used only to trigger checks.
  - `POST /h/streams`: state and meta for the requested streams, plus volatile for required-volatile streams only. Accepts `{id, rev}` pairs.
  - `GET /h/umid/:umid`.
  - `GET /h/peers`: the registered hybrids.
- The same message set is also served over the hybrid P2P channel (section 3).

### Contract API

- `isSupernode()` is added to the contract base classes, so contracts can wrap supernode-only operations such as volatile writes.
- On a hybrid it returns `false`. `setVolatile` still writes locally there.

### Fixes and removals

- A new shared `resolveContractSource(stream, version)` handles both the base64 format and the v5 umid-reference format (build 40100 and later). Supernode, `restore` and hybrid all use it. This fixes the broken contract rebuild in `restore` and in the old hybrid.
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
- `executor`: `ActiveProtocol.Process` in hybrid mode — a single local node, no votes, no broadcast.
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
   - Execute and commit locally, then compare the result with `revsOut`.
   - If they don't match, run SPI (section 3), adopt the agreed state and write a divergence record.
4. **Failed.**
   - Do a dry run with no writes.
   - If the dry run passes locally, write a divergence record.
5. **Ordering.**
   - Items that share streams apply in `$revs`-chain order. An out-of-order item waits in a holding buffer; after a timeout, `lookup` fetches what it is missing.
   - Items that share no streams run concurrently, up to a small cap.

A divergence record contains: `{umid, kind, supernodeTally, localResult, $revs, revsOut, localRevs, at}`.

### Storage window

- Kept: current state, meta and volatile for every known stream, plus the `:umid` doc that each stream's `meta.umid` points to.
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
- `POST /` forwards the client transaction to a healthy upstream supernode.

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

- Every hybrid serves `/h/feed` with the items it has verified. The supernode signatures are kept on every item.
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
2. Accept if a majority agrees, and the answer also matches `revsOut` when that hint is present.
3. Otherwise escalate to the supernodes and take the majority by revision, as `restore` does.
4. Write a divergence record in every case.

### Abuse controls

- Per-peer rate limits.
- `maxRequestBytes` size caps.
- A peer that serves an item with invalid signatures is dropped and temporarily banned.

### Follow-ups (out of scope)

- Move supernode↔supernode P2P onto the same handshake.
- Authenticate `/a/stream`.

## 4. Versioning, testing, rollout

### Versioning

- Ship as v5.1.0.
- Signed votes are gated by build 40300.
- Hybrids require 40300.
- The CHANGELOG notes the removal of `config.hybrid[]` and the push flow.

### Unit tests

- vote signing and verification;
- holding buffer and ordering;
- pruner window;
- P2P handshake: success, wrong key, replay;
- `resolveContractSource` with both formats.

### Network tests

Add `test:network:hybrid`, running 3 supernodes and 3 hybrids: one HTTP-only, one P2P, and one that is peer-only. Scenarios:

- bootstrap with required streams and volatile;
- lazily learning an unknown stream;
- a contract deployed or updated mid-run;
- a failed-with-votes transaction produces a divergence record;
- tampered local state is repaired by SPI from hybrid peers;
- every supernode down, with the feed continuing over the mesh;
- a forged item causes that peer to be dropped;
- allowlist admission rejects an unknown key.

### Docs

- Rewrite `packages/hybrid/README.md`.
- Add `docs/en-gb/hybrid.md`, covering the operator guide and the supernode `hybrid` config.
