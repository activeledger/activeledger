# Memory use

A node is several processes, and most of its memory is in the contract workers. This page says where the memory goes, which settings change it, and what each one costs. The defaults favour speed. Change a setting only when you have a memory problem, and measure the result on your own contracts.

## Where a node's memory goes

One node runs a host process, a storage process, the restore engine and a number of contract workers (`cpus`, half the physical cores by default, plus a standby). In a test of four nodes under steady load (500,000 transactions over 25 minutes, about 330 a second), a node settled at about 5 GB. The split was:

| Part | Share of the node |
|---|---|
| Contract workers (about 226 MB each) | 57% |
| Host | 33% |
| Storage | 8% |
| Restore engine | 2.6% |

Memory reached its plateau after about five minutes and did not grow over a 25 minute run of half a million transactions. A worker keeps about 100 MB of its heap as spare room that the operating system sees as used. That room is the largest thing the settings below can recover.

## The settings

| Key | Default | What it changes |
|---|---|---|
| `db.selfhost.cache` | `false` | A 30 second read cache on the ledger database. |
| `db.selfhost.writeBufferMb` | `64` | LevelDB write buffer per database (LevelDB's own default is 4). Resident memory grows as it fills. |
| `db.selfhost.cacheMb` | `256` | LevelDB block cache per database (LevelDB's own default is 8). Used up to this size and no more. |
| `releaseHoldSeconds` | How long the host keeps the whole entry of a finished transaction, so a peer's late vote still finds it. Peers can vote up to 60 seconds late, so a value under 60 risks a late vote being treated as a new transaction. | `60` |
| `releaseStubSeconds` | How long after a transaction finishes the host drops everything about it except this node's own answer (vote, commit, error), for the rest of the hold. A late peer only needs that answer, so this frees most of the memory a finished transaction uses. Not used when it is not shorter than `releaseHoldSeconds`. | `5` |
| `releaseTailSeconds` | After that, how long the host keeps the record of the destroyed transaction to answer a late peer. Anything that could still use it has timed out by then, so a long tail only costs memory and host CPU (garbage collection): in a four minute test at 600 to 700 transactions a second, 10 seconds against the old 120 gave about 21% more throughput and a third less host memory. | `10` |
| `worker_semi_space` | `0` (off) | The size of each worker's young generation, in MB. |
| `cpus` | half the physical cores, at least one | How many workers run contracts: a number, or a percentage of the physical cores such as `"50%"` (rounded, at least one). |
| `autostart.restore` | `true` | Whether the restore engine runs beside the node. |

All four are listed with their neighbours in [Configuration](configuration.md).

### `db.selfhost.cache`

The cache is off. On a busy node fewer than one read in a hundred found its answer there, and it held hundreds of MB of documents and one timer per entry. Turning it off saved 280 to 430 MB per node, and throughput and latency were the same or better at one client, one node and four nodes. The events and error databases are never cached, whichever way this is set.

Turn it on (`"cache": true` under `db.selfhost`) only if your workload reads the same streams again and again, and check that it helps before you leave it on.

### `worker_semi_space`

This caps the young generation of each worker, which is where the spare room sits. It is off, and `0` leaves the memory sizing to V8. A value from 1 to 64 sets it in MB; anything else is ignored with a warning and the workers start without it.

| Contract | Setting | Memory | Speed |
|---|---|---|---|
| Light (returns a value, writes one stream) | 2 or 4 | about 700 MB less per node (about 21%) | same as without, within the run-to-run spread |
| Heavy (builds and sorts thousands of objects per transaction) | 2 or 4 | about 200 MB less per node in the one run measured | 23 to 29% fewer transactions a second, 45 to 75% slower p99, 55 to 77% more worker CPU |

A smaller young generation is cleaned more often. That is cheap for a contract that allocates little and costly for one that allocates a lot. Set it only if your contracts are light, and compare transactions a second and p99 before and after on a representative load. `max_memory` still applies to each worker and is not changed by this setting.

### `cpus`

Fewer workers use less memory, about 115 to 225 MB for each one removed. In a test with a light contract, 4 and 6 workers per node did as well as 12 (429 and 435 transactions a second against 410, within the spread of repeated runs). The test did not include contracts that use a lot of CPU, which are the case where more workers help, so measure with your own contracts before you lower it.

### `autostart.restore`

The restore engine is about 90 MB per node. It repairs streams a node missed, so leave it on unless you have another way to do that.

## Checking the effect

Change one setting at a time and restart the node. Watch the resident memory of each process (`ps -o rss,cmd` on the node's process tree is enough), and compare transactions a second and p99 from a run of your own contracts before and after. Allow five minutes after the start before you read the memory figure, because that is how long the plateau takes.

```json
{
  "db": { "selfhost": { "cache": false } },
  "worker_semi_space": 2,
  "cpus": 6
}
```

That example is for a deployment of light contracts that needs less memory. Leave `worker_semi_space` out if your contracts do real work in each transaction.
