# Configuration reference

This reflects the actual current default config (`packages/activeledger/src/default.config.json`) and how each field is consumed in code, checked against `v4.1.0`. It supersedes [`docs/en-gb/configuration.md`](../docs/en-gb/configuration.md), which documents an older field set (missing `remote`, `build`, `hybrid`, `experimental`, `api`, `engine`, and both P2P flags entirely).

`config.json` is generated on first run (or via `--setup-only`, see [cli.md](cli.md)) in the node's working directory. It's read by the main `activeledger` process; `core` and `restore` read the same file when run separately. One precedence detail worth knowing before you go looking for why a CLI flag "isn't working": `config.json` wins over a same-named CLI flag, not the other way round — see [options.md](options.md#activeoptions-config-precedence-is-not-what-youd-guess) for why.

```json
{
  "debug": true,
  "remote": false,
  "build": 40000,
  "security": {
    "signedConsensus": false,
    "encryptedConsensus": false,
    "hardenedKeys": false
  },
  "host": "127.0.0.1:5260",
  "db": {
    "selfhost": {
      "host": "127.0.0.1",
      "port": "5259",
      "engine": "level"
    },
    "url": "http://[user]:[pass]@[host]:[port]",
    "database": "activeledger",
    "event": "activeledgerevents",
    "error": "activeledgererrors"
  },
  "consensus": {
    "reached": 60
  },
  "autostart": {
    "core": false,
    "restore": true
  },
  "hybrid": [],
  "experimental": {},
  "api": {
    "port": 5261
  },
  "rate": {
    "minutes": 10,
    "limit": 20,
    "delay": 0
  },
  "CORS": ["*"],
  "neighbourhood": [],
  "p2pStream": false,
  "p2pStreamServer": false
}
```

## `debug`

Verbose console logging, plus more detailed error information in transaction responses. Turn this off in production if you don't want internal contract error detail exposed to clients — with it off, failures during vote/commit return a generic fault message instead.

## `remote`

Gates the `/a/admin-reload` HTTP endpoint (`network/host.ts`) — hot-reloading `config.json` and rebroadcasting it to this node's own child processes without a restart. Defaults `false` (disabled) for a reason: think of this as a remote-administration surface, not a routine setting.

## `build`

A staged-rollout compatibility flag (`protocol/vm.ts`), not a version string. Newer stream-auditing fields (`removedAuthorities`, per-authority `umid`) are only surfaced once `build >= 40000` — below that, they're stripped before a contract sees the stream, so a node running an older config can keep processing transactions without hitting an unrecognised schema. The current default config already sets this to `40000`, so a fresh node gets the new fields; you'd only ever lower it deliberately, to keep a node compatible with older peers during a rollout.

## `security`

Extra verification, each with a real transaction-processing cost — enable only what your network's threat model actually needs.

- **`signedConsensus`** — a receiving node can verify consensus data really came from the node it claims to (inbound confirmation).
- **`encryptedConsensus`** — takes that further: the sending node encrypts data before sending (outbound confirmation, not just inbound).
- **`hardenedKeys`** — every `$i` entry must include `$nhpk` (a fresh public key, matching the current identity's key type), enforcing exactly one signature per valid transaction.

All three default `false`.

## `host`

This node's own external address and port — what it tells peers to reach it on, and what it binds its main HTTP/consensus listener to.

## `db`

Both an embedded engine and an external option exist; every node in a network currently needs to use the same one (mixing is on the roadmap, not implemented).

- **`selfhost`** — presence of this object starts the embedded engine. `host`/`port` is where it listens (`127.0.0.1` recommended — this is an internal port, not meant to be exposed). `engine` is currently **informational only**: it's logged and passed as an argument to the storage subprocess, but nothing branches on its value — the driver is always LevelDB via `classic-level` as of `v4.1.0`. See [storage.md](storage.md) for the full story of why, including a real bug this field had until recently (it said `"rocks"` even though RocksDB was never actually wired up).
- **`url`** — an external CouchDB instance instead, credentials embeddable in the URL.
- **`database`** / **`event`** / **`error`** — the three logical stores: main stream state, contract-raised events, and transaction errors (kept on the ledger to help diagnose bad data).

## `consensus.reached`

Percentage of the network that must agree during the vote phase for a transaction to be considered valid. See [architecture.md](architecture.md) for how votes actually propagate (gossip, not a leader tally).

## `autostart`

Whether `core` and `restore` launch automatically alongside the main process. **`core` defaults to `false`** — see [core.md](core.md) for why (it's being considered redundant in favour of the storage engine's own direct API). `restore` still defaults to `true`. Either gets silently forced to `false` by the CLI whenever you pass a `--port` other than the default `5260` (see [cli.md](cli.md)) — the reasoning is that a non-default-port instance is assumed to be one of several on the same host, and `core`/`restore` have their own fixed ports (`api.port`) that would collide across instances.

If you do re-enable `autostart.core` explicitly, there's a P2P interaction worth knowing before you hit it: a node left on the *literal* default port with `core` turned back on has `core`'s port (`api.port`, default `5261`) colliding with the P2P server's port (`host` port + 1) the instant you also turn `p2pStreamServer` on. See the P2P section of [transport.md](transport.md).

## `hybrid`

Reserved for the `activehybrid` package's bundled core+restore-with-a-node deployment mode. Empty array by default.

## `experimental`

Reserved, currently unused anywhere in the codebase (no code reads this field as of `v4.1.0`). Safe to leave as `{}`.

## `api.port`

The port `core`'s REST API binds to when auto-started. Default `5261` — one above the default `host` port, which is also why it collides with the default P2P port (see above).

## `rate`

Request rate limiting for `core`'s API: `limit` requests per `minutes` window, with an optional `delay` (ms) added per request instead of rejecting outright.

## `CORS`

Allowed origins for direct browser-based transaction submission. `["*"]` in the default config (permissive); restrict this for anything internet-facing.

## `neighbourhood`

The list of node identities permitted to join this permissioned network — each entry is `{ identity: { type, public }, host, port }`. Include your own node's entry. Generated automatically by `--setup-only` and stitched together across nodes by `--merge` (see [cli.md](cli.md)).

## `p2pStream` / `p2pStreamServer`

Both default `false`. See [transport.md](transport.md) for what they do, how they interact, and why HTTP is still the recommendation as of `v4.1.0` — a real 4-node benchmark found no measurable throughput difference, because contract execution and crypto operations dominate the per-transaction cost on the machine this was tested on, not transport.

## Not in the default file, but recognised

- **`contractCheckTimeout`** (ms, default 10000) and **`contractMaxTimeout`** (ms, default 20 minutes from vote-phase start) — smart contract VM timeout tuning. See [architecture.md](architecture.md#the-contract-vm-lifecycle).
- **`proxy`** — if Activeledger sits behind a reverse proxy on a different external port, this tells it which port to report to peers.
