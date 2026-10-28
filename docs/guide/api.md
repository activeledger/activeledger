# The HTTP endpoints you need

Each node serves a small HTTP API. This page lists the endpoints a user of the ledger needs, with an example of the two you will use most.

The node listens on the address in `host` in its `config.json`; the default is `127.0.0.1:5260`. All requests and replies are JSON.

## Endpoints

| Method | Path | What it is for |
|---|---|---|
| `POST` | `/` | Send a transaction. The body is the transaction; the reply is the result. See [Transactions](transactions.md). |
| `POST` | `/a/stream` | Read streams by id. The body names the ids; the reply is the documents. |
| `GET` | `/a/status` | What the node knows about itself and its network. Useful to check a node is up. |
| `GET` | `/activeledgerevents/events` | A live feed of the events contracts raise. Served by the node's storage service, not the node, and only on the node's own host. See below. |

There is no endpoint for searching the ledger. If you need to find streams by their contents, keep your own index from the events feed or from the replies to your transactions.

The node also serves other paths under `/a/` for traffic between nodes (consensus, locks, restore) and paths under `/h/` for hybrid nodes that follow it. Those are not for users; most refuse requests that do not come from a known node.

## Send a transaction: `POST /`

Request:

```
curl -s -X POST http://127.0.0.1:5260/ \
  -H "Content-Type: application/json" \
  --data '{
    "$tx": {
      "$namespace": "default",
      "$contract": "onboard",
      "$i": { "identity": { "type": "rsa", "publicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n" } },
      "$o": {}
    },
    "$selfsign": true,
    "$sigs": { "identity": "…base64 signature…" }
  }'
```

Reply, on a 3-node network:

```json
{
  "$umid": "…64 hex characters…",
  "$summary": { "total": 2, "vote": 2, "commit": 1 },
  "$streams": {
    "new": [ { "id": "…64 hex characters…", "name": "activeledger.default.identity.identity" } ],
    "updated": []
  }
}
```

The status is 200 whether the transaction was accepted or not; a rejected transaction has `commit: 0` and an `errors` list in `$summary`. A body that is not JSON gets 500 with `Deserialization Error`. 413 means it was over the size limit (`security.maxRequestBytes`, 16 MB by default). [Transactions](transactions.md#reading-the-reply) explains each field.

## Read streams: `POST /a/stream`

A stream is stored as up to three documents, each with its own id:

| Id | Holds |
|---|---|
| `<stream id>` | The state: the data the contract keeps for this stream. |
| `<stream id>:stream` | The metadata: the stream's name, the keys allowed to sign for it (`authorities`), the transaction that created it (`origin`) and the one that last changed it (`umid`). |
| `<umid>:umid` | A transaction, by its `$umid`: what was sent, which streams it touched and any events it raised. |

Ask for any of them by id. You can ask for several at once.

Request:

```
curl -s -X POST http://127.0.0.1:5260/a/stream \
  -H "Content-Type: application/json" \
  --data '{ "$streams": [ "<stream id>", "<stream id>:stream" ] }'
```

Reply, one document per id found:

```json
[
  {
    "_id": "<stream id>",
    "name": "<stream id>",
    "type": "default.activeledger.identity",
    "_rev": "1-…"
  },
  {
    "_id": "<stream id>:stream",
    "umid": "<umid of the onboarding transaction>",
    "origin": "<umid of the onboarding transaction>",
    "name": "activeledger.default.identity.identity",
    "authorities": [
      { "public": "-----BEGIN PUBLIC KEY-----\n…", "type": "rsa", "stake": 100, "hash": "…", "umid": "…" }
    ],
    "txs": [ "<umid of the onboarding transaction>" ],
    "_rev": "1-…"
  }
]
```

The fields after `_id` depend on the contract that wrote the stream; the example is an identity made by `onboard`, whose state holds its own id as `name`. In the `:stream` document, `umid` is the last transaction that changed the stream and moves on with each later one, while `origin` is the transaction that created it and never changes; straight after onboarding both are the onboarding transaction's umid, as in the example. An id that does not exist is left out of the reply. A stream a transaction is writing at that moment comes back as `{ "_id": "<id>", "locked": true }`; ask again. Ids ending `:volatile` are refused with 403.

Each node answers from its own copy. Straight after a transaction, a node that was slow to commit can be a revision behind; if it matters, ask the node you sent the transaction to.

## Node status: `GET /a/status`

```
curl -s http://127.0.0.1:5260/a/status
```

```json
{
  "status": 4,
  "reference": "…this node's id…",
  "left": "…",
  "right": "…",
  "neighbourhood": { "neighbours": { "…node id…": { "isHome": true }, "…": { "isHome": false } } },
  "pem": "…this node's public key, base64…"
}
```

`status` is a number: 0 unrecognised, 1 pairing, 2 recognised, 3 unstable, 4 stable. A node ready to take transactions is at 4. `left` and `right` are the nodes either side of this one in the network's ordering. The `activeledger status` command reads this endpoint for you; see [The activeledger command](cli/activeledger.md).

## Events: `GET /activeledgerevents/events`

Contracts can raise events (see [Writing a contract](contracts/write.md)). Every node records them, and its storage service streams them as server-sent events: a long-lived HTTP response that delivers each event as it happens, which a browser's `EventSource` or `curl` can read.

```
curl -N http://127.0.0.1:5259/activeledgerevents/events
```

Each event carries an `id`. To pick up where you left off after a disconnect, send that id back in a `Last-Event-ID` header and the missed events are replayed first.

The storage service binds to `127.0.0.1` by default (`db.selfhost.host` in `config.json`), so this feed is only reachable from the node's own host. Put your own service in front of it if other machines need the events.

## The storage service is not an API

Port 5259 (`db.selfhost.port`) is the node's own database. It answers HTTP, and an operator on the node's host can read a document from it directly (`GET http://127.0.0.1:5259/activeledger/<id>`) when troubleshooting, but it has no access control and writing to it bypasses consensus. Never expose it, and do not build on it: use the node's endpoints above.
