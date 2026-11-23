<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activequery

The event engine a transaction uses: it collects the events a contract raises, in order, so a node can store them with the transaction.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activequery
```

Needs Node.js 24 or later.

`EventEngine` is used inside a transaction's worker: a contract's `emit` calls go through it, and the events are attached to the transaction's umid record so a node that restores the transaction later can replay them. To read events, a node serves them at `/activeledgerevents/events` on its own storage port, reachable from the node's host only; see [The HTTP API](https://activeledger.github.io/activeledger/api/).

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [The HTTP API](https://activeledger.github.io/activeledger/api/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/query)

MIT licensed.
