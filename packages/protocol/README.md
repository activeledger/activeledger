<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activeprotocol

The part of Activeledger that runs a transaction: consensus voting, the stream permission checks, and the virtual machine that runs smart contracts.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activeprotocol
```

Needs Node.js 24 or later.

A node runs each transaction in a worker process using this package. It checks the signatures and permissions, runs the contract's `verify`, `vote` and `commit` in a sandbox (the contract may only reach what the node allows), takes part in the vote, and writes the streams when the vote passes. It also contains the leader-mode decision (`asksForLeader`) and the commit attestations hybrids check.

You do not call it directly; start a node with `activeledger` and send transactions to it. [Concepts](https://activeledger.github.io/activeledger/concepts/) explains how a transaction is decided.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [What Activeledger is](https://activeledger.github.io/activeledger/concepts/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/protocol)

MIT licensed.
