# Operating hybrids

What a running hybrid tells you, what it serves, and what to do when it falls
behind or disagrees with the network. For setting one up see
[Set up and run a hybrid](run.md).

## States

A hybrid is in one of these states. `activehybrid status` and `GET /health`
both report it.

| State | `/health` | `status` prints | Meaning |
|---|---|---|---|
| starting | 503, `"reason": "starting"` | `not ready: starting` | Bootstrapping or catching up. Reads work from what it holds; `POST /` answers `unavailable`. |
| ready | 200 | `ready  lag <n>s  cursor <c>` | Following the supernodes. |
| lagging | 200, or 503 when `maxLagSeconds` is set and passed | `ready ... (lagging)` with `--max-lag` | Ready, but behind the supernodes by more than you allow. |
| outdated | 503, `"reason": "outdated"` | `not ready: outdated` | The hybrid's release is below the network's `hybrid.minVersion`. It stops applying transactions until upgraded. |
| not running | no answer | `not ready: not running` | No node on the configured `bind:port`. |

`status` exits 0 only when ready and within `--max-lag`; otherwise 2. That
makes it usable from a health check script.

`lagSeconds` in `/health` is the time since the hybrid last confirmed it was
at the supernodes' head. A quiet ledger does not read as lagging; a hybrid
that cannot reach its supernodes does.

"Diverged" is not a state. A divergence is a record of one transaction where
the hybrid's result differed from the network's. The hybrid repairs itself
and carries on; see [When it diverges](#when-it-diverges).

## The API it serves

On `bind:port` (`127.0.0.1:5270` by default). When `token` is set in
`hybrid.json`, every request needs `Authorization: Bearer <token>` or gets
401.

| Endpoint | What it does |
|---|---|
| `GET /health` | State, version, `minVersion`, `lagSeconds`, `cursor`, and each upstream with `ok`: true for the upstream the feed is on, false for the others until the hybrid switches to them. |
| `GET /stream/:id` | A stream's state and its `:stream` meta, from the local copy. A stream the hybrid does not hold yet is fetched from a supernode first. 404 if nobody has it. Volatile is never served. |
| `GET /umid/:umid` | A transaction record. One the hybrid has pruned is fetched from a supernode and checked against the supernodes' signed attestation before it is served. |
| `GET /events` | A live event stream (server-sent events). Send `Last-Event-ID` to get everything you missed first. Filter with `?contract=<id>` (repeatable) and `?where=<field>:<value>`. |
| `POST /` | Submit a transaction. The hybrid votes locally, then forwards it to a supernode and returns the supernode's answer unchanged. |

An answer the hybrid made itself, rather than passed through from a
supernode, carries a `$hybrid` field so your code can tell:

| `$hybrid` | Status | Meaning |
|---|---|---|
| `denied` | 403 | Refused before anything ran: a deploy, namespace, setup or fund transaction, an onboard while `refuseOnboard` is true, no `$tx.$expire`, or a contract not in `submit.contracts`. |
| `refused` | 422 | The hybrid's own vote was no. The body has the contract's error. Nothing was forwarded. |
| `unavailable` | 503 | The hybrid is not ready or outdated, or no supernode could be reached. Nothing was forwarded. Send it to a supernode instead. |
| `unanswered` | 504 | Forwarded, but no answer in time. The body carries `$umid`. Look it up with `GET /umid/:umid` before sending again. A resend is safe: before `$expire` it is detected as a duplicate, after it the ledger rejects it. |

A transaction sent through a hybrid must set `$tx.$expire`. See
[Sending a transaction](../transactions.md) for the transaction format.

The events the hybrid raises itself are `tx.committed`, `tx.failed`,
`divergence` and `adopt.undeclared`. Contract events appear under the
contract's name. A `where` pinned in the config hides the hybrid's own
events, because they carry no payload field to match.

`GET /divergences` and `POST /prune` also exist, for the `activehybrid`
command. They answer only from the machine the node runs on.

## Admission and keys

Each hybrid has one key, in `.identity`, and its key hash is how the network
knows it. On the supernodes:

```bash
activeledger hybrid list
```

```
386aaf8b...  reporting node  http://hybrid.example.com:5270  feed
```

The line ends with `retired`, `banned` or `feed` (a feed is connected to this
supernode) as applies. `activeledger hybrid list` and `feeds` ask the running
supernode and work only on its own machine.

- Admission is on the ledger: `open`, or an allowlist changed with
  `activeledger hybrid allow` and `deny` (see
  [Set up and run a hybrid](run.md)). A key that
  is not admitted cannot register, and only registered keys are served.
- A ban is local to one supernode and is not consensus. Use it for abuse under
  open admission: `activeledger hybrid ban <keyhash>` writes the key to
  `hybrid-bans.json` next to the supernode's config, and `hybrid list` shows
  the key as `banned`. The key is refused on new requests at once: every
  `/h/*` request it makes is answered 403, so it cannot reconnect. A feed it
  already has open is not cut off instantly; the supernode closes it at its
  next heartbeat, about 10 seconds later, and until then it still counts in
  `hybrid feeds`. `unban` lifts it.
- Retiring is permanent for a key. `activehybrid retire --yes` removes the
  registration; that key can never register again, and the hybrid needs a new
  identity (`activehybrid init --force`) to come back.
- `activehybrid update --endpoint http://new.example.com:5270` changes the
  advertised address.

When a change to the network's hybrid rules is applied (`allow`, `deny`,
`admission`, `min-version`), every hybrid logs
`Dropped feed item <umid> from <upstream>: tally 0/3 below consensus 60%; invalid attestation signature from <node>`.
That is expected for a setup transaction, and the hybrid stays `ready`.

## Feed limits

Each hybrid holds one long-lived feed open to a supernode. A supernode serves
at most `hybridMaxFeeds` of them at once (`--hybrid-max-feeds <n>`, default
32), set in its own `config.json`, not on the ledger. Beyond that it answers
`503 feed limit reached`, and the hybrid tries its next upstream, then waits
and retries, doubling from 1 second up to 30.

One feed per key per supernode: a reconnect replaces the old one, so a
half-dead connection cannot hold a slot against its owner.

```bash
activeledger hybrid feeds
```

```
3 of 32 feeds
386aaf8b...  at umid:1761650000000,ab12...  3600s
```

If several hybrids follow one supernode, give them more than one upstream so
they spread out, and raise the limit on supernodes that can afford it.

## The window and pruning

`window.days` in `hybrid.json` (30 by default) is how long a hybrid keeps
transaction records and events. Every hour the pruner deletes those older
than the window, except:

- the record each stream currently points at;
- records of transactions this hybrid relayed itself;
- a record whose date it cannot read.

Current state, stream meta, contracts and divergence records are never
pruned. A pruned record is fetched from a supernode again when something asks
for it. To see what a run would do, or to run one now:

```bash
activehybrid prune --dry-run
activehybrid prune
```

```
would prune 1200 umid docs and 3400 events
```

The network's `hybrid.window` on the ledger is the window the network
suggests; the hybrid's own `window.days` is what it uses.

## Put TLS in front

The `/h/*` endpoints a hybrid uses on a supernode are signed, not encrypted.
Each request carries the hybrid's key hash, a timestamp and a signature over
them, and a supernode accepts a signature for 60 seconds and only once. That
proves who sent a request; it does not hide what was sent. Over any network
you do not own, put TLS in front:

1. Run a reverse proxy with a certificate in front of the supernode's port.
   The proxy must pass `GET /h/feed` through as a stream without buffering
   it.
2. Point the hybrid at the proxy with `"tls": true` on that upstream in
   `hybrid.json`:

```json
"upstreams": [
  { "host": "supernode.example.com", "port": 443, "transport": "http", "tls": true }
]
```

The hybrid's own API is plain HTTP too, and `token` only proves the caller
knows the token. If you move `bind` off `127.0.0.1`, set a token and put TLS
in front of the hybrid in the same way. See
[Keeping it safe](../operate/security.md).

## When it falls behind

Signs: `activehybrid status` shows a growing lag, or `activehybrid.log` says
a feed ended or was refused. An upstream with `"ok": false` in `/health` is
not a sign on its own: only the upstream the feed is on shows true.

1. Check the supernode is up and reachable from the hybrid's machine on the
   port in `upstreams`.
2. Look for `refused the feed (not registered, retired or banned)` in the
   log. Run `activehybrid register`; if it says the key is retired, you need
   a new identity. If the supernode operator banned you, ask them.
3. Look for `feed limit reached`. Add another upstream, or ask the operator
   to raise `hybridMaxFeeds`.
4. Look for `below the network minimum`. The hybrid is outdated: upgrade
   `@activeledger/activehybrid`, then `activehybrid restart`. It resumes from
   where it stopped; nothing is re-synced.
5. If the network's `minVersion` was lowered while the hybrid was up, it
   resumes on its own, unless it started outdated, in which case the log says
   `restart to resume`.

A hybrid keeps answering reads from its local copy while behind, and keeps
reporting the lag. If your application must not act on stale data, have it
gate on `/health`, or set `maxLagSeconds` so `/health` goes to 503 and a load
balancer takes the hybrid out.

## When it diverges

A divergence is written when the hybrid ran a contract and got a different
result from what the supernodes committed, or when a transaction the network
failed would have passed here. The hybrid repairs its copy from the network
and writes the record; it does not stop.

```bash
activehybrid divergences --since 2026-10-01
```

```
2026-10-27T09:12:44.101Z  output-mismatch  ab12cd34...
```

| Kind | Meaning |
|---|---|
| `output-mismatch` | The hybrid's outputs differed from the signed outputs. |
| `umid-doc-mismatch` | The transaction record differed from the signed one. |
| `failed-but-passed` | The network failed the transaction; it passed here. |
| `execution-error` | The contract could not be run here, twice. |
| `adopt-rejected` | A supernode-only result did not fit what the contract declared it would write. |

Each record also holds the supernode tally, the local result and the
revisions involved. What to do:

- One or two, on a contract that calls out to other systems or uses
  supernode-only data: expected until the contract wraps that work in
  `isSupernode()` and declares what it writes. Point its author at
  [Writing contracts that also run on hybrids](../contracts/hybrid.md).
  `adopt.undeclared` warnings in the log name the contracts that need it.
- Many, across contracts, starting at once: the hybrid is probably on a
  different release from the supernodes. Compare `version` and `minVersion`
  in `/health`, and upgrade.
- Repeated on one stream after repair: report it to the network's operators
  with the record. The hybrid's copy has been repaired from the network each
  time, so reads from it are correct; the record is the evidence that
  something disagreed.

Divergence records stay local to the hybrid and are never pruned.

## SPI between hybrids

SPI is the repair a node runs when its copy of a stream is wrong: it asks
others for the stream and takes what they agree on. A hybrid's repair goes to
its supernodes, and every document it takes is checked against the signed
outputs before it is saved, so one honest source is enough.

`hybrid.json` has a `peers` list for other hybrids, meant to be asked first
and to answer the same questions a supernode does. In this release a hybrid
does not serve those questions, so a peer entry cannot answer and only slows
a repair down. Leave `peers` empty.
