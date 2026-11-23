<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activesync

The ledger sync logic shared by the node, the hybrid and the restore tool, written over any peer transport.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activesync
```

Needs Node.js 24 or later.

- **SPI**: the tally that settles a `Stream Position Incorrect` disagreement, deciding which revision of a stream the network agrees on so a node that is behind can repair itself.
- **umid backfill**: fetch a transaction's record from the other nodes and keep the one a majority gives.
- **History walking**: walk a stream's past transactions so a node that missed some can fill them in.

Because it takes the peer transport as a parameter, the same logic serves a supernode talking over its own links and a hybrid talking over the peer-to-peer transport.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/activesync)

MIT licensed.
