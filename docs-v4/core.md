# `core`: the REST API

`@activeledger/activecore` (`packages/core/`) is the optional REST layer over a node's ledger data — the main consensus/gossip host (see [architecture.md](architecture.md)) doesn't expose most of this itself. Routes registered in `packages/core/src/index.ts`, checked against `v4.1.0`. Supersedes [`docs/en-gb/core.md`](../docs/en-gb/core.md).

**`core` is being considered increasingly redundant as of this writing** — direct project guidance, not something inferred from the code alone. The self-hosted storage engine (`selfhost.ts`, default port `5259`) exposes most of the same capability directly and more simply: live events over SSE at `GET /<database>/events`, a general changes feed, direct document reads, and Mango-style queries — see [storage.md](storage.md#the-self-hosted-engine-has-its-own-full-http-api-and-its-the-recommended-way-to-read-data-and-events) for the full list, verified working. If you have (or can get) trusted network access to a node's storage port, that's the currently-recommended path for reading data and subscribing to events, not this package. There's also a way to read data through a normal signed transaction instead of any HTTP API at all — a contract that calls `returnToRemote()` — also covered in that section. This page is kept accurate for what `core` does today, but don't treat it as the default recommendation.

A node with `core`+`restore` auto-started (the default, on the literal default port) was runtime-verified working correctly — `core`'s welcome route, `openapi.json`, and the storage engine all came up clean. An earlier pass of this section reported a storage crash-loop in this configuration as inconclusive; it turned out to be an artifact of how a background process was being launched in this session's sandbox (a process-group signal reaching the storage subprocess whenever the shell invocation that launched it completed), not an Activeledger defect — confirmed by relaunching the identical config fully detached (`setsid`) and getting a completely stable run. Not something you'd hit running this normally.

Auto-starts alongside a node by default (`autostart.core`), on `api.port` (default `5261`) — unless you're running multiple nodes on one host with a non-default `--port`, in which case auto-start gets disabled for you (see the `--port` gotcha in [cli.md](cli.md)) and you'd run `core` as its own separate process instead.

## Routes

| Path | Method | What |
|---|---|---|
| `/` | GET | Welcome/info. |
| `/explorer` | GET | A bundled explorer UI. |
| `/openapi.json` | GET | OpenAPI/Swagger document for this API — cached at module load rather than read from disk per request (a small perf fix from earlier `v4.1` work). |
| `/api/activity/subscribe`, `/subscribe/*`, `/subscribe/**` | GET, POST | Server-Sent Events subscriptions to activity/stream changes — one stream, several, or everything. |
| `/api/events`, `/api/events/*`, `/api/events/*/*` | GET | Events a contract has emitted (`Event`/`EventEngine` — see [contracts.md](contracts.md)), globally, per-contract, or per-contract-per-event-name. Prefer `GET /<database>/events` directly on the storage engine — see the note above. |
| `/api/secured/encrypt`, `/api/secured/decrypt` | POST | Encrypt/decrypt helper endpoints, backed by `KeyPair.encrypt()`/`decrypt()` (see [crypto.md](crypto.md)). |
| `/api/stream/changes` | GET | Change feed. |
| `/api/stream/*` | GET | Fetch a stream's current state. |
| `/api/stream/*/volatile` | GET, POST | A stream's non-consensus-tracked "volatile" data — read/write side-data that doesn't go through the vote/commit cycle. |
| `/api/stream` | POST | Fetch multiple streams by ID. |
| `/api/tx/*` | GET | Look up a transaction by `$umid`. |

## What's *not* here: SQL/Mango search

`/api/stream/search` is registered in the source but **commented out** (`index.ts`) — it would have called into the `Query` contract base class and the SQL query engine, both of which were removed in the `hpe-11a`→`v4.1` merge (see [contracts.md](contracts.md)). This wasn't a regression from that merge: the route was already dead code before the removal, so nothing that used to work stopped working. If you see references to searching the ledger via SQL or Mango elsewhere in older docs, that feature doesn't exist as of `v4.1.0`.

## Rate limiting

Governed by the `rate` config block (`minutes`/`limit`/`delay` — see [configuration.md](configuration.md)) — a request-count window per client, with an optional per-request delay instead of an outright rejection once the limit's hit.
