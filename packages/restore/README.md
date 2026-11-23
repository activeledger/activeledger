<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activerestore

Repairs a node's copy of the ledger from the other nodes: fills in what it missed, or rebuilds it from empty.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activerestore
```

Needs Node.js 24 or later.

Run it from a node's directory (it reads that directory's `config.json` and `.identity`). Left running it fixes transactions the node missed; with `--full` it rebuilds the whole database from the other nodes.

```bash
npm install -g @activeledger/activerestore

activerestore                 # watch, and fix what the node reports it missed
activerestore --full          # rebuild the database from the other nodes, then the history pass
```

`--fast`, `--skip-history` and `--history-only` adjust a full restore. `consensus.reached` must be set in `config.json`: restore keeps the copy of each stream that percentage of the neighbours agree on. `activeledger` starts it beside the node by default (`autostart.restore`).

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [The activerestore command](https://activeledger.github.io/activeledger/cli/activerestore/) and [Restoring a node](https://activeledger.github.io/activeledger/operate/restore/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/restore)

MIT licensed.
