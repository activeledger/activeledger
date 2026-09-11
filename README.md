[![npm version](https://badge.fury.io/js/%40activeledger%2Factiveledger.svg)](https://badge.fury.io/js/%40activeledger%2Factiveledger) 
[![npm](https://img.shields.io/npm/dt/@activeledger/activeledger.svg)](https://www.npmjs.com/package/@activeledger/activeledger) 
[![MIT license](https://img.shields.io/badge/License-MIT-blue.svg)](https://lbesson.mit-license.org/)


<img src="docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

Activeledger is a distributed ledger technology. A network of permissioned nodes gossips transactions to each other, votes on them, and commits the ones that reach consensus — each node reaching its own conclusion by watching the same traffic, rather than waiting on a single leader. Application logic lives in smart contracts (TypeScript, executed in a per-transaction worker process and checked by a security scan at deploy time), and consensus is tracked per-stream rather than globally, so unrelated transactions can be voted on and committed concurrently.

## Requirements

**Node.js 24.x** (the current LTS line) is the recommended and actively-tested version — every workflow in `.github/workflows/` builds, tests and publishes on 24. The native HTTP/consensus transport ([uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)) ships prebuilt bindings for a specific set of Node majors at any given time; the pinned v20.67.0 carries ABI 127, 137 and 147, which is Node 22, 24 and 26, so 22.x also works today. If you hit an error like `This version of uWS.js (...) supports only Node.js versions ...` on a Node version you'd expect to work, check that `node_modules/uWebSockets.js` itself is up to date (`npm i` again) before assuming the version genuinely isn't supported.

## Installation

Please see our documentation for detailed instructions. We currently have 2 languages available.

|Language| |
|--------|-|
|English| [documentation](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/README.md)|
|Chinese| [说明文档](https://github.com/activeledger/activeledger/tree/master/docs/zh-cn/README.md)|


## Quickstart Guide

Use NPM to install Activeledger. `@activeledger/activerestore` is recommended alongside it (heals a node that falls behind or comes up empty); `@activeledger/activecore`'s REST API is optional and off by default (`autostart.core: false`) — install it too only if you specifically want it, see the documentation above.

```bash
npm i -g --allow-scripts=classic-level,msgpackr-extract @activeledger/activeledger @activeledger/activerestore
```

> **The `--allow-scripts` flag is load-bearing on npm 11.19 and later**, which
> no longer runs install scripts by default. Activeledger's datastore pulls
> `classic-level` (node-gyp-build) and `msgpackr-extract`, both of which build a
> native binding during install. Without the flag the install **succeeds** and
> the native LevelDB binding is silently never built — the failure appears only
> later, at runtime. If your npm predates that change the flag is harmless, so
> it is safe to use either way. `npm config set allow-scripts ...` works too if
> you would rather set it once.

##### Creating a local Activeledger testnet

Run the following command to create a 3 node local testnet.

```bash
activeledger --testnet
```

![Activeledger Create Testnet](docs/assets/testnet-create.png)

When the testnet has been created you can run all of them at once but running

```bash
node testnet
```

Alternatively you can run each instance of Activeledger independantly by navigating into the instance-x folders which have been created and running

```bash
activeledger
```
![Activeledger Launch Testnet](docs/assets/testnet-run.png)

## Installing from GitHub Packages

Releases go to npmjs.com and are mirrored to the [GitHub Packages npm registry](https://github.com/orgs/activeledger/packages), so the quickstart above installs without any authentication. The one gap is the start of the 4.x line: v4.0.0 through v4.3.2 were published to GitHub Packages only, and every release from v4.3.3 onward is on both.

To install from GitHub Packages instead, note that it requires authentication even on public repositories, so add an `.npmrc` alongside your `package.json` (do not commit a real token):

```
@activeledger:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then set `NODE_AUTH_TOKEN` to a GitHub personal access token with `read:packages` scope (a fine-grained token scoped to this org is fine) and install as normal:

```bash
export NODE_AUTH_TOKEN=<your github token>
npm i -g --allow-scripts=classic-level,msgpackr-extract @activeledger/activeledger @activeledger/activerestore
```

For a Docker build, pass the token in as a build secret (e.g. `--secret id=npmrc,src=.npmrc` with a `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm i -g ...` step) rather than baking it into an image layer.

## Developer Tools

We have created an IDE for developers to create and manage Activeledger smart contracts across multiple networks. This IDE helps manage the private keys for developers to sign their contracts with and the namespaces their contracts will be stored under in each specific network. This tool is currently in beta but is available for Linux, Windows and OSX.

[IDE User Guide](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/ide/README.md) | [用户指南](https://github.com/activeledger/activeledger/tree/master/docs/zh-cn/ide/README.md)

![Activeledger IDE](docs/assets/developer-tools-demo.gif)

### IDE Download

Visit [Release section](https://github.com/activeledger/ide/releases)

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

The packages import each other by their published `@activeledger/*` names, so the build has to run once before type resolution works — `npm run build` builds them in dependency order for exactly that reason.

### Releases

A release is cut by dispatching the `Release` workflow with a version number. It bumps the root, every package, and every dependency range pointing at a sibling; commits; tags `vX.Y.Z`; and publishes in the same run, so the source tree at a tag, the tag itself and the published packages all report the same version. Tags cut before this existed do not — the manifests inside a v4.0.1 through v4.5.7 checkout report an older number than the tag (v4.5.7 reads 4.2.0), so do not identify one of those builds by its package version.

## Testing

Two separate test suites, deliberately decoupled so the fast one stays fast:

```bash
npm test              # fast unit tests (tests/*.ts, Mocha) - in-process, no real nodes
npm run test:network  # live 4-node network integration test - boots real nodes on the local machine
```

`npm test` takes a handful of seconds (324 tests today, most of the time being ts-node's transpile pass) and is safe to run constantly during development. It also runs in CI on every push and pull request, on Node 24; the network suite does not, because it boots real nodes.

`npm run test:network` (`tests/network/`) boots a real 4-node bare-host network, runs 100+ real transactions spread across every node as origin, deploys custom contracts and verifies `returnToRemote()`, verifies live event delivery over SSE, and verifies the network's Stream-Position-Incorrect self-healing by directly desyncing one node's local copy of a stream and confirming a transaction still succeeds whether that node is the transaction's origin or not. It prints live progress and a pass/fail summary, and takes well under a minute. Deliberately bare-host rather than Docker, so it doesn't add any requirements beyond what building the repo already needs.

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

## License

[MIT](https://github.com/activeledger/activeledger/blob/master/LICENSE)
