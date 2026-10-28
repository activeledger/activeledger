# The activerestore command

`activerestore` repairs a node's copy of the ledger from the other nodes. Left running, it fills in transactions the node missed; with `--full` it rebuilds the whole database, which is how you bring back an empty or badly behind node.

It has no `--help`. Run it from the node's directory: it reads that directory's `config.json` and `.identity`, and talks to the node's own database and to the neighbours the config lists. The node's database must be running: leave the node running, or start only its database with `activeledger --db-only`.

## Flags

| Flag | What it does |
|---|---|
| (none) | Run as a watcher: fix missed transactions as the node reports them, and keep running |
| `--full` | Rebuild the whole database from the other nodes, then run the history pass |
| `--fast` | With `--full`: do not pause between fetches. Only for a node that is not serving anything |
| `--skip-history` | With `--full`: rebuild the state and stop before the history pass |
| `--history-only` | With `--full`: skip the rebuild and run only the history pass |

`--skip-history` and `--history-only` together are refused straight away: it prints `--skip-history and --history-only together leave nothing to do` and exits 1.

## What it needs from config.json

`consensus.reached` must be set. Restore keeps, for each stream, the copy that this percentage of the neighbours agree on. Without it nothing can be a majority, nothing is restored, and it logs:

```
consensus.reached is not set in the config file, so no revision can be a majority and nothing will be restored
```

`neighbourhood` must list the other nodes, and the `db` section must point at this node's database. A node that has been set up and run once has all of these, except on an asserted network with an empty database: there `neighbourhood` and `consensus` have moved to the ledger, and `network` must name the setup stream's current revision, or the other nodes refuse the restore. See [Restoring a node](../operate/restore.md) and [config.json: what you need to set](../operate/configuration.md).

!!! note
    A full restore of a node that holds nothing has to download every stream from the other nodes. With one to three nodes there is little to check an answer against; four or more is better. See [How many nodes, consensus, builds and upgrades](../operate/nodes.md).

## Let the node run it for you

You do not usually start the watcher yourself. When `config.json` has `"autostart": { "restore": true }`, `activeledger` starts `activerestore` beside the node and stops it with `activeledger stop`. You see `Auto starting - Restore Engine` in the node's log, then `Interagent Started`.

If the node logs `autostart.restore is false - this node will not run activerestore`, either set it to `true` and restart, or run the watcher yourself:

```
activerestore
```

Every five seconds it reads the node's error records. For a transaction the node could not run because it never received it (error code 950, stream not found), it asks every neighbour for that transaction, takes the version most of them hold, writes it in and replays the events it raised. Each record is then removed, and the ones that changed something are kept in an archive. It logs `Processing Error Document ...`, `UMID Added ...` and `Document Removed ...` as it goes.

## Rebuild a node from the network

The node's database must be running, because restore writes to it. Leave the node running, or start only its database with `activeledger --db-only`. Then:

```
activerestore --full
```

A full restore is a job: it ends when it has finished (exit 0), or with exit 1 if it could not do its work. It first checks it can reach the node's database; if it cannot, it says `The node's database cannot be reached. Start the node (or its database with activeledger --db-only) and run the restore again` and exits 1.

The passes, in order:

1. **Listing.** Asks every neighbour for the id and revision of every document it holds, and logs `[<node reference>]Running Total: 1200` once per page as the pages come in. The node reference is a long hash that names the neighbour, not its address. For each document, the revision that `consensus.reached` of the neighbours agree on wins. A document with no majority is left as it is.
2. **State.** Fetches each winning document the node does not already hold at that revision, writing it one at a time. Contract streams have their files rebuilt under `contracts/` once everything is written. Logs `[Fetching] <id>` per document and `Restore progress: 500/1200 (480 fetched, 20 already held)` every 500, then `Restored 1180 stream(s); 20 already held at the network's revision` and `Rebuild Complete; Duration: 84213ms`. A document no neighbour would supply after three attempts is logged as `[Not restored]`; run the restore again to retry them.

    The counts are documents, although the log says streams: a stream's state, its `:stream` record and each of its `:umid` transaction records count one each, so a ledger of 5 streams restores as about 27.
3. **History.** The node is usable before this runs. For each stream it walks the chain of transactions back to the first one and fetches any transaction record the node does not hold. Logs `History pass: 1180 stream(s)`, progress every 500, then `History Complete; Duration: ...; 37 umid(s) recovered`, with a warning naming a few streams if any chain could not be completed.

It pauses between fetches so the neighbours can keep serving transactions (5 ms before each stream and 200 ms after every 100), and backs off further when a fetch takes over 400 ms.

A full restore keeps no progress file, so if you have to stop it early, Ctrl+C is safe: the next run skips whatever it already holds and fetches only the rest.

## Bring a node back quickly, do the history later

The state pass is what the node needs to run. When the node is wanted back soon, run the two passes separately:

```
activerestore --full --skip-history
```

Ends after `Rebuild Complete` with `History pass skipped` and exit 0. Start the node, and when there is time:

```
activerestore --full --history-only
```

Logs `Rebuild skipped (--history-only)` and runs only the history pass. It still asks the neighbours for the listing, but fetches no state.

## Restore a node that is not serving anything

When the node is out of the network and the neighbours have capacity to spare, skip the pauses:

```
activerestore --full --fast
```

The same in the config, for every run: `"restore": { "throttle": false }`.

For when to restore, and what to look at first, see [Restoring a node](../operate/restore.md).
