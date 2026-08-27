# Transport: HTTP vs P2P

Nodes need to talk to each other for every broadcast in the gossip protocol described in [architecture.md](architecture.md). As of `v4.1.0` there are two ways they can do it. **HTTP is the default and the one actually recommended right now** — read to the end before turning P2P on.

## HTTP (default)

Plain HTTP via [undici](https://github.com/nodejs/undici) (`packages/utilities/src/request.ts`), one request per peer per broadcast. Two relevant tuning details already applied:

- Keep-alive is held open for 30 seconds (raised from undici's 4-second default), so a busy node isn't renegotiating a TCP connection on every single broadcast to the same peer.
- Payloads under 1KB skip gzip entirely — for small consensus messages, the compression CPU cost outweighs the bytes saved. The receiving side already handled uncompressed bodies gracefully before this change, so it's a pure sender-side optimisation.

This is what every node runs unless you explicitly turn P2P on (see below) — both `p2pStream` and `p2pStreamServer` default to `false`.

## P2P (optional, off by default)

A persistent binary-stream TCP transport (`packages/network/src/network/p2pClient.ts`), merged into `master` as part of the `hpe-11a` integration in `v4.1.0`. It's real, working code — not a stub — but it needs both flags set to actually engage:

```json
{
  "p2pStream": true,
  "p2pStreamServer": true
}
```

`p2pStream` is the client side (does this node *send* over P2P), `p2pStreamServer` is the server side (does this node *accept* P2P connections). You need both true, on every node in the network, for it to do anything — a mixed network just falls back to HTTP for the nodes that don't have it enabled, since the client side detects per-peer whether P2P is viable and falls back automatically.

How it works: each node holds a persistent TCP socket to every peer (2-second reconnect backoff, gives up after a 10-minute grace period), framed as `[40-byte sender reference][4-byte length][payload]` — no HTTP headers, no per-message handshake. Payloads are MessagePack-serialized with gzip always applied (`ActiveClone.serialize(params, { enableCompression: true })`) — unlike the HTTP path, there's no size threshold skipping compression for small P2P payloads, which is a minor inefficiency worth revisiting if P2P sees real use. `send()` is fire-and-forget: it writes to the socket and returns immediately, it does not wait for a response.

It carries the entire gossip lifecycle described in [architecture.md](architecture.md) — both the origin's initial `init` fan-out and every peer's vote re-broadcast go through the same code path (`neighbour.ts`'s `knock("init", ...)`), gated on P2P being viable for that peer. It is *not* a partial implementation limited to one phase, contrary to what an isolated `TODO` comment in `protocol/process.ts` (about "Consensus Vote Reconciling not available on broadcast p2p method") might suggest in isolation — that TODO is scoped narrowly to one rare minority-dissent recovery edge case (a node that voted `false` locally but the network reached consensus anyway), not general vote-carrying.

"Fire-and-forget" isn't just the common case, either: the receiving server (`host.ts`'s `p2pServer`) never writes a response back on the socket, and the client's own receive-side code (buffering, frame parsing, an event to hook into — see [utilities.md](utilities.md#activeframe-correct-in-design-but-its-counterpart-in-the-p2p-client-is-dead-code)) has nothing listening to it. There is currently no response path over P2P at all, in either direction.

## Why HTTP stays the recommendation for now

This session ran a real, controlled comparison: a 4-node network, bare-host (not Docker), submitting the same 100 self-signed onboarding transactions with HTTP, then again with both P2P flags on. **Result: ~4.88 TPS with HTTP, ~4.86 TPS with P2P — no meaningful difference, well within noise.**

That's not a wash — it's informative. It means that on this workload, the per-transaction cost is dominated by something transport doesn't touch, almost certainly contract VM execution and RSA sign/verify time (both the client generating a fresh keypair and signing, and the node verifying it), not network overhead. An earlier back-of-envelope estimate (before P2P was real, merged code) had projected P2P might roughly double aggregate throughput, reasoning from transport overhead alone. That estimate wasn't wrong about what P2P saves — persistent framing-free sockets genuinely do cut per-hop overhead — it was wrong about how much that saving matters next to the actual bottleneck. If you're trying to improve throughput, profile contract execution and crypto operations before reaching for a transport change.

**If you do enable P2P, watch out for this specific failure mode**: a node running on the literal default port (5260) keeps its `core` API auto-started, which binds `api.port` (default `5261`) — and the P2P server binds on `main port + 1`, which for a default-port node is *also* `5261`. Turning on `p2pStreamServer` on a default-port node with `core` auto-start still enabled will crash it with a port collision. Either move that node off the default port, or set `autostart.core: false` explicitly before enabling P2P.
