# Bringing the restore engine into `activeledger`

Status: notes and proposal for review · 2026-11-20 · not started

## Why

`activerestore` used to do a lot. Most of what it did in the background is now
done by the node itself:

- SPI repairs a stream when the node next votes on it, and (with the changes of
  2026-11) is started from the node's own failure, not by a lucky peer frame
  (`2026-11-20-spi-exits.md`).
- The node fetches the umid a repaired stream names, and walks the history back
  through the shared `@activeledger/activesync` package, so the second process is
  no longer needed for the common case (`Endpoints.backfillUmid`,
  `walkUmidHistory`).
- The catch-up (`2026-11-20-catch-up.md`) finds the commits a node missed
  without waiting for a transaction to touch the stream.

What is left is small, and running it as a separate process costs more than the
work it does: a pid file, an autostart setting that has failed quietly (a node on a
non-default port had it switched off for a long time; it has been seen dead for
days), its own connections to the database, and a second thing to start, stop and
upgrade.

## What `activerestore` is today (about 2,000 lines)

| Part | Lines | What it does | Where it runs |
|---|---|---|---|
| Interagent | ~400 | Watches the error database for 950 documents and fetches the transactions the node missed (`autostart.restore`, started beside the node) | its own process, always |
| Quick restore | ~600 | `activerestore --full`: three passes against the other nodes: state (majority revision of every stream), contract files and locks, then history. A job that exits when done | its own process, on demand |
| Provider, helpers, throttle, contract | ~900 | Database connections, config, rate limiting, rebuilding compiled contracts | shared by both |

Both parts already use `@activeledger/activesync` for the repair logic they
share with the node.

## Proposal

Two moves, in this order.

### 1. A command in the node's own CLI: `activeledger quick-restore`

The full restore becomes a subcommand of `activeledger` (the CLI the node is
started with), replacing `activerestore --full`:

```
activeledger quick-restore            the three passes, as today
activeledger quick-restore --history  only the history pass
activeledger quick-restore --dry-run  say what it would fetch, change nothing
```

- Same behaviour, exit codes and log lines as `--full` has now (it is a job;
  exit 0 when done, 1 when it could not do its work, the same message when the
  database cannot be reached), so the docs for restore stay valid with a new
  command name.
- It runs in the node's folder against the node's database, as now, so the node
  may be running or only started with `--db-only`.
- `activerestore --full` keeps working for a release or two and prints that it has
  moved, then does the same; the `activerestore` binary stays as a thin wrapper
  over the same library.
- The code stays in `@activeledger/activerestore` as a library
  (`QuickRestore`), which the CLI calls. No code moves, so no history is lost.
- It can use the catch-up's repair for the stretch it covers (the `Catchup` class
  with the per-run cap lifted) instead of its own state pass, once that has soaked.
  Open: whether to do that, or keep the three passes as they are, which are known
  to work.

This is the part the user asked for, and it is low risk: the same code behind a
new entry point.

### 2. The interagent becomes a service inside the node

Its job (read 950 documents, fetch what is missing, mark them processed) moves
into the host as a timer-driven service, like the catch-up driver, and
`autostart.restore` goes away. After that no second process exists at run time.

This one waits until the catch-up has soaked, because the interagent's durable
retry (a 950 document survives a crash) is the safety net for the cases the
catch-up and the inline repair now cover. Removing it before there is evidence
those hold would remove the net first.

Things to decide for it:

- **Where it runs.** The host is one event loop that already carries the network,
  so a loop over the error database should be throttled (the interagent has a
  throttle already) and bounded. A worker thread or a forked child, managed by the
  host, is the alternative if the load shows.
- **The 950 contract.** The node still writes the 950 document when it repairs,
  as a durable record; the service reads and clears them. The rows and their
  `processed` flag do not change.
- **Compatibility.** Existing configs have `autostart.restore`; it is read and
  ignored with one log line. `pids.activerestore` and the `activeledger stop`
  handling for it are removed once nothing writes it. A node on an older release
  still runs its own `activerestore`; the two do not conflict (the umid and
  event documents they write are append-only and keyed by umid).

## What stays separate

Nothing in the quick restore needs the node's locks (it is run while the data is
being rebuilt, and writes through the same revision rules), which is why it can be
a command rather than part of the running node. The catch-up, in contrast, runs
inside the node because it repairs streams that are live.

## Phasing

1. `activeledger quick-restore` as a thin entry over the library, docs updated
   (`restore.md`), `activerestore --full` prints that it moved. One PR, tested by
   the existing restore live tests run through the new command.
2. After the catch-up has been on by default for a release: the interagent as a
   host service, `autostart.restore` retired, the pid handling removed.
3. Optional: the quick restore reusing the catch-up repair.

## Tests

- The restore live tests (`tests/network/restore*.ts`) pass through
  `activeledger quick-restore`, including the not-reachable-database exit.
- A node with `autostart.restore` set starts, ignores it, logs once, and repairs a
  950 document through the service (phase 2).
- A mixed network: one node on the old release running `activerestore`, one on the
  new one without it.

## Open questions

- The command name: `quick-restore` (the code's name for it) or `restore`; the
  user prefers `quick-restore`.
- Whether `--dry-run` is worth building in the first PR or later.
- Whether the interagent should be a thread or a loop in the host.
- Whether to keep publishing the `activerestore` binary after the library move,
  and for how long.
