# `restore`: network healing

`@activeledger/activerestore` (`packages/restore/`) watches for a node that's fallen behind or come up with an empty/incomplete data store, and heals it from the rest of the network. Checked against `v4.1.0`; supersedes [`docs/en-gb/restore.md`](../docs/en-gb/restore.md) at a high level — the mechanism below is more detail than that doc had.

Auto-starts alongside a node by default (`autostart.restore`), same caveats as `core` around `--port` and auto-start (see [cli.md](cli.md)).

## Two modes

`ActiveRestore` (`packages/restore/src/index.ts`) picks between two strategies at startup, based on `Provider.isQuickFullRestore`:

- **`QuickRestore`** (`modules/quick-restore/`) — a full, bulk restore. This is what runs when a node's data store is essentially empty and needs to catch up wholesale, rather than patch specific gaps.
- **The normal path** — an `Interagent` (`modules/interagent/interagent.ts`) that listens for specific error events during normal operation and reacts to them individually, rather than doing a bulk resync.

## What `Interagent` actually watches for

It's driven by an explicit allowlist of error codes (`ErrorCodes` enum), and as of `v4.1.0` only one is actually active: `StreamNotFound`. The others are present in the source but commented out — `StateNotFound`, `VoteFailedNetworkOk`, `InternalBusyLocked`, `StreamPositionIncorrect`, `ReadOnlyStreamNotFound`, `NodeFinalReject`, `FailedToSave`, `Unknown`, `FailedToGetResponse` — with inline notes on why some are disabled (e.g. `NodeFinalReject`'s comment: "they voted no as their data was different?", `FailedToSave`'s: "we do position incorrect fix real time" elsewhere). If you're debugging why a specific class of error *isn't* triggering an automatic fix, this list — not just whether the error occurred — is the first thing to check. Duplicate error entries arriving close together are filtered out (`REMOVE_CACHE_TIMER`, 5 minutes) so a burst of the same error doesn't trigger redundant repair attempts.

## Relationship to the consensus layer

This package reacts to symptoms surfaced by the network/protocol layers (see [architecture.md](architecture.md)) rather than participating in consensus itself — it's a separate process watching the same node's error stream and stepping in when something needs fixing. If you're chasing a "network eventually self-heals but slowly" kind of issue, this is where to look; if votes/commits themselves are behaving unexpectedly, that's the network/protocol layer instead.
