<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activetoolkits

The toolkits a smart contract may use to reach outside the ledger.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activetoolkits
```

Needs Node.js 24 or later.

Only what is exported here is available to a contract, because the deploy scan refuses everything else (a namespace can be allowed more in `security.namespace.<name>`).

1. **HTTP**: a safe export of `ActiveRequest`. A contract's calls go through the node's guard: nothing on the storage port, nothing that reaches this machine unless the namespace allows it, and a time and size limit on each call.

```ts
import { HTTP } from "@activeledger/activetoolkits";
```

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Security](https://activeledger.github.io/activeledger/operate/security/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/toolkits)

MIT licensed.
