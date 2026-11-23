# Activeledger packages

This folder holds every package in the Activeledger monorepo. It is an npm workspace: `npm ci` then `npm run build` at the repository root builds them all, in dependency order. Each package has its own README with its own detail; this page is the map.

Three of them are programs you run. The rest are libraries those programs are built from.

## Programs

| Folder | npm name | Command | What it does |
|---|---|---|---|
| [`activeledger`](activeledger) | `@activeledger/activeledger` | `activeledger` | The node. Starts the network layer, the embedded database and the transaction processors; also the `project` and `audit` commands. |
| [`hybrid`](hybrid) | `@activeledger/activehybrid` | `activehybrid` | A light node that follows a network without voting, and keeps its own copy of the ledger. |
| [`restore`](restore) | `@activeledger/activerestore` | `activerestore` | Repairs a node's ledger from the other nodes, or rebuilds it from empty. A node starts it for you by default. |

## Libraries

**Running a transaction**

| Folder | npm name | What it does |
|---|---|---|
| [`protocol`](protocol) | `@activeledger/activeprotocol` | Consensus voting, stream permission checks and the virtual machine contracts run in. |
| [`contracts`](contracts) | `@activeledger/activecontracts` | The base classes a smart contract extends, and the types it works with. |
| [`toolkits`](toolkits) | `@activeledger/activetoolkits` | The toolkits a contract may use to reach outside the ledger. |
| [`query`](query) | `@activeledger/activequery` | The event engine: collects the events a contract raises, in order, so the node can store them with the transaction. |

**Talking to other nodes and hybrids**

| Folder | npm name | What it does |
|---|---|---|
| [`network`](network) | `@activeledger/activenetwork` | The node's network layer: finds the other nodes, passes transactions between them, and takes the node's own API calls. |
| [`activep2p`](activep2p) | `@activeledger/activep2p` | Authenticated, encrypted peer to peer transport with request/response and push channels. |
| [`activesync`](activesync) | `@activeledger/activesync` | The ledger sync logic shared by the node, the hybrid and the restore tool, written over any peer transport. |
| [`httpd`](httpd) | `@activeledger/httpd` | A lightweight, portable HTTP server, built on uWebSockets.js, for a node's API and its storage service. |

**Data**

| Folder | npm name | What it does |
|---|---|---|
| [`storage`](storage) | `@activeledger/activestorage` | The built-in data store: an embedded LevelDB store with an HTTP API and the database explorer. |

**Shared foundations**

| Folder | npm name | What it does |
|---|---|---|
| [`crypto`](crypto) | `@activeledger/activecrypto` | Key pairs, signatures and hashes over several algorithms, behind one interface. |
| [`options`](options) | `@activeledger/activeoptions` | Configuration and the command line layer shared by the programs, with a few runtime helpers. |
| [`logger`](logger) | `@activeledger/activelogger` | Logging, and the timing marks used to profile a transaction. |
| [`definitions`](definitions) | `@activeledger/activedefinitions` | The TypeScript definitions shared across Activeledger: ledger entries, transactions, responses, streams. |
| [`utilities`](utilities) | `@activeledger/activeutilities` | Classes shared between Activeledger and its contract toolkits. |

## How they fit together

A request reaches the node's HTTP server (`httpd`), which `network` uses for its API. `network` hands the transaction to worker processes that run `protocol`: it checks the signatures and permissions, runs the contract (built on `contracts`, with `toolkits` and `query` available to it), and votes. `network` shares votes with the other nodes and, when they agree, the result is written to `storage`. `network` also serves hybrids over `activep2p`, and `activesync` keeps the ledgers of nodes, hybrids and restores in step. Everything uses `crypto`, `logger`, `options`, `definitions` and `utilities` underneath.

## Where to read more

- To run a node: the [guide](https://activeledger.github.io/activeledger/).
- To work on the code: [DEVELOPING.md](../DEVELOPING.md) in the repository root.
