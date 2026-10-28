# Concepts

What Activeledger is, in plain words. Read this once; the rest of the guide
assumes these terms.

## The ledger

A ledger is a record of things that have happened. In Activeledger the record is
kept by a group of computers rather than one. Each computer holds a full copy.
A change goes in only when enough of the group agree to it, so no single computer
can rewrite the record on its own.

The record is not one long chain of blocks. It is made of many small records called
streams (below), and each one has its own history.

## Nodes

A node is one computer running the `activeledger` program. The nodes that vote on
changes are called supernodes. When this guide says "node" without qualification,
it means a supernode.

Activeledger is permissioned: a network is a fixed list of nodes that know each
other. Each node has an identity, a key pair stored in a file called `.identity`
in the folder it runs from. The list of nodes, with each one's address and public
key, is called the neighbourhood. A computer that is not on the list cannot take
part.

### How nodes agree

A transaction is sent to any one node. That node passes it to the others. Every
node runs the contract the transaction names and votes yes or no on its own
result; no node waits for a leader to decide. When the share of yes votes reaches
the network's threshold, every node commits the change to its own copy. The
threshold is `consensus.reached` in the configuration, a percentage, and the
default is 60. A stream is locked while a transaction is changing it, so
transactions that touch different streams do not wait for each other.

## Streams

A stream is one record on the ledger: a bank account, a certificate, a device,
whatever your contract needs. It has an id (a long hash) and a current state,
which is a JSON document. Every change to a stream is a new version, and the old
versions are kept.

Each stream is stored as three documents:

- the state, which contracts read and change;
- the meta document (`<id>:stream`), which holds who may change it, among other things;
- a volatile document (`<id>:volatile`), which is local to each node and never leaves it.

An identity on the ledger is itself a stream. The first thing a new user does is
create one (see [Identities](identities.md)).

## Transactions

A transaction is a JSON message asking the network to run a contract. Its `$tx`
part names the namespace, the contract and the entry point to run, and lists the
streams involved:

- `$i`, inputs: streams that must be signed for by their owners;
- `$o`, outputs: streams the contract may change without a signature;
- `$r`, references: streams the contract reads.

The message also carries `$sigs`, one signature per input, made with the key that
owns that stream. The reply tells you the transaction id (`$umid`), how many nodes
voted and committed, and which streams were created or updated. See
[Transactions](transactions.md).

## Contracts

A contract is the code that decides whether a transaction is allowed and what it
changes. You write it in TypeScript as a class with two main methods: `vote()`,
which checks the transaction and answers yes or no, and `commit()`, which writes
the new state. Every node runs the same contract on the same input, which is why
they can compare votes.

A contract is deployed by sending it to the network in a transaction. Once
deployed it is stored on every node under `contracts/<namespace>/`. Activeledger
ships with a few default contracts in the `default` namespace: `onboard` (create
an identity), `namespace` (claim a namespace), `contract` (deploy and manage
contracts), `setup` (network configuration) and `hybrid` (hybrid registration).

## Namespaces

A namespace is a name you own on the network, and the place your contracts live.
You claim one with the default `namespace` contract, signed by your identity, and
from then on only that identity can deploy contracts into it. The name `default`
is reserved. See [Identities](identities.md).

## Hybrid nodes

A hybrid is a lighter node, run with the `activehybrid` program, that follows the
supernodes rather than voting with them. It subscribes to one or more supernodes,
re-runs every contract on its own copy of the data, and keeps only what the
supernodes agreed. It serves its own API and its own event feed, and it can accept
transactions from users and pass them on to the supernodes. A hybrid keeps the
current state of every stream plus a rolling window of history (30 days by
default), so it stays small. See [Hybrid nodes](hybrid/index.md).

## Glossary

| Term | Meaning |
| --- | --- |
| Node, supernode | A computer running `activeledger`. Supernodes vote. |
| Hybrid | A non-voting node running `activehybrid` that follows the supernodes. |
| Neighbourhood | The list of nodes in a network, with their addresses and public keys. |
| Identity | A key pair. A node's is in `.identity`; a user's is also recorded on the ledger as a stream. |
| Stream | One record on the ledger, with an id, a state and a history. |
| Transaction | A signed JSON message asking the network to run a contract. |
| `$umid` | The id of a transaction. |
| Contract | TypeScript code with `vote()` and `commit()`, run by every node. |
| Namespace | A name an identity owns; contracts are deployed into it. |
| Consensus | The agreement of enough nodes. `consensus.reached` sets the percentage, default 60. |
| Volatile | Data a contract keeps on one node only. It is never shared. |
