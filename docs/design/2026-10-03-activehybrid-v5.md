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
| Event scope | An operator can pin a filter (contracts, and equality on payload fields) onto a hybrid's `/events`. It limits what the API serves; it does not limit what the hybrid stores (see "Events"). |
| Deploy refusal | A hybrid never forwards contract deploys, namespace claims, setup or fund transactions, whatever key signs them. Fail closed, not configurable. `default/onboard` is refused by default, behind a config switch. |
| Health | `GET /health` reports sync lag in seconds, so consumers can refuse to act on a stale hybrid. |

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
  "window": {"days": 30},
  "minVersion": "5.1.0"
}
```

- `minVersion` is the oldest hybrid release allowed to follow this network. It is on-ledger so every supernode serves the same value, and it is raised when a release changes how contracts execute (see "Minimum version").
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
- `adoptFromSupernode(description)` on an activity stream is the **adopt safety net**. Contract developers are advised to call it in the `else` branch of every `isSupernode()` check, describing exactly what the supernode branch writes:

  ```ts
  if (this.isSupernode()) {
    const sig = await signWithCvm(tx);            // external call, supernodes only
    wallet.setState({ ...state, signature: sig, status: "signed" });
  } else {
    wallet.adoptFromSupernode({ signature: "string", status: "string" });
  }
  ```

  - The description maps property names to `"string" | "number" | "boolean" | "object" | "array" | "any"`. A nested object describes nested properties.
  - **Optional:** a `?` suffix (`"string?"`, `"object?"`) means the supernode branch may set the property, leave it absent, or delete it. Example: Broadcast writes `broadcastedAt` only when the chain accepts the transaction.
  - **All-or-nothing:** `adoptFromSupernode(shape, { atomic: true })` requires that the declared properties differing from the local result are either none or all of them. Example: an inter-node comms redistribute that writes every field or commits nothing.
  - **Candidate streams:** when supernode-only work decides *which* streams change, use the contract-level `this.adoptStreamsFromSupernode([ids], shape, opts?)`.
    - Each listed stream may come back unchanged, or changed only within `shape`.
    - The ids must be among the transaction's `$i`/`$o`, so the declaration can never widen what can be written.
    - Example: Deposit, where a node-local "already deposited" check decides which balances update.
  - On a supernode the call does nothing. On a hybrid it records the declaration for adopt mode (section 2).
  - When the supernode branch creates a stream, the `else` branch creates the same stream with placeholder values and declares its properties. Adopt mode rejects documents that have no local counterpart.
  - The same pattern covers inter-node comms: declare whatever properties the inter-node comms round writes.
- **Volatile and adopt mode.**
  - `revsOut` covers state, `:stream` meta and `<contractId>:data`, not volatile. A volatile write by a supernode is therefore never adopted; it stays on that supernode unless `shareVolatile()` is used.
  - What adopt mode can express is the state that depends on volatile. A vote or output derived from volatile is handled by wrapping the volatile read in `isSupernode()` and declaring the dependent properties in the `else` branch with `adoptFromSupernode`. The hybrid then adopts the attested state, not the volatile.
  - A contract that reads volatile without the wrap still ends up adopted, because the read marks the execution supernode-dependent (section 2). It is adopted whole and emits `adopt.undeclared`, which is the prompt to add the declaration.
  - A volatile write left unwrapped writes to the hybrid's own local volatile. That copy can differ from the supernodes' and nothing reads it through the hybrid API in v1.
- `shareVolatile()` sets `volatileShared: true` in the stream's `:stream` meta during commit. Meta is part of consensus, so every node agrees on whether that stream's volatile may be served. Without it, volatile never leaves the node, whatever the supernode config lists. Volatile is per-node by design; contracts that keep secrets in it, such as key shares, simply never call this.
- Contracts always see the transaction's consensus time: `cDate` is `entry.$datetime`, the entry node's stamp (`process.ts` passes `date: this.entry.$datetime` to the VM). A hybrid never uses its own clock when it executes a committed item from the feed. This is a stated guarantee: a contract that takes its time only from `cDate` behaves identically on a hybrid and a supernode, and needs no `isSupernode()` wrap.
  - The one exception is the dry-run vote on a user transaction. The entry supernode has not stamped `$datetime` yet, so the dry-run uses the hybrid's clock as a provisional entry time. A contract whose vote depends on the exact time can therefore vote differently from the supernodes near a boundary; that is a stale-style "no" or "yes" the supernodes still settle.

### Relayed transactions (`$relay`)

- A hybrid submits a user's transaction to `POST /` with:
  `$relay: {key, sig}`, where `sig` is the hybrid's signature over `$umid`.
- The entry supernode removes `$relay` from the body **before** computing `$umid = hash(JSON(tx))` (`endpoints.ts` `ExternalInitalise`, which today hashes the whole body). It re-attaches `$relay` afterwards, beside `$origin` and `$remoteAddr`. The `$umid` is therefore identical whether or not the transaction arrived through a hybrid, and matches the hybrid's own computation.
- **Relayed transactions must set `$tx.$expire`.** Today `ExternalInitalise` hashes the body for `$umid` before it sets `$datetime` only when `$expire` is present. Without `$expire` it stamps `$datetime` first and hashes after, so the `$umid` depends on the entry supernode's clock: a hybrid cannot know it before forwarding, cannot sign it into `$relay`, and a resend of the same signed body gets a new `$umid` instead of being detected as a duplicate. A hybrid therefore refuses to relay a transaction without `$expire` (`"denied"`). Nothing changes for transactions sent straight to a supernode.
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
  - the contract reads the volatile of a stream whose volatile this hybrid does not hold (that is, one not listed as required-volatile with `volatileShared`). Volatile is per-node and is not covered by `revsOut`, so the hybrid's empty volatile would otherwise change the vote or the outputs;
  - the contract uses inter-node comms: `getInterNodeComms()`, `setThisInterNodeComms()` or `clearAllInterNodeComms()` (`contracts/src/stream.ts`). Inter-node comms data comes from the supernodes' `$nodes` exchange during voting, which a hybrid never sees.
- `lookup`.
- `mesh`.
- `api`.
- `pruner`.

### Config

The schema is flat and documented, so an operator can template it from a single tenant config file:

```json
{
  "upstreams": [{"host": "", "port": 0, "transport": "p2p|http"}],
  "peers": [],
  "bind": "127.0.0.1",
  "port": 5270,
  "token": "<bearer token>",
  "window": {"days": 30},
  "maxLagSeconds": null,
  "refuseOnboard": true,
  "events": {"contracts": ["<contract>"], "where": {"<field>": "<value>"}},
  "submit": {"contracts": ["<contract>"]}
}
```

- `token`: a static bearer token the local API requires. Absent means the API is open to whoever can reach `bind`, which is why `bind` defaults to localhost. Signed-request keys, as nano-gateway uses, are a later option.
- `refuseOnboard`: defaults to `true`. While it is true, `default/onboard` transactions are refused like the other built-in refusals. Set it to `false` for an operator that onboards identities through the engine-native contract.
- `maxLagSeconds`: optional, absent by default. When set, `/health` also returns 503 beyond this lag, for an operator who wants a load balancer to take a lagging hybrid out of rotation. Without it, lag never changes the status code and the consumer decides from `lagSeconds`.
- `events`: the pinned event filter (see "Events"). Absent means no filter.
- `submit.contracts`: optional. If set, `POST /` accepts only these contracts.

### Bootstrap

1. Register with the registry contract, if not already registered.
2. Authenticate.
3. Call `/h/bootstrap`.
4. Pull the setup stream, the required streams (with volatile where flagged) and every contract. Build each contract's source.
5. Store the cursor and mark the node ready.

The feed starts only after the node is ready.

### Minimum version

A hybrid re-executes contracts with its own copy of the engine. If that copy is older than the supernodes' it can execute a contract differently, and the result would be false divergence records and false "no" votes, not a real fault.

- `/h/bootstrap` returns `minVersion` from the on-ledger `hybrid.minVersion`.
- A hybrid compares its package version with it at bootstrap and on every head poll (so a raise on a running network is noticed).
- Below the minimum, the hybrid is **outdated**:
  - it stops applying feed items and stops relaying; it does not write divergence records;
  - `/health` returns `ready: false` (HTTP 503) with `reason: "outdated"` and `minVersion`, and `activehybrid status` exits 2 with the same message;
  - `POST /` returns `"unavailable"`, so a client falls back to a supernode;
  - reads still work from the local copy, and `lagSeconds` keeps growing so consumers that gate on lag stop trusting them;
  - it resumes from its stored cursor once upgraded, with no re-sync.
- A hybrid newer than the supernodes is allowed. The build gate (40300) is separate and still applies.
- The release process raises `hybrid.minVersion` only when a release changes contract execution or the signed formats, and the CHANGELOG says so. A release that does not touch those leaves it alone.

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
   - **Mismatch, and the execution was supernode-dependent:** this is expected, because the contract behaves differently off a supernode. Switch to **adopt mode**, which is a narrow, declared SPI rewrite:
     - gather `consensus.reached` matching commit attestations (feed item plus `GET /h/attest/:umid`);
     - fetch each output by `{id, rev}` from hybrid peers first, then supernodes;
     - check each fetched document's sha256 against `revsOut`;
     - **safety-net check**, for documents with `adoptFromSupernode` declarations:
       - remove the declared properties from both the signed document and the local result; what remains must be identical;
       - each declared property in the signed document must have its declared type; an optional (`?`) property may also be absent;
       - `atomic`: the set of declared properties that differ from the local result must be empty or complete;
       - `adoptStreamsFromSupernode`: every changed document must be a listed candidate and differ only within the shape; an unchanged candidate is valid;
       - a signed document with no local counterpart is rejected;
       - if any of these fail, it is a real divergence: run SPI and write a divergence record;
     - **undeclared**: a supernode-dependent execution with no declaration adopts the whole signed document and emits an `adopt.undeclared` warning event naming the contract and entry, so missing safety nets are visible;
     - save the documents. No divergence record. Local vote: **verified yes**.
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
- Binds to localhost by default. It can optionally be exposed behind a bearer `token`.
- **Filtering.**
  - Clients may filter with `?contract=<id>` (repeatable) and `?where=<field>:<value>`. A `where` is an equality test on a top-level payload field.
  - The operator can pin a filter in config (`events`). A pinned filter applies to every client; clients may narrow it but never widen it.
  - An event that lacks a pinned `where` field is excluded (fail closed).
  - When a `where` filter is pinned, `tx.committed`, `tx.failed` and `divergence` events are not served, because they carry no payload fields to match. Only contract events are.
  - Resume with `Last-Event-ID` applies the same filter, so a gap replays only the events the client is allowed to see.
- **What the filter is not.** On-ledger data is not secret. The filter exists so that a tenant's feed does not carry other tenants' activity. It limits what the API serves, nothing more: the hybrid still stores everything it replicates, `GET /stream/:id` is not filtered, and whoever operates a hybrid can read their own copy. It is isolation between API consumers, not confidentiality.

### API

- `GET /stream/:id` returns the same document the supernode console returns for a stream: state and the `:stream` meta, including authorities. Reading volatile through the hybrid API is out of scope for v1. `GET /umid/:umid`. An unknown stream is fetched lazily and cached.
- `GET /health` returns `{ready, reason, version, minVersion, lagSeconds, cursor, upstreams:[{host, ok}]}`. `reason` is absent when ready, and otherwise one of `"starting"` or `"outdated"` (see "Minimum version"). `ready` is a boolean that is false until bootstrap completes. `version` is the hybrid's package version, so a consumer can tell which release it is talking to.
  - `lagSeconds` is the time since the hybrid last confirmed it was at the upstream head, by a head poll or a feed heartbeat. It is not the age of the newest item, so a quiet ledger does not read as lagging.
  - It returns 503 when `ready` is false, and returns 200 otherwise with `lagSeconds` in the body, so a consumer with a stricter limit than the operator's can apply its own. Only when the operator sets `maxLagSeconds` does a lag beyond it also return 503.
- **Staleness.** A read serves the hybrid's local copy, so it can trail the supernodes by the reported lag. A consumer that cannot tolerate that (a fee quote, for example) should gate on `/health`. `POST /` always refreshes its streams to the current tip before voting (step 2 below).
- `POST /` accepts a user transaction and handles it as follows:
  0. **Refuse** before anything else if the transaction is a contract deploy, a namespace claim or a setup or fund transaction (`default/contract`, `default/namespace`, `default/setup`, `default/fund`), or an onboard transaction (`default/onboard`) while `refuseOnboard` is true, or if the transaction has no `$tx.$expire` (see "Relayed transactions"), or if `submit.contracts` is set and the contract is not listed. Only the `default/onboard` refusal is configurable. The refusal applies whatever key signs, and applies equally to transactions arriving through `tx-forward` from a mesh peer. Supernodes still enforce `security.deploy` and contract ownership independently.
  1. Compute the `$umid` and run basic checks: entry shape, signatures, `$expire`.
  2. Refresh the input and output streams to their current tips with `lookup`, so a stale local copy cannot cause a false "no".
  3. Run a **local dry-run vote** with no writes. If the execution becomes supernode-dependent (an `isSupernode()` check, a blocked external call, or inter-node comms) and everything before that point passed, the vote is a **conditional yes**. Examples of what has passed by then: signatures, permissions, inputs, and the contract's own checks.
  4. If the vote is no, return the contract's error to the user. Nothing is forwarded.
  5. If the vote is yes or conditional yes, attach `$relay` and forward the transaction to a healthy upstream supernode. If no supernode is reachable, forward it to a mesh peer that has one; that peer sends it on as-is and keeps the original `$relay`.
  6. Return the supernode's response to the user unchanged.
- **Outcomes of `POST /`.** A client must be able to tell where an outcome came from.
  - A response the supernode produced (accepted with `$umid` and `$summary`, refused by the vote with the contract's reason, or a commit failure) is passed through unchanged and carries no `$hybrid` field.
  - A response the hybrid produced carries `$hybrid` naming why. The values are a fixed enum, exactly `refused`, `denied`, `unavailable` and `unanswered`, so a client can switch on it; a new value would be a breaking change and is listed in the CHANGELOG:
    - `"refused"`: the local vote was no. The body has the contract's error text. Nothing was forwarded.
    - `"denied"`: step 0 refused it (deploy, namespace claim, setup, fund, onboard while `refuseOnboard`, a missing `$expire`, or an unlisted contract).
    - `"unavailable"`: no supernode and no mesh peer was reachable. Nothing was forwarded.
    - `"unanswered"`: the transaction was forwarded but no answer came back in time. The body carries the `$umid`, which the hybrid computed before forwarding.
  - The hybrid never retries a forwarded transaction itself. After `"unanswered"` the client should look the `$umid` up (`GET /umid/:umid` on the hybrid once its feed has caught up, or on a supernode) before sending the transaction again.
  - A local "no" is judged against the hybrid's copy refreshed to the tip in step 2, but it can still be stale. A client that is told `"refused"` and believes the transaction should pass can send it to a supernode directly.
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

- Supernodes cap concurrent hybrid feeds (`hybrid.maxFeeds`, set per supernode in its own config, not on-ledger) and rate-limit per registered key. Open admission lets any key register, so without a cap each hybrid costs a supernode a long-lived feed. Registry streams themselves are not limited in v1.
- Per-peer rate limits.
- `maxRequestBytes` size caps.
- A peer that serves an item with invalid signatures is dropped and temporarily banned.

### Follow-ups (out of scope)

- Move supernode↔supernode P2P onto the same handshake.
- Authenticate `/a/stream`.
- A first-class node-local index API, so hybrids can rebuild indexes such as Varnir's `activeledger_wallets` and `activeledger_deposits` from adopted streams. Contracts that read node-local indexes in their vote always take the adopt path on hybrids until then.

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
| `options` | existing | The shared CLI layer: subcommand dispatch, `--help`, unknown-flag check, `--json` output and exit codes (see "Command line") | supernode CLI, hybrid CLI |
| `protocol` | existing | A hybrid mode for `Process`: one local node, no vote broadcast, a dry-run option, and `isSupernode` passed to the VM | supernode, hybrid |

Each extraction is a move-and-import, and the existing tests must pass unchanged before any hybrid code depends on the moved code. Extraction is the first part of sub-project 1.

## Command line

Today the CLI is `minimist` flags with no subcommands, no `--help`, and no error for an unknown flag: a typo such as `--assrt` silently starts a node. The hybrid adds operator actions (list, register, stop) that do not fit "one flag starts or does one thing". `activeledger` and `activehybrid` must also feel like one tool, and the "no duplicated code" rule applies to the CLI as much as to the protocol.

### One shared command layer

- The parsing, subcommand dispatch, `--help` text, unknown-flag check, `--json` output and exit codes live once, in the existing `@activeledger/options` package (which already owns `ActiveOptions`). Both programs register their commands with it.
- **Subcommands are positionals** (`minimist` already puts them in `_`). Every existing flag (`--stop`, `--stats`, `--restart`, `--assert`, `--assert-network`, `--sign`, `--public`, `--testnet`, `--merge`, `--setup-only`, `--db-only`, `--disable-autostart`, `--data-dir`, `--port`, `--host`, `--config`, `--identity`, `--debug`, `--version`) keeps working unchanged. Where a subcommand replaces one, the flag stays as an alias.

### Common to both programs

| Command | Does |
|---|---|
| `start` (default) | Run the node. `--foreground` stays attached; otherwise it writes a PID file. |
| `stop` / `restart` | Signal the PID-file process and wait for it to exit (`--timeout <s>`). Aliases of `--stop` and `--restart`. |
| `status` | Print the node's state. Exit 0 ready, 2 not ready. `--max-lag <s>` makes lag beyond it exit 2. |
| `check-config` | Validate the config file and exit 2 with the reason if it is wrong. |
| `version` | Print the version and, for a hybrid, the engine build it supports. Alias of `--version`. |
| `help [command]` | The same as `--help`. |

| Flag | Meaning |
|---|---|
| `--config <file>` | Config file. Default `./config.json` for a supernode and `./hybrid.json` for a hybrid. |
| `--identity <file>` | Identity file. Default `./.identity` for both. |
| `--data-dir <dir>` | Data directory. |
| `--host <addr>` / `--port <n>` | Bind address and port. Defaults are `127.0.0.1:5260` for a supernode and `127.0.0.1:5270` for a hybrid, so both can run on one machine. |
| `--debug` | Debug logging. |
| `--json` | Machine-readable output on any command that prints data. |
| `--yes` | Skip the confirmation on a destructive command. |
| `--help` | Show usage for the program or the command. |

- **An unknown command or flag stops the program.** It prints what was not recognised, the nearest known name if there is one, a pointer to `help`, and exits 1 before anything starts. This applies to the existing start-up path too, so a typo such as `--assrt` can no longer start a node. Every flag the code reads today is registered, so only a flag nothing reads is affected; a deployed script that passes one will fail, which makes this a breaking change listed in the CHANGELOG for 5.1.0.
- **Exit codes** are stable and the same in both: 0 success, 1 failure, 2 a state check failed (not ready, lagging, outdated, not registered).
- Flags are kebab-case and mirror config keys (`--max-lag-seconds` is `maxLagSeconds`). A flag overrides the config file.

### `activehybrid` only

| Command | Does |
|---|---|
| `init [--upstream host:port[:p2p\|http]]...` | Create the identity and write the flat config. Refuses to overwrite either unless `--force`. |
| `register [--label x] [--endpoint p2p://host:port]...` | Submit the registry `register` transaction through an upstream. Idempotent: a registered key reports it and exits 0. |
| `update --endpoint ...` / `retire` | The matching registry entries. `retire` asks for `--yes`. |
| `peers` | Known hybrid peers and which are connected. |
| `divergences [--since <time>]` | List local divergence records. |
| `prune [--dry-run]` | Run the pruner now. |
| `token` | Print a new random bearer token for the config. |

`register`, `update` and `retire` sign with the hybrid's own key, so the node does not need to be running. `status` reads the local `/health`.

### `activeledger` only (supernode)

| Command | Does |
|---|---|
| `hybrid list` | Registered hybrids: key hash, label, endpoints, retired, and whether a feed is connected to this supernode. |
| `hybrid feeds` | Feeds connected to this supernode, their cursor lag, and the count against `hybrid.maxFeeds`. |
| `hybrid allow <key\|file>` / `hybrid deny <key>` | Change the `hybrid.admission` allowlist. This is an on-ledger setting, so it goes through the same assert path as `security` and `consensus`. |
| `hybrid ban <keyhash>` / `hybrid unban <keyhash>` | Refuse feeds from a key on this supernode only. Local and not consensus, for dealing with abuse under open admission. |

New start-up flags: `--hybrid-listen <port>` (the P2P listener) and `--hybrid-max-feeds <n>`. The `--hybrid-list`, `--hybrid-register`, `--hybrid-stop` form is not used: the first and the last would act on different programs, and subcommands leave room for the rest.

### Help

`help` (and `--help`, and running with no command on a terminal that is asked for help) lists every command and flag for the program, grouped as in the tables above, with one line each and the defaults.

- **Header.** The page opens with a short banner and a tagline. The banner is a chain of three linked blocks:

  ```
   [###]==[###]==[###]
     activeledger 5.1.0
  ```

  `activehybrid` draws the same chain with the last block hollow, `[###]==[###]==[   ]`, as a hybrid is the link that follows the others.
- **Easter egg.** The tagline is picked at random from a small list kept in the shared `options` package, and on a rare roll (about 1 in 50) the chain "breaks" in the drawing: `[###]==[###]=/=[###]`, with a tagline that says the fork is only for display. The list is a plain array so contributors can add to it.
- **Plain output.** The banner and tagline are left out when output is not a terminal, when `NO_COLOR` is set, and with `--json` or `--quiet`, so scripts that parse help never see them.
- Help for one command (`help hybrid`) prints no banner, only the usage.

### Open choices

- Whether `activehybrid` also ships as `activeledger hybrid ...` for operators who install one package.

## 4. Versioning, testing, rollout

### Packaging

- A pinned image tag per release, matching the npm version, so a deploy script can pin it.
- The flat config schema above is the contract between the hybrid and whatever templates it. Changes to it are listed in the CHANGELOG.
- Footprint is a target to be measured, not a promise: idle and catch-up memory figures are recorded in the operator guide once the hybrid exists.

### Versioning

- Ship as v5.1.0.
- Signed votes are gated by build 40300.
- Hybrids require 40300.
- The CHANGELOG notes the removal of `config.hybrid[]` and the push flow.

### Unit tests

- vote and commit-attestation signing and verification, including `revsOut` sha256 and `umidDocHash`;
- the sandbox blocks each egress module and marks the execution supernode-dependent;
- safety-net comparison: declared properties removed, the rest must be equal, types checked, nested descriptions, no local counterpart;
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
- a contract deploy, namespace claim, setup or fund transaction submitted to a hybrid is refused, whatever key signs it, and a `tx-forward` from a peer is refused the same way;
- `default/onboard` is refused by default and accepted when `refuseOnboard` is false;
- the API rejects a request without the bearer `token` when one is configured;
- a contract that reads volatile it does not hold is marked supernode-dependent: a user transaction gets a conditional yes instead of a false no, and a committed item is adopted, with `adopt.undeclared` when nothing is declared;
- `submit.contracts` rejects an unlisted contract;
- a user transaction without `$expire` is refused as `denied`; one with it gets the same `$umid` from the hybrid and from the entry supernode, and a resend is detected as a duplicate;
- a supernode refuses a new feed beyond `hybrid.maxFeeds`;
- a hybrid below `hybrid.minVersion` stops applying items, writes no divergence record, reports `ready: false` with `reason: "outdated"`, answers `POST /` as `unavailable`, and resumes from its cursor after an upgrade; a raise of `minVersion` on a running network is noticed on the next head poll;
- the CLI: `--help` and `--json` work on every command in both programs; an unknown command or flag, including on the start-up path, exits 1 with a suggestion before anything starts; `help` lists every command, shows the banner on a terminal, and omits it with `--json`, `--quiet`, `NO_COLOR` or a pipe; `status` exits 2 when not ready; the existing flags still work;
- `POST /` marks every hybrid-produced outcome with `$hybrid` (`refused`, `denied`, `unavailable`, `unanswered`) and passes supernode responses through without it; `unanswered` carries the `$umid`;
- a pinned `events` filter serves only matching events, excludes events missing the pinned field and `tx.*` events, cannot be widened by a client, and applies on `Last-Event-ID` resume;
- `/health` reports lag against the upstream head, not the newest item, and returns 503 only when not ready, returning 200 with `lagSeconds` however large the lag, unless `maxLagSeconds` is set;
- `GET /stream/:id` returns the :stream meta with authorities;
- volatile is not served for a stream without `volatileShared`, even when the stream is listed as required-volatile;
- adopted output whose sha256 does not match `revsOut` is rejected;
- with `adoptFromSupernode` declared, a signed output that also differs in an undeclared property is treated as a divergence, not adopted;
- a declared property of the wrong type is treated as a divergence;
- a supernode-dependent contract without a declaration is adopted wholesale and emits `adopt.undeclared`;
- optional properties: present, absent and deleted are all accepted; a wrong type is rejected;
- `atomic`: a partial change is rejected; all-changed or none-changed is accepted;
- `adoptStreamsFromSupernode`: a change to a non-listed stream is rejected; listed streams changed or unchanged are accepted.

### Docs

- Rewrite `packages/hybrid/README.md`.
- Add `docs/en-gb/hybrid.md`, covering:
  - the operator guide;
  - the supernode `hybrid` config;
  - for contract authors: `isSupernode()`, the advised `adoptFromSupernode` safety net with worked examples, `shareVolatile()`, and that volatile is per-node by design;
  - that with open admission, hybrids replicate all non-volatile state.
