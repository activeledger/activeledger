# The five tools and their flags

Each tool takes `--help`, which prints the same flags with their defaults. All
four network tools also take the [common flags](#common-flags). For what the
profiles do and how to read the output, see [Stress tests](index.md).

## Throughput

```
npm run stress:throughput -- --profile quick
npm run stress:throughput -- --nodes 8 --base-port 5610 --mode unique --duration 90 --warmup 20
```

Runs a closed loop of transactions against a real harness network. `--nodes`
is a list of network sizes; each round runs every size once, each on a fresh
network, so the sizes are interleaved. Clients submit one transaction at a time
and enter at the nodes in turn. Every response is checked for a commit.
Latency is measured from the client to the committed answer, and p50, p90 and
p99 are taken over the measured part of the run (after the warm-up).

`--mode hot` has each client keep writing its own stream with the chosen
contract: `returner` does almost nothing, so it measures consensus and storage;
`cpu-work` makes the contract worker build, sort and serialise about 6000
objects per transaction, so it measures the worker pool and V8 settings.
`--mode unique` makes every transaction a new identity (a new stream), always
with the default onboard contract.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--nodes` | 4 (profile: 1,4) | network sizes, comma separated, e.g. `1,4,8` |
| `--clients` | 8 | concurrent clients |
| `--duration` | 60 (profile) | seconds of load per run, warm-up included |
| `--warmup` | 20 (profile) | seconds at the start of each run excluded from the figures |
| `--tx-per-client` | none | instead of a duration: each client sends exactly this many pre-signed transactions after 20 unmeasured ones |
| `--reps` | 3 (profile) | rounds |
| `--stop-early` | off (standard: on) | after round 2, stop if the spread already resolves `--target-pct` |
| `--target-pct` | 5 | the resolving power, in percent, that is good enough for `--stop-early` |
| `--contract` | `returner` | `returner` or `cpu-work` (hot mode only) |
| `--mode` | `hot` | `hot` or `unique` |
| `--entry` | `spread` | `spread`: clients enter at nodes in turn; `first`: all at node 0 |
| `--min-tps` | none | gate: exit 1 if the median tx/s of any size is below this |
| `--max-p99-ms` | none | gate: exit 1 if the median p99 of any size is above this |
| `--fail-on-uncommitted` | off | gate: exit 1 if any transaction did not commit (always reported) |

In duration mode transactions are signed just before they are sent, which is
cheap beside a network round trip. In `--tx-per-client` mode they are signed
first, outside the timed section.

## Realistic users (peak throughput)

```
npm run stress:realistic -- --pdf tps.pdf
npm run stress:realistic -- --contract no-write --rates 300,500,700,900,1100,1300 --out stress-results/reads.jsonl
npm run stress:realistic -- --contract returner --rates 300,500,600,700,800,900 --out stress-results/writes.jsonl
npm run stress:realistic -- --from stress-results/reads.jsonl,stress-results/writes.jsonl --pdf tps.pdf
```

Answers "what rate can this network confirm?", which the closed-loop
[throughput](#throughput) tool cannot: that one lets the clients set the pace,
so a slow network just looks like a slow test. This one **offers a fixed rate
whether or not earlier transactions have been answered** (open loop), steps
through a ladder of rates, and reports for each step how many transactions the
network confirmed (committed, final) and how long users waited. A network that
cannot keep up shows as confirmed below offered, with latency climbing, instead
of as a quietly longer run.

How it loads the network:

* a pool of `--users` distinct users, each with its own key and stream, all
  onboarded before the first step. A user is not picked again while its previous
  transaction is in flight, and there is no per-user rate limit
* arrivals are random (Poisson) at the step's rate, spread over `--workers`
  generator threads, entering at the nodes in turn
* every transaction is **signed in advance**, before the step's clock starts:
  signing costs about 0.7 ms and a real client does it on its own hardware, so
  it should not take the machine's CPU away from the nodes. Each is unique and
  the nodes still verify every signature
* connections are kept alive and capped per node, as a load balancer would. A
  new connection per request runs the machine out of local ports (`EADDRNOTAVAIL`)
  at a few hundred requests a second and measures the tool, not the network

`--contract no-write` is a contract that validates and returns without writing
state (checks and lookups: the **reads** figure); `--contract returner` writes
a message onto the user's own stream (the **writes** figure). `--join-pct`
mixes in new users joining (onboards).

A step is **sustained** if the network confirmed at least `--sustain-pct` of the
offered rate, no more than `--max-fail-pct` of transactions failed, and p99
latency stayed under `--max-p99-ms`. The climb stops after `--stop-after`
unsustained steps in a row.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--nodes` | 4 | nodes in the network |
| `--rates` | 300,500,700,900,1100 | offered tx/s steps, ascending |
| `--duration` | 45 | seconds per step, warm-up included |
| `--warmup` | 10 | seconds at the start of each step excluded from the figures |
| `--settle` | 5 | seconds of quiet between steps |
| `--users` | 1000 | distinct users; use more if a step reports dropped arrivals |
| `--contract` | `no-write` | `no-write` (reads) or `returner` (writes) |
| `--join-pct` | 5 | percent of arrivals that are a new user joining |
| `--workers` | 6 | load-generator threads |
| `--sustain-pct` | 97 | sustained: at least this percent of the offered rate confirmed |
| `--max-fail-pct` | 0.5 | ... and no more than this percent failed |
| `--max-p99-ms` | 3000 | ... and p99 under this |
| `--stop-after` | 2 | stop climbing after this many unsustained steps in a row |
| `--node-config` | none | JSON merged into every node's `config.json` (for an A/B of a setting) |
| `--pdf` | none | write a one page PDF summary |
| `--from` | none | do not run: build `--pdf` from results file(s); a reads file and a writes file separated by a comma give two headlines |

A step takes `--duration` plus `--settle` seconds, and the tool needs a minute
or two to start the network and onboard the users, so the default ladder takes
about six minutes. The common flags apply, except that `--profile` does nothing
here: the ladder is set by `--rates` and `--duration`.

**Reading the output.** Each step prints what was offered, what was confirmed,
the failure rate, p50 and p99, and the load average before and after. The
results file also holds CPU cores per role (host, storage, workers), so you can
see which process runs out first: each node's host is one thread, so about one
core per node is its ceiling. Two notes the tool prints matter:

* *arrivals were dropped because every user already had a transaction in
  flight*: the network was saturated and the pool ran dry. Confirmed tx/s is
  still its real throughput, but use more `--users` to see how it fails
* *the generator's own timer ran late*: the machine was too busy to offer that
  rate cleanly, and the step understates the network

**The PDF** is one A4 page for someone who will not read the numbers: a headline
for reads and for writes (the highest sustained step, with the latency 99% of
transactions beat), a table of confirmed tx/s by rate, a chart and five short
notes. Only steps the network held are shown; a rate with no result shows
N/A. Confirmed is shown as what the network committed, never above what was
sent (the difference is timing noise at the edges of the window). It is printed
by a headless Chrome or Chromium, found from `CHROME_BIN`, the `PATH`, or the
Playwright and Puppeteer caches; the HTML is kept beside it if none is found.

Run it on a quiet machine and say so on the page: the figures are for the
machine they were measured on, and a shared development PC understates a
dedicated server. A first-transaction timeout while the network starts (see the
cold-start tool) ends the run with exit status 2 before any step; run it again.

## Cold start

```
npm run stress:cold-start -- --profile quick
npm run stress:cold-start -- --runs 40 --max-stagger-ms 1500 --extra-delay-ms 2500 --keep-logs /tmp/cold-logs
```

Each run creates fresh data directories, starts the nodes at random offsets
between 0 and `--max-stagger-ms`, and in some runs holds one node back a further
`--extra-delay-ms`. It then onboards an identity, registers a namespace and
deploys a contract, each entering at a different node, and checks that every
node shows all three in its **own** storage within `--view-timeout-ms`, and
that a transaction entering at each node works. A node that did not show a
stream, or could not take its own transaction, is recorded as lagged.

The report gives the failure rate with a Wilson 95% interval, for all runs and
split into stagger-only and extra-delay runs with a Fisher exact test between
them, which node lagged and the failure messages.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--runs` | 20 (profile) | fresh networks to boot and check |
| `--nodes` | 4 | nodes per network |
| `--max-stagger-ms` | 1500 | each node starts after a random 0 to this many ms |
| `--extra-delay-ms` | 2500 | in an extra-delay run, one random node starts this much later still |
| `--extra-probability` | 0.5 | chance (0 to 1) that a run is an extra-delay run |
| `--view-timeout-ms` | 15000 | how long a node gets to show each bootstrap stream in its own storage |
| `--seed` | random, printed | repeat a stagger sequence |
| `--keep-logs` | none | directory to copy every `node.log` of a failed run into |
| `--max-failure-rate` | none | gate: exit 1 if the failure rate (0 to 1) is above this |

The load gate runs once, before the first run.

## Memory

```
npm run stress:memory -- --profile quick
npm run stress:memory -- --profile full --max-growth-mb-per-10k 5
```

Reads `/proc` for every process under each node and sorts them by role from
their command lines: `host` (the node), `storage`, `restore` and `worker`
(contract workers). For each role, averaged over its processes, it reports
resident memory (RSS) and anonymous memory (the part a leak grows) at idle,
after warm-up and at the end of the load, and the CPU time per committed
transaction after warm-up. From the standard profile up it also gives the
growth of anonymous memory as a least-squares slope in MB per 10k transactions
with a 95% interval; the samples are not independent, so the interval is
optimistic.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--nodes` | 4 | nodes in the network |
| `--clients` | 16 | concurrent clients during the load |
| `--duration` | 240 (profile) | seconds of load, warm-up included |
| `--warmup` | 60 (profile) | seconds of load before the growth fit and CPU window start |
| `--idle` | 10 | seconds of the idle window after boot |
| `--sample-interval` | 10 | seconds between samples under load |
| `--contract` | `returner` | `returner` or `cpu-work` |
| `--cpus` | node default | sets the nodes' `cpus` config (size of the contract worker pool) |
| `--worker-semi-space` | node default | sets the nodes' `worker_semi_space` config |
| `--reps` | 1 | repeat the whole run on fresh networks (gives the compare tool a spread) |
| `--fail-on-uncommitted` | off | gate: exit 1 if any transaction did not commit (always reported) |
| `--max-growth-mb-per-10k` | none | gate: exit 1 if any role's anonymous memory grows faster than this; needs standard or full |

## Compare

```
npm run stress:compare -- baseline.jsonl candidate.jsonl
npm run stress:compare -- --fail-on-regression baseline.jsonl candidate.jsonl
```

Reads two files written by the same tool and prints, per settings group and
metric, the baseline and candidate median and spread, the difference, the
allowance and a verdict: within spread, worse beyond spread, better beyond
spread or inconclusive. Metrics are tx/s, p50 and p99 for throughput; RSS,
growth and CPU per transaction for each role for memory (a quick run
contributes no growth); failure rate for cold start. It takes no network and
no profile.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--tolerance-pct` | 5 | also ignore differences smaller than this percent of the baseline median |
| `--claim-pct` | 5 | the relative difference the runs must be fine enough to rule out, else inconclusive |
| `--claim-points` | 10 | the same for cold-start failure rates, in percentage points |
| `--alpha` | 0.05 | significance level for failure rates (Fisher exact) |
| `--fail-on-regression` | off | exit 1 if worse beyond spread, 3 if inconclusive; without it the exit is 0 |
| `--allow-inconclusive` | off | with `--fail-on-regression`: exit 0 instead of 3 when inconclusive |

## Common flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--profile` | `quick` | `quick`, `standard` or `full`; also the `STRESS_PROFILE` environment variable |
| `--dry-run` | off | print what the profile would do and estimate its time; start nothing |
| `--out` | `./stress-results/<tool>-<time>.jsonl` | JSONL file to append to |
| `--label` | none | free text stored with each record, such as `baseline` |
| `--base-port` | 5510 | port of the first node; nodes use base, base+10, ... with storage on port-1 |
| `--gate` / `--no-gate` | on | wait for a quiet machine before starting |
| `--max-load` | 1.5 | load gate: proceed when the 1-minute load average is below this |
| `--quiet-seconds` | 10 | load gate: and has stayed below it this long |
| `--gate-timeout` | 120 | load gate: stop waiting after this many seconds and run anyway, flagged |

## Exit status

The tools exit 0 whenever they ran and printed their report. They exit 1 only
when you pass a gate flag (`--min-tps`, `--max-p99-ms`, `--max-failure-rate`,
`--max-growth-mb-per-10k`, `--fail-on-uncommitted`, `--fail-on-regression`) and
it is missed, 3 for an inconclusive compare with `--fail-on-regression`, and 2
when they could not run: a bad flag, or a network that would not start.
