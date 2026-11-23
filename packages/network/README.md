<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activenetwork

The node's network layer: it finds the other nodes, passes transactions between them, and takes the node's own API calls.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activenetwork
```

Needs Node.js 24 or later.

It holds the parts of a node that talk to other nodes and to clients:

- `Home` and `Neighbour`: this node, and the other nodes it knows, with their state and the links between them.
- `Host`: the running node. It hands each transaction to a worker process, broadcasts the votes and commits, and answers the client.
- `Endpoints`: the HTTP API (`/a/status`, transactions, and the rest), including routing a leader or territorial transaction to the node it belongs on.
- Leader and territorial helpers (`ownerOf`, `leaderStreams`, `terriMap`).

Applications use a node through its HTTP API, not this package. Read [Nodes, consensus and upgrades](https://activeledger.github.io/activeledger/operate/nodes/) for what the network does.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Nodes, consensus and upgrades](https://activeledger.github.io/activeledger/operate/nodes/) and [The HTTP API](https://activeledger.github.io/activeledger/api/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/network)

MIT licensed.
