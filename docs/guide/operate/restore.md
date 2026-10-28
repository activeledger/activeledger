# Restoring a node

How to bring a node's data back in line with the rest of the network, with `activerestore`.

## When to restore

A running node repairs small gaps on its own: the restore engine started beside it (`autostart.restore`) watches the error database and fetches transactions the node missed, and SPI repairs a stream when the node next votes on it (see [Nodes](nodes.md)). Run a full restore when that is not enough:

- a new node is joining and has an empty database;
- a node was off for a long time, or lost its data folder;
- a node keeps voting no while the others commit.

A full restore asks the other nodes, so they must be running, and this node must already be in their neighbourhood.

## Running a full restore

Run it in the node's folder, where `config.json` and `.identity` are. The node's database must be running: leave the node running, or start only its database with `activeledger --db-only`.

```
activerestore --full
```

It has no help output; it starts straight away. It is a job: it ends when it has finished (exit 0), or with exit 1 if it could not do its work. If it cannot reach the database it says `The node's database cannot be reached. Start the node (or its database with activeledger --db-only) and run the restore again` and exits 1. It logs `Starting Quick Full Restore`, then `Restore progress: 500/12000 (480 fetched, 20 already held)` every 500 documents, and runs three passes:

1. **State.** It asks every other node for the list of streams it holds and the revision of each. For each stream it keeps the revision that enough nodes agree on (the same bar as SPI: the `consensus.reached` percentage of all nodes, less one for this node, rounded up) and fetches that copy. A stream this node already holds at that revision is skipped. A stream where no revision reaches that bar is left as it is.
2. **Contract files and locks.** For every contract stream it rebuilds the compiled contract under `contracts/<namespace>/` from the source the ledger holds, and writes back the lock files the stream records. A version whose source it cannot find is logged with `Cannot rebuild` and skipped.
3. **History.** The lowest priority pass: it walks each stream's chain of transactions back to the start and fetches any transaction document a majority of nodes still holds but this node does not. The node is already usable before this runs.

It logs `Rebuild Complete`, `Restored N stream(s); M already held at the network's revision`, then `History Complete; ... K umid(s) recovered`, and exits. `N`, `M` and the `Running Total` and `Restore progress` figures count documents, although the log says streams: a stream's state, its `:stream` record and each of its `:umid` transaction records count one each, so 5 streams restore as about 27.

## The throttle

A full restore asks the same nodes that are taking transactions, so it goes gently: it pauses 5 ms before each stream and a further 200 ms after every 100, and while a node is slow to answer (over 400 ms) it doubles the pause, up to 5 s, easing back as answers speed up.

Tune it in the `restore` section of `config.json`:

```json
"restore": {
  "throttle": { "pauseMs": 5, "batch": 100, "batchPauseMs": 200, "slowMs": 400, "maxBackoffMs": 5000 }
}
```

Leave out any value to keep its default. `"throttle": false` turns it off.

## Flags

| Flag | What it does |
|---|---|
| `--fast` | No throttle. For a node that is not serving anything yet, on a network with spare capacity. |
| `--skip-history` | Stop after the state and contract passes. Same as `"restore": { "history": false }`. |
| `--history-only` | Run only the history pass, for a node restored earlier with `--skip-history`. With `--skip-history` it is refused: `--skip-history and --history-only together leave nothing to do`, exit 1. |
| `--config <file>` | Another config file. |

Bring a node back quickly, then fill in history when there is time:

```
activerestore --full --skip-history
activerestore --full --history-only
```

The history pass takes its own settings under `restore.history`: `minAgree` (how many other nodes must hold the identical document; default is the same bar as the state pass), `hopDelayMs` (pause between hops, default 50) and `walkLimit` (default 1000000).

## Stopping early and carrying on

It ends on its own when it finishes. If you have to stop it before then, Ctrl+C is safe. It keeps no progress file: what it already wrote is now held at the network's revision, so the next run skips it and fetches only the rest. A transaction's events are replayed before its document is written, so a stop in between loses nothing. Streams no node could supply are listed at the end with `could not be restored, run the restore again to retry them`; running it again retries them.

## What it never copies

Volatile data is private to each node and is never fetched, served or created by a restore. The contract that sets it makes it again.

## What it cannot recover

- A contract lock made before 5.1.0, or a `lock` or `unlock` transaction that did not name the contract stream as its output. Those were only files on each node and are not recorded anywhere a restore can read.
- A contract version whose source the ledger no longer holds (an old inline copy that was converted to a reference, and whose deploy transaction this node cannot fetch). The version is skipped and the rest of the restore carries on.
- A stream where two revisions have equal support at the same position. That is a fork and needs a person; restore leaves the stream alone.

## Checking it worked

Read the log. A good run ends with `Rebuild Complete`, a `Restored` line with no `could not be restored` warning after it, `History Complete`, and exit code 0. Then start the node (if you ran only its database, stop that with Ctrl+C first) and confirm it is ready:

```
activeledger status
```

You should see `ready (pid 12345)`. Send a transaction and check the `$summary` in the reply: `commit` is 1 or more and there is no `errors`.

!!! warning
    If the log says `consensus.reached is not set in the config file`, nothing is restored. On an asserted network that value lives on the ledger, and a node with an empty database cannot read it from there yet: put `"consensus": { "reached": 60 }` (your network's value) and the full `neighbourhood` into the file for the restore, then start the node as usual.

    On an asserted network an empty node needs one thing more: `network` set to `"<setup stream id>@<the setup stream's _rev>"`. A node names itself to the others with a hash of its host, port and `network`, so without the right revision they refuse it with 403 and the restore ends with `Request Failed` and exit 1. The setup stream id is the part of `network` before the `@` in any node's `config.json`. Read the `_rev` from a running node:

    ```
    curl -s -X POST http://<node>/a/stream -H 'Content-Type: application/json' --data '{"$streams":["<setup stream id>"]}'
    ```

    A restore of a node that still has its database works without any of this.
