<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activehybrid

A light node that follows an Activeledger network from its supernodes without taking part in consensus. It keeps an embedded store (no CouchDB), serves its own read and submit API, and relays the transactions it is sent to a supernode.

It does not trust the supernodes it follows. Every transaction is checked against the signed votes and commit attestations of the network's nodes, and every contract is run locally. When the result differs from what was committed the hybrid repairs the stream from the network and writes a divergence record.

```bash
npm install -g @activeledger/activehybrid

activehybrid init --upstream supernode.example.com:5260
activehybrid register --label "reporting node" --endpoint http://hybrid.example.com:5270
activehybrid start
activehybrid status
```

The supernodes need build `40300`. See the documentation for the network settings (`hybrid.admission`, `hybrid.required`, `hybrid.minVersion`), the `hybrid.json` options, the local API and what contract authors need to know (`isSupernode()`, `adoptFromSupernode()`).

`activehybrid --help` lists every command and flag.

|Language| |
|--------|-|
|English| [documentation](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/hybrid.md)|
