# @activeledger/nano-gateway

A lightweight, permissioned SSE + read gateway for [nano](https://github.com/activeledger/nano) light-node clients.

## Why this exists

Activecore (`@activeledger/activecore`, `packages/core`) is nano's originally-planned data source, but it isn't running on the devnet this was built against, and its SSE controller (`controllers/sse.ts`) is written against Node's raw `http.IncomingMessage`/`ServerResponse` API - `res.setHeader()`, `res.write()`, `res.flushHeaders()`, `req.socket.setTimeout()`. The `@activeledger/httpd` this repo actually ships today is built on `uWebSockets.js` (confirmed by reading its published `lib/httpd.js`, not assumed) - route handlers get a raw uWS `HttpResponse`, which has none of those methods. Activecore's SSE path would throw immediately if invoked against it. That's very likely a real, standing cause of Activecore's unreliability, independent of anything else.

This package is a much smaller, purpose-built replacement for just what nano needs: a permissioned SSE subscribe endpoint, and the handful of reads nano's mini-SPI needs. It's modeled directly on `packages/hybrid` - direct database access via `ActiveDSConnect`, no consensus involvement, runs as a companion process alongside a real node.

## What "permissioned" means here

Anyone can read (`GET /api/stream/*`, `POST /api/stream`, `GET /api/tx/*`) - ledger data is public by design, unchanged from how Activecore worked. Only the **subscribe/push channel** is gated: a nano must be on this gateway's allowlist, and must prove it holds the private key for its claimed identity, before it gets a live feed. See `src/auth.ts`.

The handshake: a nano signs `${identity}:${timestamp}` with its own key (the same identity it already onboarded on this ledger and signs attestation transactions with - no separate key-distribution step) and sends `{identity, timestamp, signature}` in the subscribe request body. The gateway checks, in order: is this identity on the allowlist -> is the timestamp fresh (within `authWindowSeconds`, anti-replay) -> does the signature actually verify against a public key read *live off the identity's own `:stream` meta doc* (`meta.authorities[].public`) - not a key handed to the gateway out of band. Revoking a nano is just removing it from the allowlist file.

Auth travels in the POST body, not headers - `@activeledger/httpd`'s `listen()` only forwards a fixed, hardcoded set of headers to route handlers (confirmed by reading its source), and custom `x-nano-*` headers would never arrive.

## Config

On first run, a `config.json` (from `src/default.config.json`) and an empty `nano-allowlist.json` (`[]`) are created next to wherever you run the binary from. Nothing can connect until you add identities to the allowlist:

```json
[
  { "identity": "abc123...", "label": "adam's phone", "addedAt": 1788000000000 }
]
```

Key config fields (`config.json`):

- `db.url` / `db.database` - **you must fill this in.** Point it at the same datastore your Activeledger node already uses (its self-host port, or wherever its CouchDB-compatible store lives). This package doesn't know how to bootstrap a datastore itself, unlike `activehybrid`'s `selfhost` option - it's meant to run alongside an already-running node.
- `host` - `0.0.0.0:5270` by default. Change the port if `5270` collides with anything else on the host.
- `nanoGateway.allowlist` - path to the allowlist file.
- `nanoGateway.authWindowSeconds` - default `60`.
- `nanoGateway.heartbeatSeconds` - default `5`. Deliberately short: uWS's default idle timeout is ~10s of no socket traffic, far shorter than Activecore's own 10-*minute* SSE heartbeat (`packages/core/src/heartbeat.ts`) - that mismatch is a second, independent plausible cause of Activecore's SSE being unreliable even where it does run. Don't raise this without checking the uWS idle timeout first.

## Routes

```
GET  /                       health check
POST /api/activity/subscribe SSE, permissioned - body: {identity, timestamp, signature, streamIds}
POST /api/stream              batch read - body: string[] of stream ids -> {streams: [...]}
GET  /api/stream/:id          single read -> {stream: {...} | null}
GET  /api/tx/:umid            transaction lookup -> {transaction: {...} | null}
```

`/api/stream` and `/api/tx/:umid` are **not** wire-compatible with Activecore's equivalents - both had real bugs discovered this session while building the nano client against Activecore's actual source (`getStream()` drops `_id` from its response via a comma-expression bug; `findUmid()` names its response field `umid` when the value is the whole transaction, not a umid string). New code doesn't inherit either. nano's own client (`@activenano/core`'s `MiniSpiClient`/`TransactionResolver`) is written against *this* package's contract.

### Reconnect / resume

Each pushed frame is numbered by the underlying DB change sequence it came from (`id:{seq}` on the SSE frame, same convention as Activecore's own SSE). A client reconnecting with a `Last-Event-ID` header resumes the changes feed from that point instead of missing whatever changed while it was disconnected - `Last-Event-ID` is one of the fixed headers `@activeledger/httpd` actually forwards to route handlers (confirmed by reading its source), unlike the custom auth headers this had to route through the body instead. No header (or a fresh subscribe with a new stream-id set) starts from `"now"`, same as before. `@activenano/core`'s `NanoLedgerEvents` client does this automatically - see its own doc comment.

## Deploying this alongside a running node

1. `npm install -g @activeledger/nano-gateway` (once published) or build from source (`npm run build`, then `node lib/index.js`).
2. Run it on the same host as your node, or anywhere with network access to the node's real datastore. First run generates `config.json` - edit `db.url`/`db.database` before starting it for real.
3. Add approved nano identities to `nano-allowlist.json` as they're provisioned.
4. Expose the port (`5270` by default) the same way the node's own ports are already exposed - a Docker port mapping, and an nginx `location` block proxying to it (SSE needs `proxy_buffering off;` and a long `proxy_read_timeout` - standard nginx SSE config, not anything nano-gateway-specific).

Once this is committed and released, it publishes as its own package with its own bin (`nano-gateway`), so it can run as a sibling process in the same container as the node.
