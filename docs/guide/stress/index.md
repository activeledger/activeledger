# Stress tests

The stress tools are a third kind of test, for people who change Activeledger
itself. They boot real nodes on one machine, push load through them and
**report values**. This page says how they differ from the other tests, which
profile to pick, how to read what they print and how to compare two builds.
[The four tools and their flags](tools.md) lists every flag.

## How this differs from `npm test` and `test:network`

| | `npm test` | `npm run test:network` and friends | stress tools |
| --- | --- | --- | --- |
| Question | does the code do the right thing | does a real network do the right thing | how fast, how reliable at start-up, how much memory |
| Result | pass or fail | pass or fail | numbers, with their spread |
| Nodes | none, in process | real, a few minutes | real, minutes to hours |
| Repeatable | yes | yes | no: the numbers move from run to run |
| Machine | any | any | quiet, nothing else running |
| In CI | on every push and pull request | no | never, except the manual `Stress` workflow |

* The tools **measure and report**. By default they exit 0 whenever they ran
  to completion and printed their report. They exit non-zero only when they
  could not run (bad flags, a network that would not start) or when you pass an
  explicit gate flag such as `--min-tps`, `--max-failure-rate` or
  `--fail-on-regression`.
* They are **noisy by nature**. Throughput on a development machine moves
  about 10% from run to run; start-up failures are a few percent and random.
  A single number is never the answer: the tools print the spread and what the
  run could and could not resolve.
* They must be run on a **quiet machine**, because the machine is part of the
  measurement. See below.
* They **never run in `npm test` or in CI**. The only way to run them on GitHub
  is the manually started `Stress` workflow.

Run them from a checkout after `npm ci` and a build of every package (the way
the test workflow builds them). Output goes to `./stress-results/` unless you
give `--out`.

## When to run them

Run the quick profile of the relevant tool before and after a change that
touches:

* the peer-to-peer or consensus hot path (throughput, cold start)
* storage, including its cache (throughput, memory)
* worker settings such as `cpus` or `worker_semi_space` (throughput with the
  `cpu-work` contract, memory)
* start-up ordering, ports or readiness (cold start)

and before a release. Use a longer profile when the question is about a small
difference, a rare failure or slow growth.

## Profiles

Every network tool takes `--profile quick|standard|full`, or the environment
variable `STRESS_PROFILE`. The default is `quick`. A flag you give on the
command line overrides what the profile sets. `--dry-run` prints what a profile
would do, with an estimate of the time, without starting anything.

| | quick | standard | full |
| --- | --- | --- | --- |
| Purpose | smoke test, big-regression check | a real comparison | the answer you can quote |
| Throughput | 1 and 4 nodes, 60 s per run (first 20 s excluded), 3 rounds | 150 s per run (first 30 s excluded), 3 rounds, stops after 2 if the spread already resolves 5% | 150 s per run, 5 rounds |
| Cold start | 20 runs | 100 runs | 400 runs |
| Memory | 240 s of load (first 60 s warm-up): plateau only, no growth verdict | 780 s: provisional growth estimate with its uncertainty | 1500 s: growth verdict per role |
| Time, throughput | 8.5 min (measured) | 12 to 18 min (estimate) | 29 min (estimate) |
| Time, cold start | 4.3 min (measured) | 17 min (estimate) | 67 min (estimate) |
| Time, memory | 6.6 min (measured) | 14 min (estimate) | 26 min (estimate) |

The quick times were measured on one run of each tool on a development machine
and include up to two minutes of the load gate waiting for the machine to
quieten. The standard and full times are **estimates computed from the plan**,
not measured: `--dry-run` prints them, assuming 25 s to boot and tear down a
network, 10 s per cold-start run and 45 s of boot and teardown around a memory
run. A busy machine makes everything slower.

### What a quick run cannot show

Each tool prints, at the end, how much resolving power the profile had, so a
quick run is not read as proof of something it cannot show.

* **Small throughput changes.** With three runs per size a change of a few
  percent is inside the run-to-run spread (about 10% on a shared machine),
  whichever way it points. Only a large change shows in a quick run.
* **Rare failures.** With 20 cold-start runs one failure is 5%, and the 95%
  interval around "1 in 20" runs from under 1% to about 24%. A second set of 20
  runs can only be told apart from a 10% baseline if it fails about 35 points
  more often. A 2% failure needs hundreds of runs. The quick profile reports the
  rate but cannot resolve rates below about 10%.
* **Slow memory growth.** In the first minutes a node's memory settles: caches
  fill, the heap grows to its working size. A leak of a few MB per 10k
  transactions is invisible against that, so the quick memory profile shows the
  plateau only and says it gives no growth verdict. Standard gives an estimate
  with a 95% interval marked provisional. Only full, with at least 15 minutes
  and 20 samples after warm-up, gives a verdict. `--max-growth-mb-per-10k` is
  refused on a quick run.

## Running them quietly and correctly

Absolute numbers depend on the machine, its load, its CPU count and frequency
scaling, so they are not comparable between machines or between days. What you
can compare is two builds measured on the same machine, close in time.

* Stop everything else first: browsers, editors with file watchers, other
  builds, other networks. One network at a time, always. The tools use ports
  from `--base-port` (default 5510) upwards in steps of 10, with storage on the
  port below each. Give `--base-port` if something else holds them.
* The tools wait for a quiet machine before they start (the load gate): the
  1-minute load average below `--max-load` (default 1.5) for `--quiet-seconds`
  (default 10), waiting at most `--gate-timeout` seconds and then running anyway.
  The load average is recorded before and after every run, and the compare tool
  notes runs that ran on a busy machine. `--no-gate` skips the wait.
* Interleave baseline and candidate rather than running all of one then all of
  the other, so drift in the machine hits both. The tools append to the file you
  name, so alternating invocations build up one file per build.
* A run that fails at start-up (see the known baseline below) is information,
  not a verdict. Rerun it once.

## Reading the output

Every run prints its figures as it goes, then a short table and the path of the
JSONL file. A quick throughput run, shortened to 30 s runs on 1 and 4 nodes:

```
  round 1/1, 1 node(s): 1020.6 tx/s  p50 8.4 ms  p99 10.9 ms  committed 20414/20414  load 10.21->8.17
  round 1/1, 4 node(s): 636.23 tx/s  p50 10.8 ms  p99 22.4 ms  committed 12731/12731  load 8.2->11.59
resolving power (quick profile)
  1 node(s): 1 runs, run-to-run spread 0.0% of the median; an A/B of this size could only call a tx/s change larger than about 5.0%
    fewer than 3 runs: the spread itself is not reliable
  ...

throughput results (quick profile)
  nodes  runs  tx/s median  tx/s IQR  p50 ms  p99 ms  committed
  -----  ----  -----------  --------  ------  ------  ---------
  1         1       1020.6       0.0     8.4    10.9        all
  4         1        636.2       0.0    10.8    22.4        all
results written to stress-results/throughput-<time>.jsonl
```

* `load a->b` is the 1-minute load average before and after the run. If it is
  well above the number of CPUs you are measuring the machine's other work.
* `committed` shows every transaction was checked for a commit.
* The resolving power paragraph is the smallest change an A/B of this size
  could call. If it is bigger than the change you care about, use a longer
  profile.

A quick cold-start run (20 runs) printed:

```
cold-start results (quick profile)
  set           runs  failed  rate   95% interval
  ------------  ----  ------  ----  -------------
  all runs        20       1  5.0%  0.9% to 23.6%
  stagger only    12       1  8.3%  1.5% to 35.4%
  extra delay      8       0  0.0%  0.0% to 32.4%
```

and a quick memory run, per role (processes of the role over all nodes, resident
and anonymous MB, and CPU per committed transaction after warm-up):

```
  role      procs   idle rss/anon   warm rss/anon   end rss/anon   anon change warm->end   cpu ms/tx
  host          4         102/47        860/804      2541/2484             +1680.6 MB      10.74
  storage       4          81/27         147/74        182/113               +39.4 MB       5.38
  restore       4         148/93         149/95         142/87                -7.9 MB       0.01
  worker       52          88/35        201/146        215/160               +14.4 MB       8.36
  growth: NO VERDICT. A quick run shows where memory plateaus, not whether it grows slowly; use --profile standard or full.
```

Each line of the JSONL file is one run (`"kind":"run"`) or a summary. Runs carry
the settings (`group`), the profile, the git commit, the machine's load and the
measured values, so a file can be compared months later.

## Comparing two builds

Check the baseline and the candidate out in two worktrees, build both, then
alternate with nothing else running:

```
git worktree add ../al-base master
git worktree add ../al-cand my-branch
# in each: npm ci, then build every package as the test workflow does

for round in 1 2 3; do
  (cd ../al-base && npm run stress:throughput -- --label baseline  --out /tmp/base.jsonl)
  (cd ../al-cand && npm run stress:throughput -- --label candidate --out /tmp/cand.jsonl)
done

(cd ../al-cand && npm run stress:compare -- /tmp/base.jsonl /tmp/cand.jsonl)
```

The compare tool uses no absolute limits. For each tool and settings group in
both files it takes the median and spread of the runs. The candidate is
**worse beyond spread** on a metric when its median is on the bad side of the
baseline's by more than the largest of the baseline's spread, the candidate's
spread, 5% of the baseline median (`--tolerance-pct`) and a small absolute
floor. Otherwise it is **within spread** (or **better beyond spread**). The
spread is the interquartile range from five runs, half the range below that.
Cold-start files are compared as failure rates with Fisher's exact test.

It will not call a result "no regression" unless the runs could have shown one.
If a side has fewer than 3 runs, or the spread is coarser than `--claim-pct`
(default 5%), or the failure-rate runs could not have told apart a rise of
`--claim-points` (default 10), it says **inconclusive, rerun with a longer
profile**.

By default the compare tool prints the verdicts and exits 0. Add
`--fail-on-regression` to make it a gate: exit 1 if the candidate is worse
beyond spread, 3 if inconclusive (`--allow-inconclusive` makes that 0). Here is
the same quick throughput file against a copy with 40% less throughput and
doubled p99, which prints worse beyond spread and, with the gate, exits 1:

```
throughput | nodes=4 clients=8 mode=hot contract=returner entry=spread
  tx/s    base 605.0 (iqr 2.6, n=3)  cand 363.0 (iqr 1.6, n=3)  -242.0 tx/s (-40.0%)  allowance 30.2  WORSE beyond spread
  p99     base  24.1 (iqr 0.7, n=3)  cand  48.2 (iqr 1.4, n=3)  +24.1 ms (100.0%)  allowance 2.0  WORSE beyond spread

RESULT: candidate is worse than baseline beyond the measured spread
```

If the result is inconclusive, repeat the loop with `--profile standard` (use
`--dry-run` first to see how long it will take). The same pattern works for
`stress:cold-start` (many runs) and `stress:memory` with `--reps`.

## Known baseline behaviour

On a plain build, in the default (harsh) stagger setting:

* the cold-start failure rate is roughly 6 to 12%, usually a node that did not
  yet have a stream that the rest of the network had committed;
* about 5% of first transactions on a new network time out
  (`Request timed out after 20000ms`).

Both exist in 5.1.6 and earlier and are listed under known issues in the
changelog. So use the cold-start tool to compare builds, not to demand zero: a
plain build is expected to fail some runs, and a 20-run quick profile cannot
resolve rates below about 10%. A throughput or memory run may also show a few
of those timeouts under heavy load; they are reported as uncommitted
transactions, not as a crash.

## Running them on GitHub

The `Stress` workflow can be started by hand from the Actions tab. It builds the
packages the way the test workflow does, shows the plan, runs one tool with the
profile and extra flags you give and uploads the JSONL results as an artifact.
It never runs on a push, a pull request or a schedule. A shared runner is noisy:
compare two runs made on the same kind of runner rather than reading one alone.
