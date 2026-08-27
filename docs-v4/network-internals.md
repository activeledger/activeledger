# Network internals

[architecture.md](architecture.md) covers the consensus/gossip model and [transport.md](transport.md) covers how nodes talk to each other. This is the layer underneath both: what a node's "reference" actually is, how a node tracks its neighbours' state, and how transaction processing is actually parallelised across CPU cores. All from `packages/network/src/network/*.ts`, checked against `v4.1.0` — none of this had prior documentation.

## What "reference" means

Every node identity shown in `/a/status`, `$origin`, and the `$nodes` map (see [architecture.md](architecture.md)) — the hex strings like `b6710c3b8253f4cb2878449d9b688678a18b0712` — is a **SHA-1 hash of that node's host, port, and the configured `network` identifier** (`neighbour.ts`): `Hash.getHash(host + port + network, "sha1")`. It's deterministic and derived purely from network-visible connection info, not from the node's actual RSA identity keypair — two different concepts that are easy to conflate. A node's `.identity` file (its keypair) is what it signs with; its `reference` is what everyone else calls it by.

If a node's address genuinely changes (migrated to a new host/port) but it should still be treated as the same participant, there's a remapping table (`Neighbourhood.remapedAddr`) that translates an old reference to a new one — checked right after every reference is computed, both for a node's own identity (`home.ts`) and for every neighbour (`neighbour.ts`).

**Every `Neighbour` instance owns its own P2P client connection** when `p2pStream` is enabled — instantiated directly in `Neighbour`'s constructor, connecting to `port + 1` (see [transport.md](transport.md)). This is worth knowing if you're debugging P2P specifically: it's not one shared connection pool, it's one persistent socket per neighbour relationship.

## Neighbour status is a small state machine

`NeighbourStatus` (`neighbourhood.ts`): `Unrecognised → Pairing → Recognised`, plus `Unstable`/`Stable` as separate states. The numeric value is exactly what `/a/status`'s `status` field reports — `4` is `Stable` (index 4 in the enum), which is what a healthy node reports once it has a settled view of its ring neighbours. If you see a node stuck below `4`, that's a real signal something about its neighbourhood view hasn't settled — worth checking `maintain.ts`'s ring-consistency logic (see [architecture.md](architecture.md#two-propagation-modes-gossip-broadcast-vs-ring-relay)) before assuming it's a transient startup state.

## The worker process pool

Each transaction's vote/commit logic runs in a separate forked child process (`child_process.fork()`, `host.ts`'s `createProcessor()`), running the compiled output of `network/src/network/process.ts` (a different file from `protocol/src/protocol/process.ts` — the network-layer process wrapper vs. the protocol-layer consensus state machine; easy to confuse by name alone). One processor per physical CPU core, dispatched round-robin (a cycling iterator over the pool, `processorIterator`) — this is the concrete mechanism behind [architecture.md](architecture.md)'s claim that unrelated transactions process concurrently across cores.

**There's always one extra, already-forked, idle process sitting ready** (`standbyProcess`) beyond the per-core pool. If an active processor crashes, the standby is pushed into the active pool immediately — instant recovery, no `fork()` latency on the failure path — and a *new* standby is created in the background to restore the "one warm spare" invariant. If you're watching process counts on a node and see one more `process.js` child than you'd expect from the core count alone, that's this spare, not a leak or a miscount.

## Firewall

`firewallCheck()` (referenced throughout `host.ts`'s endpoint handlers — e.g. gating `/a/all`, `/a/init`) restricts a set of internal/administrative endpoints to requests originating from addresses already in the neighbourhood, keyed off the same `firewall` map `Neighbourhood` builds from each neighbour's host (`neighbourhood.ts`). This is separate from the `CORS` config (see [configuration.md](configuration.md)) — CORS governs browser-originated requests, the firewall check governs which endpoints are reachable at all from a non-neighbour address regardless of origin header.
