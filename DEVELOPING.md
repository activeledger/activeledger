# Developing Activeledger

How to build, test, measure and release the repository itself. To use Activeledger, start with the [README](README.md) and the [guide](https://activeledger.github.io/activeledger/). See also [CONTRIBUTING.md](CONTRIBUTING.md).

## Building from source

### Prerequisites

npm 7 or newer, which is where workspace support arrived. Nothing to
install globally - `npm i` at the root links every package in `packages/`
into the root `node_modules` for you.

### Building

```bash
npm i
npm run build
```

`npm run setup` (install + build) is also available if your `node_modules` are in a bad state — slower, and rarely needed for everyday work.

To run the programs by name (`activeledger`, `activehybrid`, `activerestore`) from anywhere, link them globally once after building:

```bash
npm link ./packages/activeledger ./packages/hybrid ./packages/restore
```

The links point at the source folders, so `npm run build` updates what they run. Each Node version managed by nvm has its own global folder, so link again after switching versions. From inside the repo, `npx activeledger` works without linking.

The packages import each other by their published `@activeledger/*` names, so the build has to run once before type resolution works — `npm run build` builds them in dependency order for exactly that reason.

### Releases

A release is cut by dispatching the `Release` workflow with a version number. It bumps the root, every package, and every dependency range pointing at a sibling; commits; tags `vX.Y.Z`; and publishes in the same run, so the source tree at a tag, the tag itself and the published packages all report the same version. Tags cut before this existed do not — the manifests inside a v4.0.1 through v4.5.7 checkout report an older number than the tag (v4.5.7 reads 4.2.0), so do not identify one of those builds by its package version.

## Package READMEs

npm shows each package's own `README.md`. The one for `@activeledger/activeledger` is the root README made absolute (links to the docs site and GitHub, images from raw.githubusercontent.com), so after changing the root README run:

```bash
npm run readme:sync
```

The unit suite fails if `packages/activeledger/README.md` is out of date, and if any package README has a relative link or image (they would be broken on npm).

## Testing

Two separate test suites, deliberately decoupled so the fast one stays fast:

```bash
npm test              # fast unit tests (tests/*.ts, Mocha) - in-process, no real nodes
npm run test:network  # live 4-node network integration test - boots real nodes on the local machine
```

`npm test` takes a handful of seconds (324 tests today, most of the time being ts-node's transpile pass) and is safe to run constantly during development. It also runs in CI on every push and pull request, on Node 24; the network suite does not, because it boots real nodes.

`npm run test:network` (`tests/network/`) boots a real 4-node bare-host network, runs 100+ real transactions spread across every node as origin, deploys custom contracts and verifies `returnToRemote()`, verifies live event delivery over SSE, and verifies the network's Stream-Position-Incorrect self-healing by directly desyncing one node's local copy of a stream and confirming a transaction still succeeds whether that node is the transaction's origin or not. It prints live progress and a pass/fail summary, and takes well under a minute. Deliberately bare-host rather than Docker, so it doesn't add any requirements beyond what building the repo already needs.

## Stress tests

A third, different kind of test: tools that measure and report rather than pass or fail. They are noisy by nature, want a quiet machine, and never run in `npm test` or CI.

```bash
npm run stress:throughput  # tx/s and latency on 1, 4 or 8 nodes
npm run stress:realistic   # what rate a network confirms: stepped open-loop load from many users, with a one page PDF
npm run stress:peak        # the peak load test: reads, locked reads, then writes, and a one page PDF (about 20 minutes)
npm run stress:cold-start  # how often a fresh, staggered start leaves a node behind
npm run stress:memory      # memory and CPU per role, and growth per 10k transactions
npm run stress:compare     # two result files, and whether the candidate is worse beyond the spread
```

The default quick profile takes about five to nine minutes per tool and is a smoke check for big regressions; `--profile standard` and `--profile full` resolve smaller differences. See [Stress tests](docs/guide/stress/index.md) in the guide.

## Profiling

Two profilers, answering different questions. Both drive the same live harness
the network tests use, so they measure real nodes rather than a model.

```bash
npm run profile:tx      # what a transaction costs
npm run profile:stages  # where that cost sits
```

### `profile:tx` — what it costs

Varies one thing at a time and prints the effect: network size, key type,
concurrency, and how a transaction responds to contract work getting heavier.

```
npm run profile:tx                  # full sweep, a few minutes
npm run profile:tx -- --quick       # shorter, for a fast before/after
npm run profile:tx -- --only=1,3    # just sections 1 and 3
```

The four sections are independent and each boots its own networks:

| | question it answers |
|---|---|
| 1 | how much of a transaction is consensus (1 vs 2 vs 4 nodes) |
| 2 | how much is signature verification (rsa vs secp256k1) |
| 3 | latency against actual capacity (1 to 128 in flight) |
| 4 | does the consensus gap grow with contract work, or is it fixed overhead |
| 5 | what a contended stream costs (N writers against ONE stream) |

Sections 1-4 use independent streams, which is the flattering case: nothing
ever waits on a lock. Section 5 is the opposite, because most real workloads
have at least one hot stream — a shared pool, a counter, a registry — and
writers to it must serialise. Add `--contend-nodes=1` to run it on a single
node, where nothing else drives the lock queue.

### Measuring a network that isn't on loopback

`AL_SIMULATED_RTT_MS` delays every node-to-node knock, so a four-node harness
on one machine can be made to behave like four nodes in different regions.
Half the value is applied per knock, so a request and its reply together cost
the round trip you ask for.

```bash
AL_SIMULATED_RTT_MS=60 npm run profile:tx -- --only=1
```

It matters because every other number here is taken on loopback, where a peer
is ~0.3ms away and consensus looks nearly free. Measured across 0/20/60/150ms,
a transaction costs **a fixed ~21ms plus exactly one round trip**, whatever the
node count:

| RTT | 1 node | 2 nodes | 4 nodes |
|---|---|---|---|
| 0ms | 5ms | 19ms | 23ms |
| 20ms | 6ms | 35ms | 41ms |
| 60ms | 6ms | 80ms | 81ms |
| 150ms | 5ms | 171ms | 171ms |

So consensus is one round trip rather than several, extra nodes are close to
free, and any saving in local work is **absolute, not proportional** — 10ms off
a transaction is 30% of a same-datacentre one and 6% of an antipodal one. Set
it only for profiling.

Section 4 uses `tests/network/contracts/burn-contract.ts`, which burns a
caller-specified amount of CPU inside `commit()`. If the gap over a 1-node
network grows ~1:1 with the burn, the other nodes are repeating the work after
the origin finishes; if it stays flat, their execution already overlaps and the
gap is fixed overhead. It is flat.

Reference numbers on a developer machine, p50, so a change can be recognised as
a change rather than noise — expect ±1-2ms run to run:

```
1 node 6ms    2 nodes 21ms    4 nodes 22ms    peak ~220 tx/s at 128 in flight
```

`--quick` is directly comparable to a full run, not a rougher reading of the
same thing: every network is warmed with eight discarded transactions before
anything is measured, so contract compilation, the JIT and the connection pools
have settled. Skipping that put `--quick` at 15/36ms against the full run's
5/23ms for an identical build, because with a short sample count the stragglers
land on the p50 instead of the tail.

### `profile:stages` — where it sits

Marks each stage of a transaction and stitches every process that touched it
into one timeline. A transaction crosses processes — the host parses it, a
forked worker runs the contract, and on a multi-node network other hosts do the
same again — so the marks carry an absolute wall-clock timestamp. `hrtime`'s
epoch is per-process and means nothing across a fork.

```
npm run profile:stages                        # 4 nodes
npm run profile:stages -- --nodes=1           # 1 node: the clearest local picture
npm run profile:stages -- --nodes=4 --runs=20
```

It prints one full timeline, then the mean cost of every stage transition on the
origin node, sorted worst-first. Start with `--nodes=1`: on a multi-node run the
origin also answers knocks about the same transaction from its peers, and the
waiting-on-peers window dominates everything local.

The marks come from `ActiveTiming` in `@activeledger/activelogger`, which is
inert unless `ACTIVELEDGER_PROFILE` is set — the profiler sets it for the nodes
it starts. You can set it yourself against a node you run by hand, but never in
production: it is one unbounded line of stdout per stage per transaction.

To time something not yet marked, add `ActiveTiming.mark(umid, "your.stage")`
where you want it and add the name to `ORDER` in `tests/network/profile-stages.ts`
so it sorts into the right place.

### Two ways to profile the wrong thing

Both of these have produced confident, wrong numbers here:

- **A stale build.** The nodes run `lib/`, not `src/`, so a source change that
  hasn't been compiled is silently absent from any live measurement — including
  anything after a `git stash` / build / `git stash pop`. Rebuild, then check the
  change is actually in the output (`grep` the built file) rather than trusting
  the build's exit code.
- **Leftover nodes.** A crashed run can leave nodes holding ports 5510-5540, and
  the next run measures those instead. `profile:tx` tears its own networks down
  on failure; if something else dies badly, check with
  `ss -lntp | grep :55` before believing a surprising result.
