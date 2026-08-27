# CLI reference and running a local testnet

Checked against `packages/activeledger/src/index.ts` and `packages/activeledger/src/cli/cli.ts` at `v4.1.0`. Supersedes [`docs/en-gb/ledger.md`](../docs/en-gb/ledger.md)'s CLI list, which is still mostly accurate but predates the port-collision gotcha below and the P2P flags.

## Top-level commands

`activeledger` with no arguments boots a node using `./config.json` (created from the default template on first run). These flags instead run a one-off command and exit:

| Flag | Does |
|---|---|
| `--version` / `-v` | Print the version and exit. Doesn't need an identity file. |
| `--testnet [n]` | Generate a local multi-node testnet (default 3 nodes). See below — the actual working procedure differs from what you'd guess from this flag alone. |
| `--merge <path> ...` | Combine each given `config.json`'s single-entry `neighbourhood` into one list, and write that combined list back into every file passed. This is how a testnet's nodes learn about each other. |
| `--stop` | Stop a running node (reads the PID file). In practice this can take a while or hang under load — if it doesn't return promptly, killing the process directly by PID is a reasonable fallback. |
| `--restart [--auto]` | Restart a running node. `--auto` restarts in a mode that also resumes previously-running child services. |
| `--stats` | Print node stats. |
| `--backup [path]` | Back up the embedded data store to a file (defaults to a timestamped `.alb` file if no path given). |
| `--restore <path>` | Restore from a backup file. |
| `--assert [contract stream id]` / `--assert-network [contract stream id]` | Move a running network from file-based to ledger-based configuration — see [`docs/en-gb/dynamic-nodes.md`](../docs/en-gb/dynamic-nodes.md), still accurate. Optionally lock the new config stream to an additional already-deployed contract. |
| `--sign <file>` | Sign a file (or, if it's a transaction, just its `$tx` contents) with this node's identity. Used for the node-add/remove and namespace request/revoke flows. |

## Flags for a single node's setup

| Flag | Does |
|---|---|
| `--config <path>` | Config file location. Default `./config.json`. |
| `--port <number>` | Binding port. Default `5260`. **See the gotcha below** — this isn't just a bind address, it changes other config behaviour too. |
| `--host <ip>` | Binding address. Default `127.0.0.1`. |
| `--identity <path>` | Identity file location. Default `./.identity`. |
| `--data-dir <path>` | Embedded data store location. Default `./.ds/`. |
| `--db-only` | Start only the embedded storage engine, nothing else. |
| `--setup-only` | Write configuration and exit without starting the node — this is what generates a fresh `config.json` and identity without booting. |

### The `--port` gotcha

Passing any `--port` other than the literal default `5260` has a second effect beyond changing the bind address: `cli.ts`'s `checkConfig()` also derives `db.selfhost.port` as `port - 1`, and — this is the part worth knowing before you hit it — **forces `autostart.core` and `autostart.restore` to `false`**. The reasoning is that a non-default-port node is assumed to be one of several sharing a host, and `core`/`restore` bind their own fixed ports (`api.port`) that would collide across instances.

The flip side: a node left on the exact default port (`5260`) keeps `autostart.core`/`autostart.restore` **on**, with `core` binding `api.port` (default `5261`). That's fine on its own — until you also enable the P2P transport (see [transport.md](transport.md)), whose server binds `main port + 1`, which for a default-port node is *also* `5261`. Enabling `p2pStreamServer` on a default-port node with `core` still auto-starting will crash it with a port collision. **If you're running more than one node on the same host and plan to test P2P, keep every instance off the literal default port** — this was found the hard way while setting up a local benchmark for this doc set.

## Running a local multi-node testnet (bare host, not Docker)

`--testnet [n]` exists but is really a template for what to do manually — for anything beyond a quick smoke test, doing it by hand gives you more control and avoids the port gotcha above entirely. This is the exact procedure used to run a real 4-node benchmark for [transport.md](transport.md):

```bash
# One directory per node, each on its own port - none of them on the
# literal default (5260), for the reason explained above.
for i in 0 1 2 3; do
  mkdir instance-$i
  port=$((5310 + i * 10))   # 5310, 5320, 5330, 5340
  (cd instance-$i && activeledger --port $port --data-dir .ds --setup-only)
done

# Stitch every instance's neighbourhood together
activeledger \
  --merge "./instance-0/config.json" \
  --merge "./instance-1/config.json" \
  --merge "./instance-2/config.json" \
  --merge "./instance-3/config.json"

# Start them all
for i in 0 1 2 3; do
  (cd instance-$i && activeledger &)
done
```

Each node's `db.selfhost.port` (main port `- 1`) and, if you enable P2P, its P2P port (main port `+ 1`) fall in the gap between one instance's port range and the next, so nothing collides as long as you keep the per-instance spacing at 10 or more.

Check a node came up cleanly with `curl http://127.0.0.1:<port>/a/status` — `"status":4` means it's healthy and has a view of its ring neighbours (`left`/`right` in the response).

To submit a transaction, POST JSON to the node's root (`http://127.0.0.1:<port>/`) — see [transactions.md](transactions.md) for the exact request/response shape, verified against a real run of this same setup.
