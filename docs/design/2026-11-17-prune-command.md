# `activeledger prune <days>`: keeping what a node needs, dropping what it does not

Status: plan, not built. Written 2026-11-17 after a Varnir question about whether `activeledgerevents`
is ever pruned. Today it is not: nothing in the node deletes by age, and the only way to shrink these
stores is to delete a whole database.

## Goal

A command that removes data older than a window from the node-local stores that grow without bound,
and never touches the main ledger database. `days` is how many days to **keep**; the default is 30.

```
activeledger prune [days] [--include-events] [--include-umids] [--dry-run] [--yes]
                          [--delete-db <name>]... [--no-compact]
```

All of it is per node. These stores are outside consensus, so each node prunes on its own and nothing
changes on the network.

## What is stored where

| Database (default name) | Holds | Grows by | Read back by | Pruned by |
|---|---|---|---|---|
| `activeledger` (`db.database`) | streams, `:stream` metas, `<umid>:umid` documents, contract data | every transaction | everything: consensus, SPI, restore history walk | **never** |
| `activeledgerevents` (`db.event`) | `umid:<ms>,<umid>` and `fail:<ms>,<umid>` index rows (from 5.3.0 these also carry the commit attestation facts); `event:<ms>-<n>,<umid>` contract events | every transaction, every contract event | `/activeledgerevents/umids?from=` (catch-up), the hybrid feed and attestations, `/activeledgerevents/events` (SSE) | `--include-umids`, `--include-events` |
| `activeledgererrors` (`db.error`) | one document per logged error, id `<umid>:<ms>`, with `processed` and `code` | every failed transaction and repair record | the restore interagent (it works through unprocessed ones, e.g. code 950 "ask the network for this umid", then archives them) | handled ones only, by default |
| `activeledgererrors_archive` | errors the interagent has finished with | every handled error | nothing | by default |

Anything else found under `_all_dbs` is reported and the user is asked (see "Other databases").

## Behaviour

### Default (no flags): errors and archive

- `activeledgererrors_archive`: delete everything older than the window.
- `activeledgererrors`: delete documents older than the window **that are already processed**. An
  unprocessed document is a pending job for the restore interagent. It is never deleted by default, however
  old. Deleting one would silently drop a repair. If it is ever wanted, that is a separate, explicit flag
  (`--include-unprocessed`), not part of this first version.
- Age comes from the `<ms>` suffix of the id (`<umid>:<ms>`). A document whose id does not parse is kept.

### `--include-umids`: the umid index

Deletes `umid:<ms>,…` and `fail:<ms>,…` rows from the events database older than the window. Opt-in because
removing them has consequences:

- A node (or hybrid) catching up from this node's `/umids?from=` older than the window will not find them.
  The window should be longer than the longest time any node could be offline. `restore --full` works from
  streams and is not affected.
- A hybrid cannot be given an attestation for a commit older than the window, because the facts live in the
  row. The hybrid's own `window.days` default is also 30, so the defaults agree.

### `--include-events`: contract events

Deletes `event:<ms>-<n>,<umid>` rows older than the window. Opt-in because SSE consumers that resume with
`Last-Event-ID` older than the window will no longer get a replay, and anyone rebuilding a table from past
events (Varnir wants the last eight days) needs the window to cover that.

The two flags are separate on purpose: umids and events are different things and a deployment may want one
without the other.

### Other databases

The command asks the storage engine for `_all_dbs` and compares it with the names above (taken from
`config.json`, not hard coded). For every database it does not recognise it prints the name, document count
and size, and asks whether to delete the whole database, defaulting to No.

- Never offered, and refused even if named on the command line: the ledger, events and errors databases and
  the error archive. Prune handles those; it does not delete them.
- Non-interactive use: nothing is deleted unless `--delete-db <name>` is given (repeatable), and `--yes`
  alone never deletes a database.
- The name must be a plain database name (letters, digits, `_`, `-`, `.`, no path separators, not `..`):
  the storage delete route builds a path from it.
- The message says an unknown database may belong to another tool using this node's storage.

### Safety

- `days` must be a whole number of at least 1. Under 30 with `--include-umids` it prints the catch-up and
  hybrid warning above, and asks to continue unless `--yes`.
- `--dry-run` deletes nothing and prints what would go, per database and per kind (`would prune 12,000 error
  documents, 3,400 archived errors`), the way `activehybrid prune --dry-run` does.
- The ledger database is excluded by construction: the code that picks databases never includes it.
- Runs against the node's own storage on loopback (the storage server only listens on `127.0.0.1`). The node
  must be running; the command says so if storage cannot be reached.

## How it works

### Findings that shape the design

1. **Deleting a document does not delete its sequence rows.** `LevelMe.del()` removes the document key only
   (the comment says "not sequence"), and the HTTP `DELETE /<db>/<id>` uses it. Pruning with that leaks the
   by-sequence index and frees much less than expected. A prune must remove the document, its sequence
   rows and its cache entries together (there is a `delSeq` for the sequence part).
2. **Server requests are short.** The storage server drops an idle HTTP connection after about 10 seconds
   (`SERVER_IDLE_TIMEOUT_MS`), so one request cannot delete millions of rows. The prune is paged: each call
   removes up to N documents and says whether it is done; the CLI loops and prints progress.
3. **A big delete must not starve storage.** The recent busy-lock stall was a loop that left no room for
   anything else. Each page is a bounded batch, yields to the event loop between batches, and the CLI
   paces calls (a short pause, longer if storage reports it is slow).
4. **Time lives in the key for events and umid rows, but not for errors.** `umid:<ms>,…` and `event:<ms>-…`
   sort by time, so the candidates are a key range and need no reads. Error ids start with the umid hash, so
   errors need a scan and a read of `processed`. Compare the time **numerically**, not as a string: an id
   whose time does not have the usual 13 digits must not be mis-ordered.
5. **Space comes back at compaction.** LevelDB only frees space when it compacts. The command triggers the
   existing `_compact` at the end unless `--no-compact`.

### Pieces

| Piece | Where | What |
|---|---|---|
| `LevelMe.purgeDocs(keys)` | `packages/storage/src/levelme.ts` | one batch: documents, their sequence rows, cache entries |
| `LevelMe.pruneBefore({ prefix, before, requireProcessed?, limit })` | same | returns `{ removed, done }`; key range for time keyed prefixes, scan for errors |
| `POST /<db>/_prune` | `packages/storage/src/selfhost.ts` | body `{ prefix?, before, requireProcessed?, limit, dryRun }`; loopback only; one page |
| `activeledger prune` | `packages/activeledger/src/cli/prune.ts` + `program.ts`, `index.ts` | arguments, prompts, paging loop, report |
| docs | `docs/guide/operate/prune.md`, README CLI table, `CHANGELOG.md`, troubleshooting (disk growth) | including the catch-up and hybrid consequences |

First step of the build, before any of it: a short spike that writes documents the three ways the node does
and confirms exactly which sequence rows belong to a document, so `purgeDocs` removes them all and nothing
else.

## Tests

- LevelMe: removes the document, its sequence rows and cache entries; leaves neighbours alone; a cutoff exactly
  at the boundary; ids that do not parse are kept; unprocessed errors are kept; a page limit returns
  `done: false` until finished; the space-freeing path (a second read finds nothing).
- Storage route: loopback only, bad bodies refused, a dry run changes nothing.
- CLI: argument parsing, the floor on `days`, defaults, the warnings and prompts, `--yes`, `--dry-run` output,
  refusal to delete protected databases and path-like names, unknown database listing, storage unreachable.
- Live network test (`test:network:prune`): write transactions, backdate rows in the events and error stores,
  prune, and check that the ledger is untouched, catch-up and the hybrid feed behave as documented, and a
  window longer than the data deletes nothing.
- A mutation pass over the new code, as for the other recent work.

## Out of scope for the first version

- An automatic, scheduled prune from config (like the hybrid pruner's hourly run). The command first; the
  schedule can reuse the same page call later.
- Deleting unprocessed errors (`--include-unprocessed`).
- Old revisions inside the ledger database. Its sequence rows are a separate growth question and `_compact`
  already exists; nothing here touches the ledger.
- Log files and backups. Worth a quick audit for other things that grow without bound (node logs, `.ds`
  leftovers, restore progress files), reported separately.

## Open questions for the owner

1. Default with no flags: errors and archive only, as above. Agreed?
2. Flag names: `--include-events` and `--include-umids`. Agreed?
3. Is a floor of one day right, or should it be higher for `--include-umids`?
4. Should `activeledger prune` with no `days` ask, or just use 30?
