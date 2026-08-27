# Activeledger Documentation (v4.1)

This is a from-scratch documentation pass covering Activeledger as it actually is at **v4.1.0**, written after a hands-on session that fixed a live consensus bug, merged two long-stalled feature branches, replaced the storage engine, and benchmarked the result on a real 4-node network. The docs in [`docs/en-gb`](../docs/en-gb) and [`docs/zh-cn`](../docs/zh-cn) predate all of that (they're still titled "Activeledger V2 Documentation") and are kept as-is rather than edited in place. This folder is meant to replace them for English-language readers; nothing here has a Chinese translation yet.

## What is Activeledger

Activeledger is a distributed ledger (blockchain-style) protocol. A network is a set of permissioned nodes that gossip transactions to each other, vote on them, and commit the ones that reach consensus. Application logic lives in smart contracts (TypeScript, sandboxed), and each contract's state lives in "streams" — the ledger's basic data building block. Because consensus is tracked per-stream rather than globally, unrelated transactions can be voted on and committed concurrently.

## The packages

The repository is an npm/lerna monorepo. Three of these are things you actually run; the rest are libraries they depend on.

| Package | npm name | What it is |
|---|---|---|
| **activeledger** | `@activeledger/activeledger` | The node itself — consensus, networking, the CLI. This is the only one you strictly need. |
| **core** | `@activeledger/activecore` | REST API over the ledger data (events, subscriptions, OpenAPI/Swagger). Optional but recommended. See [core.md](core.md). |
| **restore** | `@activeledger/activerestore` | Watches for a node falling behind or coming up empty and heals it from the rest of the network. Optional but recommended. See [restore.md](restore.md). |
| hybrid | `@activeledger/activehybrid` | Runs `core`+`restore` bundled with a node in one process, for smaller deployments. |
| network | `@activeledger/activenetwork` | The gossip/consensus engine and both transports (HTTP and the newer P2P stream). See [transport.md](transport.md) and [network-internals.md](network-internals.md). |
| protocol | `@activeledger/activeprotocol` | The consensus state machine and the contract VM sandbox. See [architecture.md](architecture.md). |
| storage | `@activeledger/activestorage` | The embedded data engine (LevelDB via `classic-level`) and the CouchDB-compatible external option. See [storage.md](storage.md). |
| contracts | `@activeledger/activecontracts` | Base classes smart contracts inherit from. See [contracts.md](contracts.md). |
| crypto | `@activeledger/activecrypto` | Key generation, signing, verification (RSA and secp256k1/EC). See [crypto.md](crypto.md). |
| httpd | `@activeledger/httpd` | The lightweight HTTP server (built on uWebSockets.js) used by the network host and self-hosted storage. See [httpd.md](httpd.md). |
| query | `@activeledger/activequery` | Now just the contract event engine (`EventEngine`). The SQL/Mango query sub-feature was removed in the `hpe-11a`→`v4.1` merge — it was already dead, commented-out code, unused by anything. |
| options | `@activeledger/activeoptions` | CLI/config parsing, a TTL-based (not LRU) cache used by the storage layer, and the CouchDB HTTP client. See [options.md](options.md). |
| definitions | `@activeledger/activedefinitions` | Shared TypeScript types for the ledger entry / transaction shape, including a weighted multi-authority model most docs miss entirely. See [definitions.md](definitions.md). |
| utilities | `@activeledger/activeutilities` | HTTP request helper (undici-based), gzip helper, and `ActiveClone` — the MessagePack+gzip serializer introduced in `v4.1` for the P2P transport and storage layer. |
| logger | `@activeledger/activelogger` | Structured console logging. |
| toolkits | `@activeledger/activetoolkits` | PDF generation (`PDF`) and an HTTP client re-export — one of only two modules a contract is allowed to `import` by default inside the VM sandbox. See [toolkits.md](toolkits.md). |

## Installing and running a node

You need Node.js. **Use 20.x** — the native HTTP server binding (`uWebSockets.js`) only supports Node 18/20/22/23, and this monorepo has been built and tested against `20.11.0` specifically.

```bash
npm i -g @activeledger/activeledger @activeledger/activerestore @activeledger/activecore
activeledger
```

On first run this generates a node identity (`.identity`), a default `config.json`, and starts the embedded LevelDB data store. See [configuration.md](configuration.md) for what's in that file, and [cli.md](cli.md) for every CLI flag and the multi-node testnet setup — including a couple of port-collision gotchas that aren't obvious until you hit them.

## Onboarding an identity

Every participant needs a stream on the ledger before they can transact. New identities self-sign their own onboarding transaction — no pre-existing authority is required:

```json
{
  "$tx": {
    "$namespace": "default",
    "$contract": "onboard",
    "$i": {
      "identity": {
        "type": "rsa",
        "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
      }
    },
    "$o": {}
  },
  "$selfsign": true,
  "$sigs": {
    "identity": "<base64 signature of the $tx object above, signed with the matching private key>"
  }
}
```

POST that as JSON to the root of any node (`http://127.0.0.1:5260/` in the default config). This exact request shape was verified working end-to-end during this session's benchmark run — see [transactions.md](transactions.md) for the full request/response cycle and what each field means.

## Reading order

If you're new to the codebase, this is roughly the order these docs assume:

1. [architecture.md](architecture.md) — the consensus/gossip model, why streams are the unit of concurrency, the contract VM lifecycle.
2. [network-internals.md](network-internals.md) — node identity, the neighbour state machine, and the worker process pool underneath the architecture above.
3. [transport.md](transport.md) — how nodes actually talk to each other (HTTP today by default; an optional P2P transport that exists but isn't yet the better choice).
4. [storage.md](storage.md) — the embedded data engine, and the RocksDB-that-wasn't story.
5. [httpd.md](httpd.md) — the custom HTTP layer underneath both of the above.
6. [crypto.md](crypto.md) — key types, signing, and the transaction-signing convention.
7. [definitions.md](definitions.md) — the shared type vocabulary, and a weighted multi-authority model that isn't documented anywhere else.
8. [options.md](options.md) — config precedence (it's not what you'd guess), the TTL cache, the CouchDB client.
9. [configuration.md](configuration.md) and [cli.md](cli.md) — running a real node or a local testnet.
10. [contracts.md](contracts.md), [toolkits.md](toolkits.md), and [transactions.md](transactions.md) — building on top of the ledger, and the VM sandbox's import allowlist.
11. [core.md](core.md) and [restore.md](restore.md) — the two optional companion services.
