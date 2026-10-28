# The activehybrid command

`activehybrid` runs a hybrid: a node that follows a full Activeledger node (its upstream) and holds a copy of the ledger for reading, without taking part in consensus. This page lists what it accepts and the things you will do with it most.

Run it from the directory that holds the hybrid's `hybrid.json` and `.identity`.

## Commands

| Command | What it does |
|---|---|
| `start` | Run the node. This is the default when you give no command. `--foreground` keeps it attached to the terminal. |
| `stop` | Stop the node and wait for it to exit. `--timeout <s>` sets how long to wait (default 30). |
| `restart` | Stop, then start the node. |
| `status` | Print the node's state from its `/health`. Exit 0 ready, 2 not ready or lagging. `--max-lag <s>` treats more lag than this as not ready. |
| `check-config` | Validate `hybrid.json`. Exit 2 with the reason if it is wrong. |
| `init [--upstream host:port]...` | Create the identity and `hybrid.json`. Refuses to overwrite either without `--force`. |
| `register [--label x] [--endpoint p2p://host:port]...` | Register this key on the ledger. Safe to run again. |
| `update --endpoint ...` | Change the endpoints the registration advertises. |
| `retire` | Retire this registration. Permanent, so it asks for `--yes`. |
| `peers` | List the hybrids the upstream knows. |
| `divergences [--since <time>]` | List the local records of where this hybrid disagreed with its upstream. |
| `prune [--dry-run]` | Run the pruner now, which drops history older than the window. |
| `token` | Print a new random bearer token to put in the config. |
| `pin` | Print the hash of the upstream's network setup, to pin in the config once you have checked it another way. |
| `version` | Print the version. |
| `help [command]` | Show usage for the program or one command. |

## Flags

Common flags work with any command.

| Flag | What it does | Default |
|---|---|---|
| `--config <file>` | Config file | `./hybrid.json` |
| `--identity <file>` | Identity file (the hybrid's key pair) | `./.identity` |
| `--data-dir <dir>` | Data directory | `./data` |
| `--host <addr>` | Bind address for the local API | `127.0.0.1` |
| `--port <n>` | Bind port for the local API | `5270` |
| `--debug` | Debug logging | |
| `--json` | Machine-readable output | |
| `--quiet` | No banner, tagline or progress display | |
| `--yes` | Skip the confirmation on a destructive command | |
| `--help` | Show usage | |
| `--version`, `-v` | Print the version | |

Hybrid flags set the same things as keys in `hybrid.json`. Given with `init` they are written into the file; given with `start` they apply for that run only.

| Flag | What it does | Default |
|---|---|---|
| `--upstream <host:port[:p2p\|http]>` | A full node to follow. Repeat for more than one; the list replaces the file's. | |
| `--peer <host:port[:p2p\|http]>` | Another hybrid to fetch from (repeatable) | |
| `--token <token>` | Bearer token the local API requires | none |
| `--window-days <n>` | Days of history to keep | 30 |
| `--max-lag-seconds <s>` | Report 503 from `/health` beyond this lag. `none` clears it. | none |
| `--refuse-onboard <true\|false>` | Refuse `default/onboard` transactions | `true` |
| `--events-contract <id>` | Pin the events API to this contract (repeatable) | |
| `--events-where <field:value>` | Pin the events API to a payload field (repeatable) | |
| `--submit-contract <id>` | Accept transactions for this contract only (repeatable) | |
| `--force` | `init`: overwrite an existing identity or config | |
| `--since <time>` | `divergences`: only records since this time | |
| `--dry-run` | `prune`: report what would be done without doing it | |
| `--label <text>` | `register`: label for the registry entry | |
| `--endpoint <p2p://host:port>` | `register`, `update`: endpoint to advertise (repeatable) | |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done, or ready |
| 1 | Failed |
| 2 | A state check failed: not ready, lagging, not running, not registered, or an invalid config |

## Set up a new hybrid

In an empty directory:

```
activehybrid init --upstream 10.0.0.5:5260
```

Writes `.identity` (readable by you only, it holds the private key) and `hybrid.json`, and prints the key hash:

```
Wrote ./hybrid.json and ./.identity
key 3f9c...e21a
```

Give that key hash to the operator of the full node if the network only admits hybrids on an allowlist. Then check the config before the first start:

```
activehybrid check-config
```

Prints `./hybrid.json is valid`, or lists each reason it is not and exits 2.

[Set up and run a hybrid](../hybrid/run.md) walks through the whole first run.

## Start, stop and check

```
activehybrid
```

The node detaches and keeps running after you close the terminal. It writes `.activehybrid.pid` and appends its log to `activehybrid.log` in the current directory. Your terminal follows the start-up: on a terminal it shows progress lines (`catching up  42s behind ...`) and may not print a final `ready` line; when the output is piped it prints one plain line per step, ending `ok  ready`. Use `activehybrid status` to see when it is ready.

Start it with `--foreground` to keep it attached instead; then you see all six start-up steps, and Ctrl+C stops it:

```
[###]   config
[###]==[###]   identity
[###]==[###]==[###]   store
[###]==[###]==[###]==[###]   bootstrap
[###]==[###]==[###]==[###]==[   ]   catching up  42s behind  00000000000001a7
[###]==[###]==[###]==[###]==[###]==[###]   ready
```

A second `start` while one is running says `already running (pid 12345)` and exits 1.

```
activehybrid status
```

Prints `ready  lag 2s  cursor 00000000000001a7` and exits 0, or `not ready: not running` and exits 2. For a health check that also fails when the hybrid falls behind:

```
activehybrid status --max-lag 60
```

```
activehybrid stop
```

Prints `stopped 12345`, or `not running`. Both exit 0.

## Register on the ledger

A hybrid that other hybrids should be able to find, or that the network admits by allowlist, registers its key and the endpoint it serves:

```
activehybrid register --label "reporting" --endpoint p2p://hybrid.example.com:5271
```

Prints `registered <keyhash>`. Running it again prints `already registered (<keyhash>)` and exits 0. To change the endpoint later:

```
activehybrid update --endpoint p2p://hybrid.example.com:5272
```

To retire the key for good (a retired key can never register again; make a new identity with `init --force` if you need to come back):

```
activehybrid retire --yes
```

These commands talk to an upstream over `http`, so the config needs at least one `http` upstream.

## Protect the local API with a token

```
activehybrid token
```

Prints a random token. Put it in `hybrid.json` as `"token": "..."` and restart. Every request to the hybrid's API, including `status`, `divergences` and `prune`, must then send it as `Authorization: Bearer <token>`; the command reads it from the config for you.

## Pin the network you follow

A hybrid takes its picture of the network from its upstream. To make sure a changed upstream cannot hand it a different network, pin the hash of the network setup:

```
activehybrid pin
```

Prints the hash and a reminder to check it against a node you trust. Once you have, add it to `hybrid.json`:

```json
"pin": { "neighbourhoodSha256": "<the hash>" }
```

## See where it disagreed, and prune old history

```
activehybrid divergences --since 2026-10-01
```

Prints one line per record, `time  kind  umid`, or `no divergences`. A divergence is a transaction where the hybrid's result did not match its upstream's.

```
activehybrid prune --dry-run
```

Prints `would prune 120 umid docs and 340 events`. Without `--dry-run` it prunes and prints `pruned ...`. The node also prunes on its own, keeping `window.days` of history.

[Operating hybrids](../hybrid/operate.md) covers what to do about divergences and lag.
