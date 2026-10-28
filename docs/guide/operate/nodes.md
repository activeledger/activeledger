# Nodes, consensus and upgrades

How many nodes to run, how they agree, what the `build` number does, and how to upgrade or add a node without breaking the network.

## How many nodes

A node checks its data against the other nodes. With few nodes there is little to check against.

- 1 to 3 nodes work, but treat that as the least you can run at all.
- 4 is a safe minimum.
- 5 or more is best.

Every node must use the same kind of storage (the embedded store or CouchDB) and the same `build`.

## How consensus works

Every node runs each transaction and votes yes or no. The transaction is committed when the share of yes votes reaches `consensus.reached` in `config.json`, a percentage of all nodes (default 60). A transaction with `$unanimous` set needs every node.

With 5 nodes and `reached` at 60, three yes votes commit. With 4 nodes, three are needed, because two is 50%.

The same percentage decides repairs, but counted a little differently. When a node repairs a stream it asks the other nodes, so the bar is the percentage of all nodes, less one for the node asking, rounded up:

```
votes needed = ceil(reached / 100 × nodes − 1)
```

With 4 nodes at 60% that is `ceil(2.4 − 1) = 2`, so two other nodes agreeing is enough. The "less one" is what lets a network split exactly in half still decide. A full restore uses the same sum.

## What SPI is

A stream is one record on the ledger, with a position that moves on each time it changes. When a node has fallen behind, its copy of a stream is at an older position than everyone else's, and its vote on the next transaction that touches that stream fails with "Stream Position Incorrect". SPI is the repair that follows: the node asks the other nodes which copy they hold, and when enough of them agree (the sum above) it adopts that copy and carries on. It happens on its own, while the node runs. A node that is far behind, or missing whole streams, needs a [restore](restore.md).

## Builds

`build` in `config.json` is the protocol level the node runs at. A new release can run at the old level, so you can upgrade one node at a time; the new behaviour only switches on when every node's `build` is raised. Raising it on some nodes before every node is upgraded splits the network.

| Build | What it switches on |
|---|---|
| `40100` | Authority expiry is enforced (an authority with an `expire` date stops signing after it). Contract source is stored once, as a reference to the deploying transaction, instead of a copy in the contract stream. |
| `40200` | New contract versions compile to ES2025 (newer JavaScript) instead of ES2017. |
| `40300` | Hybrid nodes: each node signs its vote and its commit, the `hybrid` section is asserted on-ledger, hybrids can register, and the `/h/*` API serves them. A contract `update` can `lock` older versions, and locks are recorded on the contract stream so a restore brings them back. |

A new node's generated `config.json` has `40200`. A node joining an existing network must have its `build` set to that network's level before it starts. Running hybrids needs `40300`.

## Upgrading the network

Two steps, and the second only once the first is finished on every node.

1. Upgrade every node, one at a time (below), leaving `build` as it is.
2. Set the new `build` in every node's `config.json` and restart it. With `"remote": true` you can reload instead, from the node's own machine:

```
curl http://127.0.0.1:5260/a/admin-reload
```

You should see `{"status":"success","build":40300}`.

## Upgrading one node

Do one node at a time and let it settle before the next, so the network keeps enough nodes to vote.

```
activeledger stop
```

This waits up to 30 seconds for the node to exit (`--timeout <s>` changes that). Install the new version, then:

```
activeledger
```

The start-up display walks through `config`, `identity`, `database`, `network`, `consensus` and `ready`. `consensus` is done when the node has found its neighbours. Check it from another shell:

```
activeledger status
```

You should see `ready (pid 12345)`. It exits 2 with `not running` when the node is down. Transactions the node missed while it was off are repaired by SPI as streams are next touched.

## Adding a node

Once the network is [asserted](../first-network.md), the list of nodes lives on the ledger and is changed with a transaction to the `default/setup` contract. More than half of the existing nodes must sign it with their own node keys (the `.identity` file), and the signatures are named by each node's `host:port`.

1. On the new machine, install Activeledger and run `activeledger --public` to generate its identity and print the public key.
2. Submit an `add` transaction to any running node. `suggester.identity.public` is the new node's public key, and `$o` names the network stream (the id in the `network` key of an existing node's `config.json`, before the `@`).

```json
{
  "$tx": {
    "$namespace": "default",
    "$contract": "setup",
    "$entry": "add",
    "$i": {
      "suggester": {
        "type": "rsa",
        "publicKey": "[a signing public key]",
        "identity": { "type": "rsa", "public": "[new node public key]" },
        "host": "10.0.0.14",
        "port": "5260"
      }
    },
    "$o": { "[network stream id]": {} }
  },
  "$selfsign": true,
  "$sigs": {
    "suggester": "[signature]",
    "10.0.0.11:5260": "[signature]",
    "10.0.0.12:5260": "[signature]",
    "10.0.0.13:5260": "[signature]"
  }
}
```

   It is refused with `Node already exists` when that `host:port` is already in the list, and with `Host node signature problem` when there are not enough valid node signatures. On success every running node reloads its neighbourhood.

3. Give the new node a `config.json` with the full `neighbourhood` (itself included), the network's `consensus` and `security`, the same `build` and the same kind of storage, and `network` set to `"<setup stream id>@<the setup stream's _rev>"` (how to find the revision is in [Restoring a node](restore.md); without it the other nodes refuse the restore with 403). Then fetch the data before the node starts. The restore writes to the node's database, so start only that first, and run the restore in a second shell in the same folder:

```
activeledger --db-only
```

```
activerestore --full
```

   It ends with exit 0 when the data is in. Stop the database with Ctrl+C.

4. Start the new node. It reads the network's settings from its restored database from then on.

Removing a node is the same transaction with `"$entry": "remove"` and the leaving node's details in `suggester`.

## Changing the network's settings

After assert, `consensus`, `security` and `neighbourhood` are no longer in the file. The hybrid rules are changed with `activeledger hybrid ...` (see [Operating hybrids](../hybrid/operate.md)); nodes are added and removed as above. The settings that stay in the file (`build`, `debug`, `restore`, storage) are changed by editing it and restarting, or reloading with `remote` on.
