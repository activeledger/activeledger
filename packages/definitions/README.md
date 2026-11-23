<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activedefinitions

The TypeScript definitions shared across Activeledger: ledger entries, transactions, responses, streams and the other shapes the packages pass to each other.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activedefinitions
```

Needs Node.js 24 or later.

```ts
import { ActiveDefinitions } from "@activeledger/activedefinitions";

const handle = (entry: ActiveDefinitions.LedgerEntry) => entry.$umid;
```

If you are writing a client, the fields of a transaction and its reply are described in [Sending a transaction](https://activeledger.github.io/activeledger/transactions/).

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Sending a transaction](https://activeledger.github.io/activeledger/transactions/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/definitions)

MIT licensed.
