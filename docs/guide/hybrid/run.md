# Set up and run a hybrid

How to prepare the supernodes for hybrids (done once, by whoever runs the
network), then set up, register and start one (done by whoever runs the
hybrid). Read [Hybrid nodes](index.md) first if you do not know what one is.

## Supernode side

### 1. Raise the build to 40300

Hybrids check the supernodes' signed votes and commit attestations, which
supernodes sign from build `40300`. Upgrade every supernode to a release that
supports it, then set `"build": 40300` on all of them in `config.json`. Raise
it only after every supernode is upgraded: nodes on different builds
disagree. See [config.json](../operate/configuration.md) for how `build`
works and [Builds and upgrades](../operate/nodes.md).

A hybrid can only run contracts, and serve `/umid/` records, from
transactions committed after both the assert at build `40300` (step 3) and
the last change to the hybrid rules (step 4). Anything earlier is out of its
reach, and this is a known limit of the current release:

- A contract deployed before the assert never runs on a hybrid, even after an
  update: a version deployed by `update` before the assert, and an update
  made after it, are both refused with
  `Init Contract Error - Contract not found`. Deploy it again as a new
  contract (a new stream, no `$entry: "update"`); see
  [Deploy, update, lock and unlock](../contracts/deploy.md).
- A hybrid started after a later rules change cannot verify records from
  before that change: a transaction through such a contract is refused with
  `Init Contract Error - Namespace not found - ENOENT`, and every earlier
  `/umid/` gives 404 `Umid not found`. A hybrid already running keeps working.

### 2. Check the `hybrid` section

A fresh `config.json` already holds this section, with these values. Change
it if you need to, on the node you will assert from:

```json
"hybrid": {
  "admission": "open",
  "required": [],
  "window": { "days": 30 },
  "minVersion": "5.1.0"
}
```

| Key | Meaning |
|---|---|
| `admission` | Who may register. `"open"` lets any key register. `{ "allowlist": ["<key hash or public key PEM>", ...] }` lets only those keys register. |
| `required` | Streams every hybrid pulls at start, as stream ids (64 hex characters) or `{ "id": "<stream id>" }`. Contracts are always pulled; this is for other streams every hybrid should hold from the first moment. `[]` is fine. |
| `window` | How many days of transaction history a hybrid keeps. `days` is a whole number, at least 1. |
| `minVersion` | The oldest `activehybrid` release allowed to follow this network, such as `"5.1.0"`. A hybrid below it stops applying transactions. Raise it only when a release changes how contracts run. |

All four keys are required and no other key is allowed; a typo is refused
rather than silently becoming the network's rule.

### 3. Assert it on the ledger

The section lives in the network's setup stream, so every supernode enforces
the same rule. Assert the config as you did when you built the network (see
[Run a first node, then a small network](../first-network.md) for a network
of more than one node):

```bash
activeledger --assert
```

From then on the ledger's copy is the one that counts; the `hybrid` section
in the local file is ignored. Then restart every supernode, so each loads the
asserted setup. Until you do, a hybrid cannot bootstrap (its log says `no
setup stream in the bootstrap`) and `activehybrid pin` prints the wrong hash,
so a pin taken before the restart fails later with
`setup neighbourhood hash ... does not match the pin`.

### 4. Change it later with `activeledger hybrid`

Once asserted, change the section with the `hybrid` subcommands rather than
by editing and asserting again:

```bash
activeledger hybrid admission allowlist
activeledger hybrid allow <key hash, public key PEM, or a file holding one>
activeledger hybrid deny <key hash, public key PEM, or a file holding one>
activeledger hybrid admission open
activeledger hybrid min-version 5.1.1
```

Each is a setup transaction that more than half of the supernodes must sign.
On a network of one node the command signs, sends and prints `applied to the
ledger`. On a larger network write it to a file with `--out`, sign it on the
other nodes, then submit it from any node. To move to an allowlist:

```bash
activeledger hybrid admission allowlist --out change.json   # on the first node
activeledger hybrid sign change.json                        # on each other node, same file
activeledger hybrid submit change.json                      # on any node
```

The first node prints `wrote change.json: have the other nodes run 'hybrid
sign change.json', then 'hybrid submit change.json'`; each `sign` prints the
signers so far (`signed by 127.0.0.1:5510, 127.0.0.1:5520`) and `submit`
prints `applied to the ledger`. Add each hybrid's key the same way:

```bash
activeledger hybrid allow 386aaf8b... --out change.json
```

Order matters: `allow` on an open network is refused, as there is no
allowlist to add to. The reply only says `not applied: Failed Commit
Transaction`; the node's log has the reason, `Admission is open, there is no
allowlist to allow`. Run `admission allowlist` first.
On a network of more than one node, leaving out `--out` sends a change signed
by this node alone. The reply starts
`not applied: Vote Failure - "Host node signature problem"`, repeated once
per node joined with `; `, and ends ` - Error <umid>:<time>`; exit code 1.

`deny` only stops new registrations. To cut off a hybrid that is already
registered, see bans in [Operating hybrids](operate.md).

### 5. Optional supernode settings

Local to each supernode, not on the ledger: `"hybridMaxFeeds": 32` in its
`config.json` (or `--hybrid-max-feeds <n>`) is the most hybrids it serves at
once; `--hybrid-listen <port>` opens a P2P listener for hybrids beside HTTP.

## Hybrid side

### 1. Install

Install it, then check the version (it prints `v5.1.1`, for example):

```bash
npm install -g @activeledger/activehybrid
activehybrid version
```

### 2. Create the identity and config

In an empty directory, name a supernode to follow. The port is the
supernode's `host` port from its `config.json`, `5260` by default:

```bash
activehybrid init --upstream supernode.example.com:5260
```

```
Wrote ./hybrid.json and ./.identity
key 386aaf8bdac2680176d88d80152ba4327466ec689c93f80f66cbc6f9d3434358
```

The `key` line is your hybrid's key hash; on an allowlisted network, give it
to whoever runs the network so they can `activeledger hybrid allow` it.
`.identity` holds the private key, readable by you only. Keep it: a new
identity is a new hybrid. `--upstream` can be repeated, and `host:port:p2p`
uses the supernode's P2P listener instead of HTTP. `hybrid.json` now looks
like this:

```json
{
  "upstreams": [
    { "host": "supernode.example.com", "port": 5260, "transport": "http" }
  ],
  "peers": [],
  "bind": "127.0.0.1",
  "port": 5270,
  "window": { "days": 30 },
  "maxLagSeconds": null,
  "refuseOnboard": true
}
```

| Key | Meaning |
|---|---|
| `upstreams` | The supernodes to follow. Each has `host`, `port`, `transport` (`"http"` or `"p2p"`) and optionally `"tls": true` to use HTTPS. |
| `peers` | Other hybrids. Leave empty; see [Operating hybrids](operate.md). |
| `bind`, `port` | Where the hybrid's own API listens. `127.0.0.1:5270` by default, so only this machine can reach it. |
| `token` | A bearer token every API request must carry as `Authorization: Bearer <token>`. Make one with `activehybrid token` and set it before you change `bind`; see [Operating hybrids](operate.md) for TLS. |
| `window` | Days of history to keep. |
| `maxLagSeconds` | When set, `/health` answers 503 beyond this many seconds behind the supernodes, so a load balancer can take the hybrid out. `null` means lag never changes the status code. |
| `refuseOnboard` | Refuse `default/onboard` transactions. `true` by default. |
| `events` | Pin the event stream to certain contracts or payload fields: `{ "contracts": ["<contract id>"], "where": { "<field>": "<value>" } }`. |
| `submit` | Accept transactions for these contracts only: `{ "contracts": ["<contract id>"] }`. |
| `pin` | `{ "neighbourhoodSha256": "<hash>" }`, see step 4. |

Most keys can also be given as flags, for example `--window-days 7` or
`--max-lag-seconds 60`. A flag overrides the file. Check the file at any time
with `activehybrid check-config`, which prints `./hybrid.json is valid`.

### 3. Register

Register your key on the ledger through the supernode, with a label and the
address where your hybrid can be reached, which other operators can see:

```bash
activehybrid register --label "reporting node" --endpoint http://hybrid.example.com:5270
```

```
registered 386aaf8bdac2680176d88d80152ba4327466ec689c93f80f66cbc6f9d3434358
```

Running it again prints `already registered (...)` and exits 0. On an
allowlisted network a key not on the list is refused: ask for your key hash
to be allowed, then register again. `register` talks to an `http` upstream;
if your only upstream is `p2p`, add an `http` one for this step.

### 4. Pin the network (recommended)

The supernode tells the hybrid which node keys to trust. To be sure you are
following the network you mean to, print the hash of its setup and check it
against a node you trust, out of band. Once the pin is set, the hybrid
refuses any upstream whose setup does not match.

```bash
activehybrid pin
```

```
<64 hex characters>
Check this against a node you trust, then set "pin": {"neighbourhoodSha256": "<hash>"} in the config.
```

### 5. Start

```bash
activehybrid start
```

The node detaches and runs in the background; its log goes to
`./activehybrid.log` and its process id to `./.activehybrid.pid`. On a
terminal you see progress lines while it starts (`catching up`, with the lag
left) and the command returns once the node is ready, but it may not print a
final `ready` line; when the output is piped it prints one `ok` line per
step, ending `ok  ready`. Use `activehybrid status` (step 6) to see when it
is ready. To stay attached instead, for a service manager or to watch the
log, run `activehybrid start --foreground`: this shows all six steps,
`config`, `identity`, `store`, `bootstrap`, `catching up` and `ready`.
If every upstream refuses the hybrid, start-up stops at `bootstrap` with
`Every upstream refused this key. Is it registered? Run "activehybrid register".`

### 6. Check it

```bash
activehybrid status
```

```
ready  lag 0s  cursor umid:1761650000000,ab12...
```

Exit code 0 means ready. Exit code 2 means not ready, not running, or lagging
beyond `--max-lag <seconds>` if you pass it. The same answer is on the API:

```bash
curl -s http://127.0.0.1:5270/health
```

```json
{"ready":true,"version":"5.1.1","minVersion":"5.1.0","lagSeconds":0,"cursor":"umid:...","upstreams":[{"host":"supernode.example.com:5260","ok":true}]}
```

`ok` is true only for the upstream the feed is on; the others show false until
the hybrid switches to them. Stop or restart with `activehybrid stop` and
`activehybrid restart`.

## What is in the directory

| File or folder | What it is |
|---|---|
| `hybrid.json` | The config |
| `.identity` | The private key. Back it up; never share it. |
| `data/` | The embedded database |
| `contracts/`, `default_contracts/` | Contract code rebuilt from the ledger |
| `activehybrid.log` | The log of a detached node |
| `.activehybrid.pid`, `.activehybrid.state` | Process id and start-up state of a detached node |

Every command takes `--config <file>`, `--identity <file>` and
`--data-dir <dir>` if you keep these elsewhere. `activehybrid --help` lists
every command and flag; see also [The activehybrid command](../cli/activehybrid.md).
