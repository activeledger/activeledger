<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activestorage

Activeledger's built-in data store: an embedded LevelDB store that a node starts beside itself, with an HTTP API and a browser explorer.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activestorage
```

Needs Node.js 24 or later.

A node with `db.selfhost` in its `config.json` runs this as its own process (port 5259 by default, one below the node's API port). It stores the ledger, the events and the errors, serves them over HTTP and a local socket, and serves the **database explorer** at `/_explorer`: browse streams, read a stream's state, meta, volatile data and history, export, compact, back up and prune.

The store has no login, so keep it on loopback. For a single process there is also an embedded form (`openEmbeddedStorage`, `EmbeddedDSConnect`), which the hybrid node uses.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [The database explorer](https://activeledger.github.io/activeledger/operate/explorer/) and [Pruning old data](https://activeledger.github.io/activeledger/operate/prune/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/storage)

MIT licensed.
