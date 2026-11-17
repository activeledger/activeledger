# Pruning old data

A node keeps three kinds of data that only ever grow: the ledger, the events it has seen, and a record of every error it logged. The ledger is the point of the node and is never touched. The other two are the node's own working records. Nothing in them is part of consensus, so each node can trim its own without any effect on the network.

`activeledger prune` removes what is older than a number of days. It keeps the last 30 days unless you say otherwise.

```
activeledger prune [days] [--include-umids] [--include-events] [--dry-run] [--yes]
                          [--delete-db <name>]... [--no-compact] [--json]
```

`days` is how many days to **keep**: `activeledger prune 14` removes everything older than two weeks. It must be a whole number of at least 1. Run it from the node's directory, with the node running: it works through the node's own storage, which only listens on the machine itself.

Try it first with `--dry-run`. It prints what would be removed and removes nothing.

```
$ activeledger prune 30 --dry-run
Dry run: nothing will be removed. Keeping the last 30 days; removing anything older than 2026-10-18T09:12:44.000Z.
  errors: would remove 41,220 (looked at 52,018, kept 10,798)
  archived errors: would remove 3,904 (looked at 3,904, kept 0)
Would remove 45,124 rows in total.
```

## What it removes

| Store | What is in it | Removed by | Why it is safe |
|---|---|---|---|
| `activeledger` (the ledger) | streams, their histories, contract data | **never** | It is the ledger. |
| `activeledgererrors` | one document per error the node logged, including repair requests | `prune` (only documents already **processed**) | An unprocessed document is a job the restore engine has not done yet, such as "ask the network for this umid". It is never removed, however old. |
| `activeledgererrors_archive` | errors the restore engine has finished with | `prune` | Nothing reads them back. |
| `activeledgerevents`: umid index | one `umid:` row per committed transaction (and `fail:` rows for failures), which since 5.3.0 also carry what a commit attestation is signed from | `--include-umids` | See below. |
| `activeledgerevents`: contract events | what contracts emitted with `this.event.emit` | `--include-events` | See below. |

The events store has two flags because they are different things, and you may want one without the other.

### `--include-umids`

The umid index is read when another node or a hybrid catches up from this node (`/activeledgerevents/umids?from=`), and when a hybrid asks for the attestation of a commit. Once rows older than your window are gone:

- a node that was offline for longer than the window cannot learn about the older umids from this node's list. `activerestore --full` rebuilds from streams and is not affected;
- a hybrid cannot be given an attestation for a commit older than the window. A hybrid's own `window.days` defaults to 30, the same as `prune`.

Choose a window longer than the longest time any node could be offline. Under 30 days, `prune` asks you to confirm (or needs `--yes` when there is no terminal to ask on).

### `--include-events`

Contract events are replayed to anything reading `/activeledgerevents/events` with a `Last-Event-ID`. Once they are gone, a reader resuming from before the window gets no replay, and anything rebuilding a table from past events cannot go back further than the window.

## Other databases

`prune` also asks the storage which databases exist. Anything it does not recognise (not the ledger, the events, the errors or the archive) is listed with its size, and it asks, one at a time, whether to delete that whole database. The answer is no unless you type `y`. An unknown database may belong to another tool using this node's storage, so it is not deleted for you.

- `--yes` skips the confirmation on the umid warning. It never deletes a database.
- With no terminal to ask on, nothing is deleted and each one is listed with the command to delete it.
- `--delete-db <name>` (repeat for more) deletes that database without asking. The node's own four databases are refused even if named, and so is anything that is not a plain name.

## Getting the space back

Removing a row frees its space only when LevelDB compacts. After removing anything, `prune` asks the storage to compact the databases it removed from. `--no-compact` leaves that for later.

## Running it on a schedule

Each node prunes on its own, so there is nothing to coordinate. A weekly job is enough:

```
0 3 * * 0  cd /srv/activeledger && activeledger prune 30 --yes --json >> prune.log
```

A large first prune is paged: it removes a few thousand rows at a time and pauses briefly between pages, so the node keeps its own work going. It can still take a while on a store that has grown for a year.

## Output

`--json` prints one object at the end instead of progress lines: the days kept, the cutoff, what was removed in each store, the databases deleted and left, and the ones compacted.

Exit codes: 0 done, 1 refused or failed (a bad argument, a protected database named, the storage refused a request), 2 the node's storage could not be reached.

## Limits

- It works on the embedded store (the default), not on a CouchDB the node is pointed at.
- The cutoff must be at least an hour in the past; the storage refuses a newer one, so a wrong clock or a typo cannot remove what a node is still using.
- It never touches the ledger database, whatever flags are given.
