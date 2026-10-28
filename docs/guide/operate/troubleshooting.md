# When something is wrong

What a message means and what to do about it. Find the line you see in the log, the command output or the transaction reply.

## Starting and stopping

| What you see | Why | What to do |
|---|---|---|
| `./config.json is not valid: missing host, db` from `check-config` | The file has no `host` or no `db`. | Add them: see [Configuration](configuration.md). |
| `Unknown command "stauts". Did you mean "status"?` | A typo in the command or flag. The program exits 1. | Run `activeledger help`. |
| `IP:Port Binding not found in configuration or arguments.` | No `host` in the file and no `--host`/`--port`. | Set `host` to `ip:port`. |
| `./.identity not found` on the `identity` step | The identity file is not where `--identity` points. | Fix the path, or start without `--identity` so the node makes one. |
| `Neighbourhood not found inside config` | The file has no `neighbourhood`, and the node has not been asserted (or its database does not hold the network stream). | Put the full `neighbourhood` in the file. On a node joining an asserted network, restore first: see [Nodes](nodes.md). |
| `Database Not Running - http://127.0.0.1:5259` | `db.autostart` is `false`, so the node expects the store to be running already. | Start the store, or remove `db.autostart`. |
| The display stops at `network` and `Activeledger listening on port` never appears | The node listens only when every worker process has reported ready (one per core, or `cpus`). A worker that crashed or is still starting holds it. | Read the lines above for a worker error. On a small machine set `cpus` lower. |
| Two nodes on one machine both start on the same port, and requests reach either one | The server shares a port rather than refusing it, so a second node on the same port does not fail to start. | Give each node its own `--port`. The store uses `port - 1` and the TCP stream `port + 1`, so leave gaps of at least three. |
| Ctrl+C logs `Shut Down Initiated` and the node is still there | It stops taking requests and exits about 1.3 seconds later; its database and restore engine go with it. | Wait. A second Ctrl+C logs `Shut down forced` and exits at once. |
| `--merge needs two or more configuration files, one per node, e.g. --merge a/config.json --merge b/config.json` | `--merge` was given one file. It exits 1 and changes nothing. | Repeat `--merge` once per node's `config.json`. |
| `Process 12345 did not exit in time` from `activeledger stop` | The node did not exit within the wait (30 seconds). The command exits 1. | Run it again with `--timeout 60`, or check the process. |
| `autostart.restore is false - this node will not run activerestore` | The file turns the repair engine off, usually left over from an old generator. | Set `"autostart": { "restore": true }` unless you run `activerestore` yourself. |
| `All known nodes must been online for assertion` from `--assert` | Every node in `neighbourhood` must be up and recognised before the settings move to the ledger. | Start the missing nodes, check `GET /a/status`, try again. |
| `Network has already been asserted` | The file already has a `network` key. | Nothing; change settings with transactions instead: see [Nodes](nodes.md). |

## Transactions

The reply to a transaction carries `$summary` with `total`, `vote`, `commit` and, when something failed, `errors`.

| What you see | Why | What to do |
|---|---|---|
| `vote` below `total`, `errors` has `Stream Position Incorrect` | One node's copy of a stream is behind. SPI repairs it on this very transaction. | Send the transaction again. If it keeps happening on one node, restore it. |
| `commit` is 0 and the same error from every node | The contract voted no; the text is the contract's own reason. | Fix the transaction. The node log has the full reason when the reply is short. |
| `Contract Version Lock 1.0.1` or `Contract Global Lock` | That version, or the whole contract, is locked and cannot run. | Call another version, or unlock it: see [Deploy, update, lock and unlock](../contracts/deploy.md). |
| `Locking versions on update needs build 40300`, `Hybrid changes need build 40300`, `Hybrid registry not enabled` | The node's `build` is below the level the feature needs. | Raise `build` on every node, after every node is upgraded: see [Nodes](nodes.md). |
| Transactions never commit, nodes are up, no errors | Not enough nodes are reachable to reach `consensus.reached`, or the nodes do not run the same `build`. | Compare `GET /a/status` on each node: every neighbour should be listed. Compare `build` in every `config.json`. |
| `Node already exists` on an `add` transaction | That `host:port` is already in the neighbourhood. | Nothing to do, or use a different port. |
| `Host node signature problem` on `add` or `remove` | Fewer than more than half of the nodes signed it with a valid node key. | Collect more signatures, each named `host:port` exactly as in the neighbourhood. |
| `Hybrid not admitted` on a hybrid's `register` | `hybrid.admission` does not allow that key. | `activeledger hybrid allow <key>`: see [Security](security.md). |

## Restore

| What you see | Why | What to do |
|---|---|---|
| `The node's database cannot be reached. Start the node (or its database with activeledger --db-only) and run the restore again` | A full restore writes to the node's database, and nothing is serving it. It exits 1 without doing anything. | Start the node, or only its database with `activeledger --db-only`, then run `activerestore --full` again. |
| `consensus.reached is not set in the config file, so no revision can be a majority and nothing will be restored` | Restore reads the percentage from `config.json`. On an asserted network it is on the ledger, which an empty node cannot read yet. The run exits 1. | Put `consensus`, the full `neighbourhood` and `network` as `<setup stream id>@<_rev>` into the file for the restore: see [Restoring a node](restore.md). |
| `[Not restored] <stream> at <rev>: no neighbour supplied it after 3 attempts` | The nodes were too busy to answer, or none holds that revision. | Run `activerestore --full` again; it fetches only what is still missing. |
| `Cannot rebuild <contract>@<version>, its file is missing` | The source for that version is not on this node. The rest of the restore carries on. | Let the history pass finish, then run the restore again. If the version is retired, ignore it. |
| `N stream(s) have a chain that could not be completed` after `History Complete` | Some transaction documents are held by too few nodes to adopt. | Harmless for running the node. Run `--history-only` again later. |
| `--skip-history and --history-only together leave nothing to do` | Both flags were given. It exits 1 straight away. | Use one. |

## Hybrids

| What you see | Why | What to do |
|---|---|---|
| `activehybrid status` exits 2, log says `This release (x.y.z) is below the network minimum (a.b.c); not applying items` | The network's `hybrid.minVersion` is above this hybrid's release. It stops applying items and submissions answer `This hybrid is outdated`. | Upgrade the hybrid, or lower the minimum with `activeledger hybrid min-version <semver>`. A hybrid that was outdated from its start needs a restart afterwards. |
| `activehybrid divergences` lists records | The hybrid ran a transaction itself and got a different result from what the supernodes committed, or could not run it. It adopts the network's copy and keeps the record. | Read the record. A contract that behaves differently on a hybrid should fork on `isSupernode()`: see [Writing contracts that also run on hybrids](../contracts/hybrid.md). |
| `401 bad signature or timestamp` from `/h/*` | The request's timestamp is more than 60 seconds from the supernode's clock, or the key is wrong. | Fix the hybrid machine's clock. |
| `403 key is not registered`, `key is retired`, `key is banned on this node` | The hybrid's key is not admitted on that supernode. | `activehybrid register`; or `activeledger hybrid unban <keyhash>` on that supernode. |
| `feed limit reached` | The supernode already serves `hybridMaxFeeds` feeds (32 by default). | Raise `hybridMaxFeeds` on that supernode, or point the hybrid at another. |
