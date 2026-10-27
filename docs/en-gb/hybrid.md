# Activehybrid

A hybrid node follows the ledger from one or more supernodes without taking part in consensus. It does not vote and it does not need CouchDB. It keeps an embedded store, serves its own API, and relays the transactions it is sent to a supernode.

It does **not trust** the supernodes it follows. For every transaction it checks the signed votes against the node keys in the setup stream, checks that enough supernodes signed the commit, and runs the contract itself. If its own result differs from what the supernodes committed it repairs the stream from the network and writes a divergence record, so a faulty or dishonest upstream shows up instead of being copied.

Use a hybrid when you need local, verified reads and a local API for an application (a mobile backend, an analytics node, a partner who may read the ledger) but cannot or should not join the consensus group.

* [Setting up a hybrid](#setting-up-a-hybrid)
* [The supernodes](#the-supernodes)
* [Configuration](#configuration)
* [Commands](#commands)
* [The local API](#the-local-api)
* [Writing contracts for hybrids](#writing-contracts-for-hybrids)
* [Versions](#versions)
* [Limits](#limits)

## Setting up a hybrid

You need build `40300` on the supernodes (see [the supernodes](#the-supernodes)), then on the hybrid's machine:

```bash
activehybrid init --upstream supernode.example.com:5260
activehybrid register --label "reporting node"
activehybrid start
```

* `init` creates the node's identity (`.identity`) and `hybrid.json`. It refuses to overwrite either without `--force`.
* `register` registers the identity's public key on the ledger through the `default/hybrid` contract. It is safe to run again. If the network's admission is an allowlist the key must first have been allowed (`activeledger hybrid allow <key|hash|file>` on the supernodes).
* `start` runs the node. It bootstraps from the upstream (the setup stream, the required streams and every contract), then follows the feed. `/health` reports not ready until that is done.

`activehybrid status` prints the node's state and exits 0 when it is ready and not lagging, 2 otherwise, so it can be used as a health check.

Add `--upstream` more than once, or list several in `hybrid.json`, so the hybrid carries on if one supernode is down.

> The `/h/*` API signs its requests but does **not encrypt** them. When a hybrid connects over a network you do not control, put TLS in front of the supernode (a reverse proxy) and point the hybrid's upstream at it with `"tls": true`.

## The supernodes

Hybrids need build `40300`, which makes every supernode sign its vote and its commit outcome. Upgrade every supernode first, then set `"build": 40300` in each `config.json`. Until then nothing changes in how a supernode votes or commits.

The network's rules for hybrids are in the `hybrid` section of the configuration, which is written into the setup stream when the network is asserted (`--assert`), like `security` and `consensus`, so every supernode enforces the same ones:

```json
{
  "hybrid": {
    "admission": "open",
    "required": ["[stream id]", { "id": "[stream id]", "volatile": true }],
    "window": { "days": 30 },
    "minVersion": "5.1.0"
  }
}
```

| Key | Meaning |
| --- | ------- |
| `admission` | `"open"`: any key may register. `{ "allowlist": ["[public key or key hash]"] }`: only those keys. Any other value admits nobody. Without a `hybrid` section at all, registration is open. |
| `required` | Streams every hybrid downloads, beyond the contracts (which are always required). An entry with `"volatile": true` also shares that stream's volatile data, but only if the contract has called `shareVolatile()` on it. |
| `window` | How many days of transactions a hybrid keeps. |
| `minVersion` | The oldest `activehybrid` release allowed to follow the network. |

With `admission: "open"`, a hybrid replicates **all non-volatile state** on the ledger. Do not run an open network if that is not acceptable.

On a network that is already running, change these with `activeledger hybrid` (below). A change is a `default/setup` transaction that more than half of the nodes must sign: pass `--out <file>` to write the signed request to a file, have each other node run `activeledger hybrid sign <file>`, then any node runs `activeledger hybrid submit <file>`. On a single node it signs and sends in one go.

| Command | Does |
| ------- | ---- |
| `activeledger hybrid list` | The registered hybrids. |
| `activeledger hybrid feeds` | The hybrids connected to this node now. |
| `activeledger hybrid ban <keyhash>` / `unban <keyhash>` | Cut off, or restore, a hybrid on this node. A ban also closes a feed that is already open. |
| `activeledger hybrid allow <key\|hash\|file>` / `deny <key\|hash\|file>` | Add or remove a key on the allowlist. `deny` stops new registrations only; use `ban` for a feed that is open. |
| `activeledger hybrid admission <open\|allowlist>` | Change the admission mode. |
| `activeledger hybrid min-version <semver>` | Change `hybrid.minVersion`. |
| `activeledger hybrid sign <file>` / `submit <file>` | The signing steps described above. |

Other supernode options: `--hybrid-listen <port>` opens the hybrid P2P listener and `--hybrid-max-feeds <n>` limits the feeds served at once (default 32). The old `hybrid: []` list of URLs in `config.json` is no longer read.

## Configuration

`hybrid.json` (change the location with `--config`):

```json
{
  "upstreams": [{ "host": "supernode.example.com", "port": 5260, "transport": "http" }],
  "peers": [],
  "bind": "127.0.0.1",
  "port": 5270,
  "token": "[from activehybrid token]",
  "window": { "days": 30 },
  "maxLagSeconds": null,
  "refuseOnboard": true,
  "events": { "contracts": ["[contract stream]"], "where": { "tenant": "acme" } },
  "submit": { "contracts": ["[contract stream]"] },
  "pin": { "neighbourhoodSha256": "[64 hex characters]" }
}
```

| Key | Meaning |
| --- | ------- |
| `upstreams` | The supernodes to follow: `host`, `port`, `transport` (`"http"` or `"p2p"`, default `"http"`) and `tls`. |
| `peers` | Other hybrids to fetch streams from before asking a supernode. Same shape. |
| `bind`, `port` | Where the local API listens. Default `127.0.0.1:5270`. |
| `token` | A bearer token the API then requires on every route, `/health` included. `activehybrid token` prints a new random one. |
| `window.days` | How much history to keep. Older records are fetched from a supernode on demand. |
| `maxLagSeconds` | `/health` returns 503 when the node is further behind than this. `null` for no limit. |
| `refuseOnboard` | Refuse `default/onboard` transactions on `POST /` (default `true`). |
| `events` | Pins the events API to certain contracts and/or payload fields (see below). |
| `submit.contracts` | If set, `POST /` accepts transactions for these contracts only. |
| `pin.neighbourhoodSha256` | Checks the upstream's setup stream hash at start-up. `activehybrid pin` prints the hash; compare it with the supernodes out of band before putting it here. |

`activehybrid check-config` validates the file and names each key at fault. Most keys have a flag as well (`--upstream host:port[:p2p|http]`, `--peer`, `--token`, `--window-days`, `--max-lag-seconds`, `--refuse-onboard`, `--events-contract`, `--events-where field:value`, `--submit-contract`), and a flag wins over the file.

## Commands

`activehybrid [command] [flags]`. Common flags: `--config`, `--identity`, `--data-dir`, `--host`, `--port`, `--debug`, `--json`, `--quiet`, `--yes`, `--help`, `--version`.

| Command | Does |
| ------- | ---- |
| `init` | Create the identity and `hybrid.json`. |
| `token` | Print a new random bearer token for the config. |
| `check-config` | Validate `hybrid.json`; exit 2 with the reason if wrong. |
| `pin` | Print the hash of the upstream's setup stream. |
| `register [--label x] [--endpoint p2p://host:port]` | Register this key on the ledger. |
| `update --endpoint ...` | Change the endpoints advertised to other hybrids. |
| `retire` | Retire the registration (asks for `--yes`). |
| `peers` | The hybrids registered on the ledger. |
| `start`, `stop`, `restart` | Run, or stop and restart, the node. `start` is the default command. |
| `status` | The node's state. Exit 0 when ready, 2 when not ready or lagging. |
| `divergences [--since <time>]` | The divergence records. |
| `prune [--dry-run]` | Run the pruner now. It also runs every hour. |

`divergences` and `prune` talk to the running node, which accepts them from the same machine only, whatever `bind` and `token` say, because `prune` deletes history.

## The local API

Read endpoints are served from the hybrid's own copy. They can trail the supernodes by the lag `/health` reports: a consumer that cannot accept that (a fee quote, for example) should check `/health` first.

| Endpoint | Returns |
| -------- | ------- |
| `GET /health` | `{ ready, reason, version, minVersion, lagSeconds, cursor, upstreams }`. 503 when not ready (`reason` is `starting` or `outdated`), or when beyond `maxLagSeconds`. `lagSeconds` is the time since the node last confirmed it was at the head, so a quiet ledger does not read as lagging. |
| `GET /stream/:id` | The stream's state and its `:stream` meta, as the supernode console shows them. An unknown stream is fetched and cached. |
| `GET /umid/:umid` | The transaction record. |
| `GET /events` | Server-sent events. Resumes from `Last-Event-ID`. Filter with `?contract=<id>` (repeatable) and `?where=field:value`. |
| `POST /` | Submit a transaction (below). |

**Events.** A local commit emits the contract's own events plus `tx.committed`, `tx.failed` and `divergence`. A filter pinned in `events` applies to every client, who may narrow it but never widen it. An event without a pinned `where` field is not served, and with a `where` pinned only contract events are served. The filter keeps one tenant's feed free of another's activity; it is not confidentiality. The hybrid stores everything it replicates and `GET /stream/:id` is not filtered.

**Submitting a transaction.** `POST /` checks the transaction, brings the streams it uses to their current revision, and runs the vote locally with no writes. If the vote is no, the contract's error is returned and nothing is sent on. Otherwise it signs the transaction over to a supernode (`$relay`) and returns the supernode's answer unchanged.

* The transaction must set `$tx.$expire`. Without it the `$umid` would depend on the supernode's clock and a resend could not be recognised.
* Contract deploys, namespace claims, and `default/setup`, `default/fund` and (while `refuseOnboard`) `default/onboard` transactions are refused, as are contracts not in `submit.contracts`. Supernodes enforce their own rules whatever the hybrid allows.
* An answer the hybrid made itself carries `$hybrid`: `refused` (the local vote was no), `denied` (not allowed through a hybrid), `unavailable` (no supernode reachable) or `unanswered` (forwarded, but no answer in time; the body has the `$umid`). An answer with no `$hybrid` field came from a supernode.
* A transaction pinned to a locked contract version (`<id>@=<version>`) is refused by the hybrid's own vote, as a `refused` answer with the supernodes' reason, and a lock or unlock is followed by the hybrid like any other change to the contract stream.
* The hybrid never resends. After `unanswered`, look the `$umid` up before sending again. A resend is safe either way: before `$expire` it is a duplicate, and after it the ledger rejects it.

## Writing contracts for hybrids

Every contract feature works on a hybrid. A hybrid runs the contract itself to check what the supernodes committed, so anything that only a supernode can do has to be marked.

* `this.isSupernode()` is `true` on a supernode and `false` on a hybrid. Wrap what only a supernode can do (calls to external services, signing with a key held there, volatile writes) in it. Calling it marks the execution as supernode-dependent: when the hybrid's result differs, it adopts the attested outputs after checking them, instead of reporting a divergence.
* In the `else` branch, say what the supernode branch writes with `adoptFromSupernode`:

  ```ts
  if (this.isSupernode()) {
    const sig = await signWithCvm(tx);
    wallet.setState({ ...state, signature: sig, status: "signed" });
  } else {
    wallet.adoptFromSupernode({ signature: "string", status: "string" });
  }
  ```

  The description maps property names to `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"` or `"any"`. Suffix a type with `?` (`"string?"`) when the supernode may leave the property out. Everything not described must come out identical on the hybrid, so a faulty upstream cannot slip other changes in.
  * `adoptFromSupernode(shape, { atomic: true })` also requires the described properties to be all changed or all unchanged.
  * When supernode-only work decides **which** streams change, call `this.adoptStreamsFromSupernode([ids], shape)` with the candidate streams. Each may come back unchanged or changed within the shape, and the ids must be among the transaction's `$i` or `$o`.
  * If the supernode branch creates a stream, create the same stream in the `else` branch with placeholder values and describe its properties.
  * A supernode-dependent contract with no description is adopted whole and the hybrid emits an `adopt.undeclared` event naming the contract and entry. Treat it as a prompt to add one.
* Time: a contract sees the transaction's consensus time (`cDate`), never the node's clock, so a contract that takes its time only from there behaves the same on a hybrid and on a supernode.
* Volatile data is per node. It is only readable through a hybrid when the stream is in the network's `required` list with `volatile: true` **and** the contract called `shareVolatile()`. Contracts that keep secrets in volatile (key shares, for example) never call it.

## Versions

A hybrid runs contracts with its own copy of the engine, so one older than the supernodes' could execute a contract differently. The network's `hybrid.minVersion` prevents false divergences: below it the hybrid becomes **outdated**. It stops applying the feed and stops relaying, `/health` returns 503 with `reason: "outdated"`, and `activehybrid status` exits 2. Reads still work from the local copy, and `POST /` answers `unavailable` so a client falls back to a supernode. Upgrade `activehybrid` and it resumes from where it stopped. A hybrid that **started** outdated never pulled its streams, so it needs a restart after the upgrade. Lowering `minVersion` on the network reaches a running outdated hybrid by itself. A hybrid newer than the supernodes is fine.

## Limits

* A hybrid keeps only the current revision of each stream. A feed item whose streams have already moved on is marked superseded rather than run again.
* The feed is ordered by the time a transaction entered the network. A slow transaction that commits after one stamped later than it is not sent to a hybrid that has read past that point; its streams still arrive with the next change to them.
* A feed item with no commit attestation (written by restore, or committed before build `40300`) holds the feed for two minutes and is then skipped.
* An item the hybrid cannot verify, or one it records a divergence for, is logged and skipped. An item dropped for want of something it may find later (a stream, a peer's attestation, a failed write) is tried again every 30 seconds, up to five attempts, with at most 200 held at once.
* Hybrid P2P (`p2p` transport, the registry's endpoints and the mesh between hybrids) is available but has not been tried on a live network, and the P2P feed has no flow control. Use `http` upstreams for now.
