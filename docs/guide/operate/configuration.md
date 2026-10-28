# Configuration

`config.json` is the file a node reads when it starts. This page lists the keys you need to set, what each does, and what it defaults to.

The node reads `./config.json` from the folder it is started in (or the file given with `--config <file>`). If there is no file, the first start writes one from the defaults below and adds the node's own identity to `neighbourhood`. Any key can also be passed as a flag (`--debug`, `--port 5270`); a value in the file wins over a flag.

## The keys you set

| Key | What it does | Default |
|---|---|---|
| `host` | The address and port the node listens on, as one string `ip:port`. | `"127.0.0.1:5260"` |
| `db` | Where the node keeps its data. See [Storage](#storage). | embedded store on port 5259 |
| `neighbourhood` | The list of every node in the network, including this one. See [Neighbourhood](#neighbourhood). | this node only |
| `consensus.reached` | The percentage of nodes that must vote yes before a transaction is committed. See [Nodes](nodes.md). | `60` |
| `security` | Switches that change how transactions are checked. See [Security](#security). | all off |
| `build` | The protocol level the node runs at. Raise it only after every node is upgraded. See [Nodes](nodes.md). | `40200` for a new node |
| `hybrid` | Rules for hybrid nodes that follow this network. See [Hybrid](#hybrid). | open admission |
| `restore` | How gently a full restore treats the network. See [Restore](#restore). | not written; throttled, with history |
| `autostart.restore` | Start the restore engine (`activerestore`) beside the node. It repairs streams the node missed. Leave it `true`. | `true` |
| `debug` | Debug logging, and full contract errors returned to the client. | `false` |
| `remote` | Allow `GET /a/admin-reload` to reload this file without a restart. Only this host or a neighbour may call it. | `false` |
| `p2pStream` | Send consensus traffic to neighbours over a TCP connection instead of HTTP. | `true` |
| `p2pStreamServer` | Accept that TCP traffic. It listens on `port + 1` (5261 by default). | `true` |
| `configVersion` | Marks a file written by a current release. Set to `1` on a file you have checked. | `1` |

A node with a `hybrid` section needs `"build": 40300` for it to take effect.

## Storage

`db` holds the store the node writes to. Every node in a network must use the same kind of store: the embedded one, or CouchDB.

| Key | What it does | Default |
|---|---|---|
| `db.selfhost` | Present: run the embedded store. Absent: use the CouchDB at `db.url`. | present |
| `db.selfhost.host` | Address the store binds to. Keep it on loopback; the store has no login. | `"127.0.0.1"` |
| `db.selfhost.port` | Port of the embedded store. A node made with `--port` uses `port - 1`. | `"5259"` |
| `db.selfhost.engine` | Storage driver. | `"level"` |
| `db.selfhost.dir` | Folder the data lives in. Written only when the node was set up with `--data-dir`. | not written; `./.ds` |
| `db.autostart` | `false` means you run the store as a separate process; the node checks it is up and refuses to start if not. | started by the node |
| `db.url` | CouchDB address with credentials, used when there is no `selfhost`. With `selfhost` the node fills it in itself. | placeholder |
| `db.database` | Name of the ledger database. | `"activeledger"` |
| `db.event` | Name of the events database. | `"activeledgerevents"` |
| `db.error` | Name of the error database the restore engine reads. | `"activeledgererrors"` |

## Neighbourhood

One entry per node. Every node's file must list the same nodes, with the same keys, or the nodes will not recognise each other.

```json
{
  "identity": { "type": "rsa", "public": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----" },
  "host": "10.0.0.11",
  "port": 5260
}
```

`port` is a number when the node was set up with `--port`; a node set up without it writes `"5260"`. `identity.public` is the node's public key. Print it on that node with `activeledger --public`. The entry's `host` is also the only address that node is allowed to connect from: see [Security](security.md).

## Security

All of these are off unless you turn them on.

| Key | What it does | Default |
|---|---|---|
| `security.signedConsensus` | Nodes sign every message they send each other. | `false` |
| `security.encryptedConsensus` | Nodes encrypt those messages. With either of these on, consensus goes over HTTP, not the TCP stream. | `false` |
| `security.hardenedKeys` | Every transaction must give a new public key (`$nhpk`) for the identities it uses, so a key is used once. | `false` |
| `security.signedOutputs` | Output streams must be signed too, not only inputs. | `false` |
| `security.contractIsolation` | `"inprocess"` runs contracts in the node's own process (for a network where only trusted people deploy). `"isolate"` refuses to run a contract unless an isolation backend is registered. | `"inprocess"` |
| `security.maxRequestBytes` | The largest request body the node accepts. | `16777216` (16 MB) |
| `security.deploy.allowlist` | List of identity stream ids. When set, only those identities may claim a namespace or deploy a contract. | not set |
| `security.deploy.enforceContractOwnership` | Only the identity that deployed a contract may update it. | `false` |

## Hybrid

The rules every supernode applies to hybrid nodes. Unknown keys are refused, so a typo cannot become a rule.

| Key | What it does | Default |
|---|---|---|
| `hybrid.admission` | `"open"`, or `{ "allowlist": [...] }` holding public keys or key hashes that may register. | `"open"` |
| `hybrid.required` | Stream ids every hybrid must hold. | `[]` |
| `hybrid.window.days` | How many days of history a hybrid keeps. A whole number, 1 or more. | `30` |
| `hybrid.minVersion` | The oldest hybrid release allowed to follow the network. | `"5.1.0"` |

Once the network is asserted the rules live on the ledger and are changed with `activeledger hybrid ...`: see [Operating hybrids](../hybrid/operate.md).

`hybridMaxFeeds` (default `32`) is separate and local: the most hybrid feeds this one supernode serves at once.

## Restore

Read by `activerestore --full`. A generated file has no `restore` section, and each value is optional: whatever is left out keeps its default.

| Key | What it does | Default |
|---|---|---|
| `restore.throttle` | `false` turns the throttle off. Or an object with the values below. | on |
| `restore.throttle.pauseMs` | Pause before each stream is fetched. | `5` |
| `restore.throttle.batch` | Streams per batch. | `100` |
| `restore.throttle.batchPauseMs` | Extra pause after each batch. | `200` |
| `restore.throttle.slowMs` | A fetch slower than this doubles the back-off. | `400` |
| `restore.throttle.maxBackoffMs` | The most back-off added to each pause. | `5000` |
| `restore.history` | `false` skips the history pass. Or an object with `minAgree`, `walkLimit` (default `1000000`), `hopDelayMs` (default `50`). | on |

See [Restoring a node](restore.md) for what these mean in practice.

## Less common keys

| Key | What it does | Default |
|---|---|---|
| `cpus` | How many worker processes run contracts. | the machine's physical cores |
| `max_memory` | Memory limit of each worker, in MB. | `1500` |
| `contractMaxTimeout` | The longest a contract may run, in minutes. | `20` |
| `contractCheckTimeout` | How often a running contract is checked against its timeout, in ms. | `10000` |
| `winston` | Also write logs to rotating files under `./winstonlogs/`. | `false` |

The generated file also carries `CORS` and `experimental`. Nothing reads them; the node always allows cross-origin requests.

## After the network is asserted

`activeledger --assert` moves `neighbourhood`, `consensus`, `security` and (at build 40300 or later) `hybrid` on to the ledger. Every node rewrites its `config.json` without them, saves the old file as `config.json.bak`, and adds two keys:

| Key | What it does |
|---|---|
| `network` | The id of the ledger stream that now holds the network's settings, as `"<id>@assertion"`. Written by the node; do not edit it. |
| `__base` | The folder the `activeledger` package runs from. Written by the node; do not edit it. |

From then on the node reads those four sections from the ledger at start-up. A change to them is a transaction, not an edit to the file: see [Nodes](nodes.md).

## An annotated example

Three nodes, embedded storage. This is what each node's file looks like before assert; only `host` and the file's own path differ between nodes.

```json
{
  "configVersion": 1,
  "host": "10.0.0.11:5260",
  "build": 40300,
  "debug": false,
  "remote": false,
  "p2pStream": true,
  "p2pStreamServer": true,
  "db": {
    "selfhost": { "host": "127.0.0.1", "port": "5259", "engine": "level" },
    "database": "activeledger",
    "event": "activeledgerevents",
    "error": "activeledgererrors"
  },
  "consensus": { "reached": 60 },
  "security": {
    "signedConsensus": false,
    "encryptedConsensus": false,
    "hardenedKeys": false,
    "contractIsolation": "inprocess"
  },
  "hybrid": { "admission": "open", "required": [], "window": { "days": 30 }, "minVersion": "5.1.0" },
  "autostart": { "restore": true },
  "neighbourhood": [
    { "identity": { "type": "rsa", "public": "-----BEGIN PUBLIC KEY-----\n...node 1...\n-----END PUBLIC KEY-----" }, "host": "10.0.0.11", "port": 5260 },
    { "identity": { "type": "rsa", "public": "-----BEGIN PUBLIC KEY-----\n...node 2...\n-----END PUBLIC KEY-----" }, "host": "10.0.0.12", "port": 5260 },
    { "identity": { "type": "rsa", "public": "-----BEGIN PUBLIC KEY-----\n...node 3...\n-----END PUBLIC KEY-----" }, "host": "10.0.0.13", "port": 5260 }
  ]
}
```

Check a file before starting the node:

```
activeledger check-config
```

You should see `./config.json is valid`. It exits 2 with the reason when the file is missing, is not JSON, or has no `host` or `db`.
