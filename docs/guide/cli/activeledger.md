# The activeledger command

`activeledger` runs a node and manages it: start, stop, check its state, build a local test network, and manage the hybrids that follow it. This page lists what it accepts and the things you will do with it most.

Run it from the directory that holds the node's `config.json` and `.identity`. Every path it reads or writes is relative to where you run it.

## Commands

| Command | What it does |
|---|---|
| `start` | Run the node. This is the default when you give no command. |
| `stop` | Stop the node and wait for it to exit. `--timeout <s>` sets how long to wait (default 30). |
| `restart` | Stop the node, then run it attached to this terminal, as `start` does. |
| `status` | Print the node's state. Exit 0 when running, 2 when not. |
| `check-config` | Validate the config file. Exit 2 with the reason if it is wrong. |
| `version` | Print the version. |
| `help [command]` | Show usage for the program or one command. |
| `hybrid <subcommand>` | Manage the hybrids that follow this node. See below. |

## Flags

Common flags work with any command.

| Flag | What it does | Default |
|---|---|---|
| `--config <file>` | Config file | `./config.json` |
| `--identity <file>` | Identity file (the node's key pair) | `./.identity` |
| `--data-dir <dir>` | Data directory, written into a new config | `./.ds` |
| `--host <addr>` | Bind address, written into a new config | `127.0.0.1` |
| `--port <n>` | Bind port, written into a new config | `5260` |
| `--debug` | Debug logging | |
| `--json` | Machine-readable output | |
| `--quiet` | No banner, tagline or progress display | |
| `--yes` | Skip the confirmation on a destructive command | |
| `--help` | Show usage | |
| `--version`, `-v` | Print the version | |

Setup flags run a one-off job instead of starting the node. `--assert`, `--assert-network`, `--sign`, `--public` and `--setup-only` run once and exit (0 when done, 1 when they fail) and do not touch a running node's `.PID`, so they are safe to run beside a running node.

| Flag | What it does |
|---|---|
| `--testnet [n]` | Build a local test network of `n` nodes (default 3) |
| `--merge <file>` | Merge the config files given (repeat the flag) into one neighbourhood |
| `--assert` | Write the config's network to the ledger, so the nodes stop trusting the file |
| `--assert-network` | The same as `--assert` |
| `--sign <file>` | Sign a transaction file with this node's identity and print the signature |
| `--public` | Print the node's public key |
| `--setup-only` | Create `.identity`, `config.json`, `.PID`, `contracts/` and `default_contracts/`, then exit. `.STATS` is written at the first real start |
| `--db-only` | Start only the embedded database and keep it running, for example for a restore. Ctrl+C stops it |
| `--disable-autostart` | When writing a new config, do not start the restore engine with the node |

Other flags.

| Flag | What it does | Default |
|---|---|---|
| `--backup [file]` | Back up the ledger (embedded database only) | |
| `--restore <file>` | Restore the ledger from a backup (embedded database only) | |
| `--hybrid-listen <port>` | Port for the hybrid P2P listener | |
| `--hybrid-max-feeds <n>` | Most hybrid feeds served at once | 32 |
| `--out <file>` | `hybrid allow`, `deny`, `admission`, `min-version`: write the signed change to a file instead of sending it | |
| `--stop`, `--restart`, `--auto`, `--stats` | Older spellings. `--stop` and `--restart` are the commands above; `--auto` marks a restart as automatic; `--stats` prints restart and uptime figures | |

## Exit codes

Every Activeledger program uses the same three.

| Code | Meaning |
|---|---|
| 0 | Done, or the state check passed |
| 1 | Failed |
| 2 | A state check failed: not running, not ready, or an invalid config |

A mistyped command or flag exits 1 and suggests the nearest name, for example `Unknown command "stauts". Did you mean "status"?`.

## Start a node

```
activeledger
```

The first run in an empty directory creates `.identity` (the node's key pair) and `config.json`, then starts. You see a chain that grows one block per start-up step:

```
 [###]==[###]==[###]
   activeledger 5.1.1
   Every link holds.

[###]   config
[###]==[###]   identity
[###]==[###]==[###]   database
[###]==[###]==[###]==[###]   network
[###]==[###]==[###]==[###]==[###]   consensus
[###]==[###]==[###]==[###]==[###]==[###]   ready
```

A step that stops the node is drawn as `[ X ]` with the reason under it. Under systemd or pm2, or with `--quiet`, each step is one plain line such as `ok  config`. Log lines carry on after the chain.

To put the node on another port, give it on the first run and the new config is written with it:

```
activeledger --port 5280
```

The node stays attached to your terminal. Press Ctrl+C once and it stops taking new transactions and shuts down cleanly (`Shut Down Initiated`); its database and restore engine stop with it, also if you press it while the node is still starting. Press Ctrl+C again and it exits at once (`Shut down forced`, exit code 1). A stop signal from a service manager does the same.

To run it as a service, see [How many nodes, consensus, builds and upgrades](../operate/nodes.md).

## Stop, restart and check a node

Run these from the node's directory. They read the `.PID` file the node wrote there.

```
activeledger status
```

Prints `ready (pid 12345)` and exits 0, or `not running` and exits 2. With `--json`: `{"ready":true,"pid":12345}`.

```
activeledger stop
```

Stops the node, its database and its restore engine, then waits up to 30 seconds for the node to go. If the process did not exit in time, it says so and exits 1. A process that has already gone is not an error. This is the way to stop a node that runs in the background.

```
activeledger restart
```

Stops the node as `stop` does, then runs it attached to this terminal, as `start` does: you see the start-up chain, and closing the terminal stops the node. To restart a node that runs in the background, use `stop` and then start it the way you did before.

Before a restart, check the config file still parses and has what a node needs:

```
activeledger check-config
```

Prints `./config.json is valid`, or `./config.json is not valid: missing host, db` with exit code 2.

## Build a local test network

```
activeledger --testnet
```

Creates `instance-0`, `instance-1` and `instance-2`, each with its own config on ports 5260, 5270 and 5280, merges them into one neighbourhood, and writes a `testnet` script. Then start them all:

```
node testnet
```

`--testnet 5` builds five. It runs `activeledger` from your PATH, so it needs the `npm link` step in [Install](../install.md). [Run a first node, then a small network](../first-network.md) walks through this.

!!! note
    The instances share one `.identity`, copied from, or created in, the directory you ran `--testnet` in. Their ports are fixed at 5260, 5270 and 5280 (`--port` has no effect on a testnet); `activehybrid` also listens on 5270 by default, so a hybrid next to a testnet needs `--port`.

## Merge configs by hand

To join nodes you set up yourself, run `--setup-only` in each node's directory, then merge their config files. Each file must list only its own node in `neighbourhood`:

```
activeledger --merge ./node-a/config.json --merge ./node-b/config.json --merge ./node-c/config.json
```

Every file is rewritten with the full neighbourhood and you see `Local neighbourhood configuration has been merged`. Given one file it prints `--merge needs two or more configuration files, one per node, e.g. --merge a/config.json --merge b/config.json` and exits 1.

## Assert the network to the ledger

While `config.json` lists the neighbourhood, each node trusts the file. Asserting writes the network to the ledger, so changes after that need the nodes to agree. Start every node, then on one of them run:

```
activeledger --assert
```

All known nodes must be online, or it stops with `All known nodes must been online for assertion`. On success it prints `Network Asserted to the ledger` with the new stream and exits 0; on failure it prints `Networking Assertion Failed` and exits 1. The nodes keep running and need nothing from you. Restart every node afterwards if hybrids will follow the network (see [Run a hybrid](../hybrid/run.md)). Running it again prints `Network has already been asserted` and exits 0.

## Print the public key or sign a file

```
activeledger --public
```

Prints the node's public key in PEM, to give to another node or a hybrid operator.

```
activeledger --sign tx.json
```

Signs the `$tx` part of the file (or the whole file if it has none) with the node's private key and prints the signature between `-----BEGIN SIGNATURE-----` and `-----END SIGNATURE-----`.

## Manage hybrids

A hybrid is a read-only follower that is fed by this node. These subcommands ask the running node, so it must be up.

```
activeledger hybrid list
activeledger hybrid feeds
activeledger hybrid ban <keyhash>
activeledger hybrid unban <keyhash>
```

`list` prints one line per registered hybrid: key hash, label, endpoints, and `retired`, `banned` or `feed` when they apply. `feeds` prints `3 of 32 feeds` and one line per connected hybrid. `ban` and `unban` take the key hash from `list`.

These change the hybrid rules held on the ledger, so more than half the nodes must sign them.

```
activeledger hybrid allow <key>
activeledger hybrid deny <key>
activeledger hybrid admission open|allowlist
activeledger hybrid min-version <semver>
```

`<key>` is a key hash, a PEM public key, or a file holding one. On a one-node network the command signs and sends the change itself and prints `applied to the ledger`. On a larger network write it to a file, have each other node sign it, then send it:

```
activeledger hybrid allow hybrid.pem --out change.json
# on each other node, in its directory, with the file copied there
activeledger hybrid sign change.json
# then, from any node
activeledger hybrid submit change.json
```

`sign` prints `signed by host:port, host:port` so you can see how many have signed. The rules need the network to have been asserted first.

[Operating hybrids](../hybrid/operate.md) explains when to use each of these.

## Back up and restore the embedded database

```
activeledger --backup
activeledger --restore backup-file
```

Both need the embedded (self-hosted) database and refuse otherwise. To rebuild a node from the other nodes rather than from a file, use [activerestore](activerestore.md).
