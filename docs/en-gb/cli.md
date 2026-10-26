# Command Line

`activeledger` (the supernode) and `activehybrid` share one command line layer: the same flags mean the same thing, the same start-up display, and the same exit codes. `activerestore` is a separate program (see [restore](restore.md)).

```bash
activeledger [command] [flags]
activehybrid [command] [flags]
```

`help [command]`, or `--help` anywhere, prints every command and flag grouped by purpose, with the defaults. `version` (or `-v`) prints the version.

## Common to both

| Flag | Meaning |
| ---- | ------- |
| `--config <file>` | Configuration file. Default `./config.json` for a supernode, `./hybrid.json` for a hybrid. |
| `--identity <file>` | Identity file. Default `./.identity` for both. |
| `--data-dir <dir>` | Data directory. |
| `--host <addr>`, `--port <n>` | Bind address and port. Defaults: `127.0.0.1:5260` for a supernode, `127.0.0.1:5270` for a hybrid, so both run on one machine. |
| `--debug` | Debug logging. |
| `--json` | Machine-readable output on any command that prints data. |
| `--quiet` | No banner, tagline or progress display. |
| `--yes` | Skip the confirmation on a destructive command. |

| Command | Does |
| ------- | ---- |
| `start` | Run the node. The default when no command is given. |
| `stop` | Stop the node and wait for it to exit. |
| `restart` | Stop, then start. |
| `status` | Print the node's state. Exit 0 when ready, 2 when not. |
| `check-config` | Validate the configuration file. Exit 2 with the reason if it is wrong. |

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Success. |
| 1 | Failure, including an unknown command or flag. |
| 2 | A state check failed: not ready, lagging, outdated, not registered, or an invalid configuration. |

`status` and `check-config` are meant for scripts and health checks.

### Unknown commands and flags

An unknown command or flag prints what was not recognised, the nearest known name, and a pointer to `help`, then exits 1 **before anything starts**. A typo such as `--assrt` can therefore no longer start a node. A script that passes a flag that nothing reads will now fail, and should have the flag removed. Every flag and configuration key the code reads is registered.

### Output

When output goes to a terminal, `start` shows a short banner and one block per start-up step, filled in as each step completes, with the reason printed at the block that failed. When output is not a terminal, or with `NO_COLOR`, `--quiet` or `--json`, the banner and the display are left out and each step is one plain line (`ok  database`), so logs and scripts never receive escape codes.

## activeledger

```bash
activeledger --testnet            # build a local test network
activeledger --assert             # assert the config on the ledger
activeledger                      # run the node
```

| Flag | Meaning |
| ---- | ------- |
| `--testnet` | Build a local test network. |
| `--merge` | Merge configurations to build a local network. |
| `--assert`, `--assert-network` | Assert the configuration on the ledger (as a network). |
| `--sign <file>` | Sign the asserted configuration. |
| `--public` | Print the node's public key. |
| `--setup-only` | Run setup, then exit. |
| `--db-only` | Start only the database. |
| `--disable-autostart` | Do not start the helper processes. |
| `--backup [file]`, `--restore <file>` | Back up, or restore, the ledger. |
| `--stop`, `--restart`, `--auto`, `--stats` | The older forms of `stop`, `restart`, an automatic restart and node statistics. Still accepted. |
| `--hybrid-listen <port>` | Port for the hybrid P2P listener. |
| `--hybrid-max-feeds <n>` | Most hybrid feeds served at once. Default 32. |

`activeledger hybrid ...` manages the hybrids that follow the node: `list`, `feeds`, `ban <keyhash>`, `unban <keyhash>`, `allow`, `deny`, `admission <open|allowlist>`, `min-version <semver>`, `sign <file>` and `submit <file>`. The changes to the network's hybrid rules (`allow`, `deny`, `admission`, `min-version`) need more than half of the nodes to sign; `--out <file>` writes the signed request to a file instead of sending it. See [hybrid](hybrid.md).

## activehybrid

`init`, `token`, `check-config`, `pin`, `register`, `update`, `retire`, `peers`, `start`, `stop`, `restart`, `status`, `divergences` and `prune`, with the flags `--upstream`, `--peer`, `--token`, `--window-days`, `--max-lag-seconds`, `--refuse-onboard`, `--events-contract`, `--events-where`, `--submit-contract`, `--label`, `--endpoint`, `--force`, `--since` and `--dry-run`. Each is described in [hybrid](hybrid.md). For a hybrid, a flag overrides the same key in `hybrid.json`.
