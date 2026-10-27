<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activep2p

Authenticated, encrypted peer to peer transport for Activeledger.

- Handshake: ephemeral X25519 on each side, both sides sign the transcript with
  their long-term identity key (any `ActiveCrypto.KeyPair` type), session keys
  derived with HKDF-SHA256.
- Frames: 4 byte big-endian length prefix, ChaCha20-Poly1305 with a key per
  direction and an implicit, increasing nonce counter. A replayed, reordered,
  tampered or oversize frame drops the connection.
- Messages: msgpack via `ActiveClone`, request/response with ids and timeouts,
  and push in both directions over named channels.

```ts
import { P2PServer, P2PClient } from "@activeledger/activep2p";

const server = await P2PServer.listen({
  port: 5262,
  identity: { type: "secp256k1", publicKey, privateKey },
  isKnownPeer: (key, type) => registry.has(key),
});
server.handle("umid", async (payload, connection) => lookup(payload));

const peer = await P2PClient.connect({
  host: "127.0.0.1",
  port: 5262,
  identity,
  expectedPeerKey: supernodeKey,
});
const answer = await peer.request("umid", { umid }, 5000);
peer.push("feed", item);
peer.close();
```

Which keys are acceptable is the caller's decision (`isKnownPeer`), as is any
rate limiting or banning; a connection exposes `peerKey`, `drop(reason)` and
`close`/`error` events for that.
