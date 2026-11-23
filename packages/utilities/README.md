<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activeutilities

Classes shared between Activeledger and its contract toolkits.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activeutilities
```

Needs Node.js 24 or later.

- `ActiveRequest`: the HTTP client. Inside a contract it is checked against the node's storage guard, so a contract can only reach what its namespace is allowed to.
- `ActiveClone`, `ActiveGZip`, `ActiveFrame`: object cloning and msgpack serialisation, compression and framing.
- `StorageSocket`: the framed socket between a node's processes and its storage.
- `ContractScope` and `StorageAccessError`: the guard that decides what a running contract may reach.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/utilities)

MIT licensed.
