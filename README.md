[![npm version](https://badge.fury.io/js/%40activeledger%2Factiveledger.svg)](https://badge.fury.io/js/%40activeledger%2Factiveledger) 
[![npm](https://img.shields.io/npm/dt/@activeledger/activeledger.svg)](https://www.npmjs.com/package/@activeledger/activeledger) 
[![lerna](https://img.shields.io/badge/maintained%20with-lerna-cc00ff.svg)](https://lernajs.io/)
[![MIT license](https://img.shields.io/badge/License-MIT-blue.svg)](https://lbesson.mit-license.org/)


<img src="docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

Activeledger is a distributed ledger technology. A network of permissioned nodes gossips transactions to each other, votes on them, and commits the ones that reach consensus — each node reaching its own conclusion by watching the same traffic, rather than waiting on a single leader. Application logic lives in smart contracts (TypeScript, sandboxed), and consensus is tracked per-stream rather than globally, so unrelated transactions can be voted on and committed concurrently.

## Requirements

**Node.js 24.x** (the current LTS line) is the recommended and actively-tested version. The native HTTP/consensus transport ([uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)) ships prebuilt bindings for a specific set of Node majors at any given time — 22.x also works today, but if you hit an error like `This version of uWS.js (...) supports only Node.js versions ...` on a Node version you'd expect to work, check that `node_modules/uWebSockets.js` itself is up to date (`npm i` again) before assuming the version genuinely isn't supported.

## Installation

Please see our documentation for detailed instructions. We currently have 2 languages available.

|Language| |
|--------|-|
|English| [documentation](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/README.md)|
|Chinese| [说明文档](https://github.com/activeledger/activeledger/tree/master/docs/zh-cn/README.md)|


## Quickstart Guide

Use NPM to install Activeledger. `@activeledger/activerestore` is recommended alongside it (heals a node that falls behind or comes up empty); `@activeledger/activecore`'s REST API is optional and off by default (`autostart.core: false`) — install it too only if you specifically want it, see the documentation above.

```bash
npm i -g @activeledger/activeledger @activeledger/activerestore
```

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

As of v4.0.0, packages are published to the [GitHub Packages npm registry](https://github.com/orgs/activeledger/packages) rather than npmjs.com. GitHub Packages requires authentication for install even on public repositories, so add an `.npmrc` alongside your `package.json` (do not commit a real token):

```
@activeledger:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then set `NODE_AUTH_TOKEN` to a GitHub personal access token with `read:packages` scope (a fine-grained token scoped to this org is fine) and install as normal:

```bash
export NODE_AUTH_TOKEN=<your github token>
npm i -g @activeledger/activeledger @activeledger/activerestore
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

We use [lerna](https://lernajs.io/) to manage this monorepo.
Make sure you have lerna installed.
If you use a package manager, install lerna with that. Otherwise:

```bash
npm install --global lerna
```

### Building

```bash
npm i
npm run build
```

`npm run setup` is also available for a full clean rebuild (`lerna clean` + bootstrap + build) if your `node_modules` are in a bad state — slower, and rarely needed for everyday work.

## Testing

Two separate test suites, deliberately decoupled so the fast one stays fast:

```bash
npm test              # fast unit tests (tests/*.ts, Mocha) - in-process, no real nodes
npm run test:network  # live 4-node network integration test - boots real nodes on the local machine
```

`npm test` runs in well under a second and is safe to run constantly during development.

`npm run test:network` (`tests/network/`) boots a real 4-node bare-host network, runs 100+ real transactions spread across every node as origin, deploys custom contracts and verifies `returnToRemote()`, verifies live event delivery over SSE, and verifies the network's Stream-Position-Incorrect self-healing by directly desyncing one node's local copy of a stream and confirming a transaction still succeeds whether that node is the transaction's origin or not. It prints live progress and a pass/fail summary, and takes well under a minute. Deliberately bare-host rather than Docker, so it doesn't add any requirements beyond what building the repo already needs.

## License

[MIT](https://github.com/activeledger/activeledger/blob/master/LICENSE)
