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

### Leader mode

Leader mode answers the client without waiting for the other nodes to vote. It is fast and it is narrow: it only works for a transaction that writes **one stream**, or several streams that happen to live on the same node. Everything else runs as a normal transaction, with no error.

**To use it,** set `"$leader": true` inside `$tx` (the signed body), and the contract must accept it by resolving `{ leader: true }` from `vote()`. Without both it is a normal transaction.

**Who leads.** Every stream has one owner node, picked from the stream id and the list of active nodes, so every node works out the same owner. Leader mode is only ever run by that node, so two leaders can never commit different transactions at the same revision of a stream:

1. The node the client calls works out the owner of every stream the transaction writes (everything in `$i` and `$o`).
2. If it owns them all, it leads. If another single node owns them all, the transaction is passed to that node as the client sent it, and the client gets that node's reply. This costs one extra request.
3. If the streams belong to different nodes, the transaction is a normal one and the nodes vote.

**How a leader transaction runs.** The owner runs the transaction alone first and tells the other nodes only once its own vote is yes. A no is the answer in the client's response, and nothing is broadcast. On a yes it commits and answers the client; the other nodes then verify and vote for themselves, and each commits on its own vote. The reply says `"$leader": true`, and that is one node's answer, not network confirmation. The owner also sends a leader transaction to a node it has marked unreachable, once and without waiting, because nothing later asks whether a node received it: a link that stalled and came back would otherwise leave that node behind until the stream is next written.

**Where it fits.** A stream written by one client at a time through any node, a counter, a log, a client's own state. A transaction that moves value between two accounts writes two streams, which are usually on different nodes (with 4 nodes about three in four are), so it is almost always a normal vote and gets no speed up. If your transactions mostly write more than one stream, leader mode will not help you.

**What it does not do**
- It is ignored (the transaction runs as a normal one) with `$unanimous` and `$wait`, because only a broadcast transaction tells the other nodes about it.
- It cannot be combined with `$territoriality`. Leader mode lets the node that owns the stream commit first; territorial mode names the node that commits first. They ask for different nodes to lead, so a transaction with both is refused, with the reason in the reply, and nothing is written.
- It does not order a leader write against a normal write to the same stream. If a normal write to a stream races a leader write, the owner can commit its leader transaction while the other nodes commit the normal one, and the client that was told `$leader` may lose its write. Do not mix the two on one stream.
- If the owner node is down, a leader transaction for its streams fails. It does not move to another node.

### Territorial mode

Set `"$territoriality": "<node reference>"` on the transaction (next to `$tx`, not inside it) to name the node that writes first. The transaction is not broadcast. The node the client calls works out which node has to be entered so that the named node is the one that reaches the vote count first, and sends the transaction there as the client sent it. That node runs it, the votes pass along the ring to the named node, and the named node commits first (its contract sees `commit(true)` and `postProcess(true, ...)`). The client gets the committed response from the node that wrote.

Concurrent writers to the same stream through different nodes can leave the nodes on different revisions, because every node sees the transactions in a different order and votes no on the others. Give each stream one writer at a time. It cannot be combined with `$broadcast`, and it cannot be combined with `$tx.$leader`: a transaction with both is refused, with the reason in the reply, and nothing is written. It is not fault tolerant: if the named node is down, or a node before it in the ring votes no, the transaction fails rather than finding another route.

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
| `40250` | Two fixes to the stream permission check, which make it accept transactions an older node rejects: a transaction that names a contract `:data` stream together with an ordinary stream, and an input marked `$sigOnly` (which used to fail on every node). A stream that is not `$sigOnly` and has no state document is rejected with 950. |
| `40300` | Hybrid nodes: once hybrids are turned on (`activeledger hybrid enable`), each node signs its vote and its commit, the `hybrid` section is asserted on-ledger, hybrids can register, and the `/h/*` API serves them. A contract `update` can `lock` older versions, and locks are recorded on the contract stream so a restore brings them back. |
| `50300` | Nothing new is gated. New installs started here from 5.3.0 to 5.5.0 so the level matched the release; every level up to `40300` is on. From now on a level is named after the release that adds it. |
| `50600` | A contract is run only for the namespace it lives in: the loaded-contract cache is keyed by namespace and contract, so a contract that has run under its own namespace cannot be reached by naming another. |
| `51103` | A transaction with an `$expire` gets the same `$umid` however it is wrapped when it is sent: the id is the hash of `$tx`, the part the signatures cover, so `Transaction Exists` recognises it whatever else came with it, through any node. |

A new node's generated `config.json` has `51103`, so a new network has the stream fixes, the hybrid protocol, the namespace check and the one id for a signed transaction on. Hybrids themselves cost nothing until you turn them on. A network that was started earlier keeps its level until you raise it. A node joining an existing network must have its `build` set to that network's level before it starts. Running hybrids needs `40300` and `activeledger hybrid enable` (see [Hybrid nodes](../hybrid/run.md)).

### Faster signing once hybrids are on

Once hybrids are on, every node signs two things per transaction, and with the RSA identity key that is about half of the build's extra CPU. A node can sign with an Ed25519 key instead, which is about 17 times faster. It is optional and changes nothing until you switch it on:

1. Start the node on this version. Its `.identity` file gets an Ed25519 key beside the RSA one, and the log prints the public key. A new install already has it, and its generated `config.json` already lists it.
2. In `config.json`, add `"attest": { "type": "ed25519", "public": "<that public key>" }` to the node's own `neighbourhood` entry, next to `identity`.
3. [Assert the network](../first-network.md) again so the setup stream carries it. Hybrids verify a node's votes and attestations against `attest` when it is listed and `identity` when it is not, so do this on every node you want to switch.

A node signs with Ed25519 only while its neighbourhood lists the key, and with the identity key otherwise. Back up `.identity` as before: it now holds the Ed25519 private key too.

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

### Why a neighbour is not home

A node finds its neighbours by asking each one `GET /a/hello`. The answer says who the neighbour is, which chain it is on, whether it knows the asker, and whether it has loaded its own neighbourhood, and it is signed with the neighbour's identity key. The asker checks the signature against the public key in its own `neighbourhood` entry, so an answer from a different machine at the same address is not accepted. `GET /a/status` from the machine the node runs on lists each neighbour with a `state` and, when there is one, a `reason`:

| State | Meaning |
|---|---|
| `home` | Answered and checked. Used for consensus. |
| `unknown` | Not asked yet. |
| `unreachable` | No answer (not started, or stopped). It is asked again. |
| `booting` | Answered, but has not loaded its neighbourhood yet. It is asked again. |
| `refused` | Answered, but does not have this node in its neighbourhood. Add this node there. |
| `mismatch` | On a different chain, or its answer was not signed by the key configured for it. Not paired until the configuration is fixed. |

A neighbour from before this check answers `/a/hello` with a 404, and is asked with the older status request instead, so nodes can be upgraded one at a time. A neighbour that answered the hello also reports its `version` and `build`, shown as `peer` in the same local status.

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
