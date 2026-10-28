# Run a first node, then a small network

Start one node on your machine, see it come up, and then build a network of
several nodes. You need the programs [installed, built and linked](install.md).

## What a node needs

A node runs from a folder of its own. The first time `activeledger` starts in an
empty folder it creates everything it needs there:

| File or folder | What it is |
| --- | --- |
| `.identity` | The node's key pair. Keep it private; it is written readable by your user only. |
| `config.json` | The node's configuration, copied from the built-in default with this node added to `neighbourhood`. |
| `contracts/`, `default_contracts/` | Where deployed contracts and the default contracts live. |
| `.ds/` | The data store. |
| `.PID` | The process ids of the running node and its helpers, used by `status` and `stop`. |
| `.STATS` | The node's start time and restart count, used by `--stats`. |

A node uses three ports, all from the one port you choose (default 5260):

| Port | Used for |
| --- | --- |
| 5260 | The HTTP API. This is where transactions are sent. |
| 5259 (port − 1) | The node's own data store. |
| 5261 (port + 1) | Node-to-node traffic. |

So when you run several nodes on one machine, leave a gap of at least three
between their ports. The examples below use a gap of ten.

## One node

```bash
mkdir node-a && cd node-a
activeledger
```

The node generates its identity, writes `config.json`, starts its data store and
then itself. On a terminal it prints a banner and then one line per start-up step:
`config`, `identity`, `database`, `network`, `consensus`, `ready`. When the last
line reads

```
[###]==[###]==[###]==[###]==[###]==[###]   ready
```

the node is up. Ordinary log lines follow. By default the node also starts
`activerestore` beside itself (`autostart.restore` in `config.json`), so you will
see its logs too.

A single node is a complete network: it reaches the 60% vote threshold on its own.

Check it from another terminal, in the same folder:

```bash
activeledger status
```

```
ready (pid 12345)
```

Or ask the API:

```bash
curl http://127.0.0.1:5260/a/status
```

The reply is JSON. `"status": 4` means the node has a settled view of its
neighbours; it also lists them under `neighbourhood.neighbours`.

Stop it from the node's folder:

```bash
activeledger stop
```

`stop` reads `.PID` and stops the node, its data store and `activerestore`, then
waits for the node to exit. It is the way to stop a node that runs in the
background. `Ctrl-C` in the node's terminal does the same: the node, its data
store and `activerestore` stop together, also if you press it while the node is
still starting. Pressing it twice forces an exit. Start it again with
`activeledger`; the files are kept.

## A local test network in one command

For trying things out on one machine, `--testnet` builds a three-node network for
you. Run it in a new, empty folder. It needs `activeledger` on your PATH (the
`npm link` step in [Install](install.md)).

```bash
mkdir testnet && cd testnet
activeledger --testnet
```

It creates `instance-0`, `instance-1` and `instance-2` on ports 5260, 5270 and
5280, sets each one up, merges their configurations so each knows the others, and
writes a launcher script called `testnet`. The end of its output tells you how to
run them. For a different number of nodes, say `activeledger --testnet 5`.

Run all the nodes at once:

```bash
node testnet
```

You see the output of `instance-0` only; the others run silently. Or run each one
in its own terminal:

```bash
cd instance-0 && activeledger
```

The API of the first node is at `http://127.0.0.1:5260`, the second at
`http://127.0.0.1:5270`, and so on. Each node's `activeledger status` and
`activeledger stop` work from its own `instance-*` folder.

!!! note
    Every instance shares one `.identity`, copied from, or created in, the
    folder you ran `--testnet` in. That is fine for a test and wrong for a real
    network. The ports are fixed at 5260, 5270 and 5280 (`--port` has no effect
    on a testnet); `activehybrid` also listens on 5270 by default, so a hybrid
    next to a testnet needs `--port`. The instances are set up with
    `--disable-autostart`, so they do not each run an `activerestore`.

## A network by hand

This is what `--testnet` does, done yourself. It is the way to build a network
across several machines, and it is also how the project's own integration tests
build a four-node network.

### 1. Set up each node

In a folder of its own for each node, run setup only. This writes `.identity`,
`config.json`, `.PID`, `contracts/` and `default_contracts/` and exits without
starting anything. (`.STATS` is written at the first real start.)

On one machine, give each node its own port:

```bash
mkdir node-a node-b node-c
(cd node-a && activeledger --setup-only --port 5510)
(cd node-b && activeledger --setup-only --port 5520)
(cd node-c && activeledger --setup-only --port 5530)
```

On separate machines, give each node the address the others will reach it on:

```bash
activeledger --setup-only --host 10.0.0.11 --port 5260
```

Then open `config.json` and check its `host` value. `--host` is written into the
node's own entry under `neighbourhood`, but the top-level `host` (the address the
node binds to) is only changed from `127.0.0.1` when the port is not 5260. Make it
the same address and port as the neighbourhood entry, for example
`"host": "10.0.0.11:5260"`.

### 2. Merge the configurations

Each `config.json` now lists one node: itself. `--merge` takes several of these
files, collects their single entries into one neighbourhood, and writes that full
list back into every file.

```bash
activeledger --merge node-a/config.json --merge node-b/config.json --merge node-c/config.json
```

```
Local neighbourhood configuration has been merged
```

Across machines, copy every node's `config.json` to one place, merge them there,
and copy each file back to its node. The command generates a `.identity` in the
folder you run it from if there is none; that file is not used and can be deleted.

`--merge` needs at least two files: given one, it prints `--merge needs two or
more configuration files, one per node, e.g. --merge a/config.json --merge
b/config.json` and exits 1. Each file must still have exactly one entry, so run
it once, before any node has started.

### 3. Start the nodes

In each node's folder:

```bash
activeledger
```

A node waits at the `consensus` step until it can see its neighbours; a step that
takes a while prints `...` once. When every node shows `ready`, the network is up.
Confirm it from any node:

```bash
curl http://127.0.0.1:5510/a/status
```

`"status": 4`, and every neighbour listed with `"isHome": true`.

!!! warning
    Every node in a network must run the same `build` value in `config.json`. A
    fresh setup writes the current one, so a network built this way matches. See
    [Nodes](operate/nodes.md) before you add a node to an existing network.

## Put the configuration on the ledger

Once every node is up, you can move the network's configuration (the
neighbourhood, consensus and security settings) from the files onto the ledger
itself. From then on the nodes read it from there at start-up, and nodes can be
added or removed by transaction instead of by editing every file. This is optional
and one-way. Run it in one node's folder while all nodes are online:

```bash
activeledger --assert
```

It refuses unless every neighbour is online, then sends a signed `default/setup`
transaction to the node. It runs once: on success it prints `Network Asserted to
the ledger` with the new stream and exits 0; on failure it prints `Networking
Assertion Failed` and exits 1. The nodes keep running. Restart every node
afterwards if hybrids will follow the network (see [Run a hybrid](hybrid/run.md)).
Running it again prints `Network has already been asserted` and exits 0.

Next: [config.json: what you need to set](operate/configuration.md), or
[send a transaction](transactions.md).
