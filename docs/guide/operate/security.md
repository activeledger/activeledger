# Keeping it safe

What a node keeps secret, who it talks to, and what to put in front of it.

## Keys

Each node has one key pair, in the file `.identity` in the folder it runs from (or the file given with `--identity`). It is made on the first start if it is missing, as an RSA pair, and written readable by the owner only. It holds both halves: `pub.pkcs8pem`, the public key you put in every node's `neighbourhood`, and `prv.pkcs8pem`, the private key.

The private key is what makes the node a member of the network. It signs the node's votes and commits (from build 40300), the messages it sends other nodes when `security.signedConsensus` is on, and the transactions that change the network itself (assert, adding and removing nodes, hybrid rule changes). A hybrid node has an `.identity` of the same shape, and its key is what the network admits.

An `.identity` made before 5.1.0 keeps whatever permissions it had. Check it:

```
chmod 600 .identity
```

If a node's private key is lost or exposed, make a new identity and change the node's entry in the network (remove the node, then add it with the new public key: see [Nodes](nodes.md)). Other nodes only trust the public key in their neighbourhood list.

## What to protect

| What | Where | Why |
|---|---|---|
| `.identity` | node folder | the private key |
| `config.json` | node folder | the CouchDB address and password in `db.url`, when CouchDB is used |
| the data folder | `db.selfhost.dir`, `./.ds` by default | the whole ledger, including this node's volatile data |
| `contracts/` | node folder | compiled contracts and the `_LOCK.` files that stop a version running |

The embedded store has no login of its own. It binds to `127.0.0.1` (`db.selfhost.host`); leave it there. Anything that can reach it can read or rewrite the ledger.

## Which addresses may talk to a node

Nodes identify each other by address. Each entry in `neighbourhood` has a `host`, and a request to a node-only endpoint is accepted only when it comes from that address and names that node. The node does not read `X-Forwarded-For`, so nodes must reach each other directly, not through a proxy that changes the source address.

| Who may call | Endpoints |
|---|---|
| Anyone | `POST /` (send a transaction), `POST /a/encrypt`, `GET /a/status`, `POST /a/stream` (read streams by id; volatile is refused with 403) |
| A neighbour, from its listed address | `POST /a/init`, `GET /a/all`, `GET /a/umid/...`, and the TCP stream on `port + 1` |
| This machine only (loopback) | `GET /a/hybrid/list`, `GET /a/hybrid/feeds`, `POST /a/hybrid/ban`, `POST /a/hybrid/unban` |
| This machine or a neighbour, with `remote` on | `GET /a/admin-reload` |
| Registered hybrids, by signed request | `/h/*` |

Anything else is answered 403 or 404. Set your firewall to match: the node port open to neighbours, clients and hybrids; `port + 1` open to neighbours only; the store port closed.

Traffic between nodes is plain HTTP (and a plain TCP stream) unless you turn on `security.signedConsensus` and `security.encryptedConsensus` in `config.json`. Run the nodes on a private network or VPN, or turn those on. With either on, node traffic goes over HTTP only.

A request body over `security.maxRequestBytes` (16 MB by default) is refused with 413.

## TLS

The node serves HTTP, not HTTPS. Put a reverse proxy with TLS in front of it for clients and for hybrids, and point them at the proxy. Keep node-to-node traffic on the node port directly, because the proxy would change the source address the neighbour check relies on.

The `/h/*` API, which hybrids use to follow the ledger, authenticates every request with a signature (`x-hybrid-signature`, over the hybrid's key hash and a timestamp within 60 seconds) but does not encrypt it. When hybrids connect over a network you do not control, give them the TLS endpoint as their upstream.

## Who may run a hybrid

`hybrid.admission` in the network's settings decides which keys may register as hybrids: `"open"`, or an allowlist of public keys or key hashes. A section with neither admits nobody. Change it on a running network from any node:

```
activeledger hybrid admission allowlist
activeledger hybrid allow <key>
activeledger hybrid deny <key>
```

`<key>` is a key hash, a PEM public key, or the path of a file holding one. Each is a change to the network's settings, so more than half of the nodes must sign it; see [Operating hybrids](../hybrid/operate.md). `deny` stops new registrations only. To keep one hybrid off a supernode without changing the network's rules, on that supernode:

```
activeledger hybrid ban <keyhash>
```

That is local to the node and is written to `hybrid-bans.json`. The key is refused on new requests at once: every `/h/*` request it makes is answered 403, so it cannot reconnect. A feed it already has open is not cut off instantly; the supernode closes it at its next heartbeat, about 10 seconds later. `unban` undoes it. A retired key is answered 403 in the same way.

`hybrid.minVersion` keeps old hybrid releases off the network: a hybrid below it stops applying items and reports itself outdated.

## Volatile data is private

A contract can keep data on a stream that is never shared: the volatile part. It stays on the node that wrote it. No node serves it, a restore never copies it, and a hybrid never downloads it. Do not expect it to match between nodes, and do not treat it as a backup.

## What is logged

The node logs to the console, one line per event, with a level (`INFO`, `WARN`, `ERROR`, `FATAL`). Under systemd or pm2 the start-up progress is printed as plain lines instead of the chain display. Logs carry transaction ids, repair activity (`SPI ...`), neighbour changes and start-up steps. They do not carry transaction bodies. A failed commit is logged with its reason, because the client only gets a short message.

`"debug": true` adds `DEBUG` and `TRACE` lines, which include transaction ids as they arrive, and also returns full contract error text to the client. Keep it off in production.

`"winston": true` writes the same lines to rotating files in `./winstonlogs/`: a new file every hour, zipped, 20 MB each at most, kept for 14 days. Protect that folder like any log.

The ledger itself records the sender's address with each transaction it commits. That is part of the data, not the log.
