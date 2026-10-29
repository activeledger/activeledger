# JavaScript / TypeScript SDK

The JavaScript SDK builds, signs and sends transactions, and makes and recovers keys, from Node.js, browsers and React Native. It ships as three npm packages: `@activeledger/sdk-node`, `@activeledger/sdk-web` and `@activeledger/sdk-core`, which holds the code the other two share. This page covers version 2.6.0. It is written in TypeScript and ships type definitions. It supports `secp256k1` and the post-quantum types `ml-dsa-65` and `falcon-512`; it cannot create `rsa` keys.

The post-quantum types need **Node 20.19 or later**. The packages declare no `engines` field, so nothing stops an older Node installing them; the SDK's CI tests Node 20.19, 22 and 24 only. Browsers and React Native have no Node requirement. The post-quantum types also need **Activeledger 4.7.0 or later** on the nodes; an older node rejects them at onboarding. This guide covers Activeledger 5.x, which is well past that.

The SDK sends transactions and keeps keys. It does not read streams or listen for events; see [Reading state](#reading-state) and [Events](#events).

## Install

Pick the package for where your code runs. Both have the same API, apart from key file storage (see Keys), and a key made by one works in the other.

| Where | Package | Signing |
|---|---|---|
| Node.js | `@activeledger/sdk-node` | `node:crypto` for `secp256k1`; `@noble/post-quantum` for the post-quantum types |
| Browser | `@activeledger/sdk-web` | `@noble/curves` and `@noble/post-quantum`, pure JavaScript |
| React Native | `@activeledger/sdk-web` | as for the browser |

```
npm install @activeledger/sdk-node
npm install @activeledger/sdk-web
```

Do not install `@activeledger/sdk-core` yourself. It comes in as a dependency, and everything in it is re-exported from the other two packages. `sdk-web` is an ES module package (`"type": "module"`).

## Quick start

This onboards a new identity and sends one transaction with it. It needs a running node and a contract; see [Identities](../identities.md) and [Transactions](../transactions.md) for what these mean.

```typescript
import { Connection, KeyHandler, TransactionHandler } from "@activeledger/sdk-node";
// or "@activeledger/sdk-web": the same names

const connection = new Connection("http", "localhost", 5260);
const keys = new KeyHandler();

const key = await keys.generateKey("mykey");
await keys.onboardKey(key, connection); // key.identity is now the new stream id

const tx = await new TransactionHandler().labelledTransaction({
  key,
  namespace: "myorg",
  contract: "<contract stream id>",
  inputLabel: "sender",
  inputData: { amount: 1 },
  stream: key.identity!,
});

const response = await connection.sendTransaction(tx);
console.log(response.$umid, response.$summary.commit);
```

`new Connection(protocol, address, port)` also takes one object, `{ protocol, address, portNumber }`. The default node port is 5260.

## Keys

`generateKey(name, compressed?, type?)` makes a key and returns a plain object, an `IKey`:

| Field | What it is |
|---|---|
| `name` | The label you gave it. Used as the key in `$i` and `$sigs` until the key has an identity. |
| `type` | `KeyType.EllipticCurve` (`secp256k1`), `KeyType.MLDSA65` (`ml-dsa-65`) or `KeyType.Falcon512` (`falcon-512`). |
| `key.pub.pkcs8pem`, `key.prv.pkcs8pem` | The public and private key. The field name is historical: `secp256k1` keys are `0x` hex, post-quantum keys are base64. |
| `identity` | The stream id. Empty until `onboardKey` succeeds. |

`KeyType.EllipticCurve` is the default. `compressed` only matters for `secp256k1` and is ignored for the others.

```typescript
import { KeyHandler, KeyType } from "@activeledger/sdk-node";

const key = await new KeyHandler().generateKey("quantum-safe", false, KeyType.MLDSA65);
```

`POST_QUANTUM_KEY_TYPES` is exported if you need to ask whether a type is post-quantum. For which type to choose and why, see [Identities](../identities.md#key-types).

`onboardKey(key, connection)` registers the public key with the `onboard` contract and sets `key.identity`. If the ledger refuses, the promise rejects with the ledger's reasons and `key.identity` stays unset.

`sdk-node` can save and load keys:

```typescript
await keys.exportKey(key, { location: "./keys", createDir: true });   // writes ./keys/mykey.json
const again = await keys.importKey("./keys/mykey.json");
```

`exportKey` also accepts `overwrite` and `name`, and refuses to overwrite an existing file unless `overwrite` is true. `sdk-web` has neither method; storing a key is up to your app.

!!! warning
    `exportKey` writes the whole `IKey` as plain JSON, **private key included**. It does not encrypt the file or set its permissions. Protect it yourself.

## Seeds and recovery phrases

A 12-word BIP-39 phrase can recreate a key on any machine. This is available in both packages.

```typescript
const key = await keys.generateBIP39Key("mykey");     // key.phrase holds the 12 words
const same = await keys.restoreBIP39Key("mykey", key.phrase);
```

Both take an options object as the last argument:

| Option | Meaning |
|---|---|
| `type` | The key type to derive. One phrase can back a `secp256k1`, an `ml-dsa-65` and a `falcon-512` identity; each gets its own seed. |
| `passphrase` | An optional BIP-39 passphrase. The same words with a different passphrase are a different key. |
| `compressed` | As for `generateKey`. |
| `validate` | On by default. The phrase must be 12, 15, 18, 21 or 24 words, from the English list, with a correct checksum. Pass `false` only to derive from something that is not a mnemonic. |
| `legacy` | Reproduces the old `@activeledger/sdk-bip39` package (`SHA256(phrase)` as the private key). For recovering an old phrase only; refused for the post-quantum types and not validated. |

A phrase gives the same key in `sdk-node` and `sdk-web`. For `secp256k1` the SDK takes the BIP-32 master key from the phrase's seed and goes no further; it does not derive child keys. For the post-quantum types it uses HKDF-SHA512 with a different label for each type.

!!! warning
    Other tools derive a key from a phrase differently. The same twelve words can give a different identity in each, with no error. Recover a phrase with the software that made it.

To start from a seed rather than a phrase, use `generateKeyFromSeed(name, seed, compressed?, type?)`. The seed is the algorithm's own: 32 bytes for `secp256k1` and `ml-dsa-65`, 48 for `falcon-512`. A wrong length is refused, not padded. A `secp256k1` seed of zero, or one not below the curve order, is refused too.

```typescript
const seed = new Uint8Array(32); // fill with 32 bytes from a secure source
const key = await keys.generateKeyFromSeed("mykey", seed, true, KeyType.EllipticCurve);
```

If you need the steps on their own, `recovery` is exported from both packages:

```typescript
import { recovery, KeyType } from "@activeledger/sdk-node";

const bip39Seed = recovery.toSeed(phrase);                       // 64 bytes, validates the phrase
const seed = recovery.deriveSeed(KeyType.Falcon512, bip39Seed);  // 48 bytes
```

`recovery.validate(phrase)` checks a phrase and returns it normalised, or throws with the reason.

## Sending transactions

`TransactionHandler.labelledTransaction` builds and signs a transaction whose input is a labelled stream. The key must have an identity, or it rejects with `Key must have an identity.`

| Option | `$tx` field | Notes |
|---|---|---|
| `key` | | Signs the transaction. |
| `namespace`, `contract` | `$namespace`, `$contract` | |
| `inputLabel`, `inputData`, `stream` | `$i` | Becomes `$i[inputLabel] = { ...inputData, $stream: stream }`. |
| `entry` | `$entry` | Optional. |
| `outputs` | `$o` | Optional. |
| `readonly` | `$r` | Optional. |
| `selfsign` | `$selfsign` | Optional. Also puts the key's public key and type into the input, and keys `$sigs` by `inputLabel`. |

The signature goes under the key's identity in `$sigs`. There is also a positional form, `labelledTransaction(key, namespace, contract, inputLabel, inputData, stream, entry?, outputs?, readonly?, selfsign?)`.

`connection.sendTransaction(tx)` posts it and resolves with the node's reply as an `ILedgerResponse`: `$umid`, `$summary`, `$streams` and optionally `$responses`. [Transactions](../transactions.md#reading-the-reply) explains each field.

!!! warning
    A refused transaction still resolves. The node answers HTTP 200 and the failure is in the reply. Check `response.$summary.commit` is above zero, and when it is not, read the `errors` the node sends in `$summary`. The `ILedgerResponse` type does not declare them, so cast: `(response.$summary as any).errors`. Only network and non-200 failures reject the promise. `onboardKey` is the exception: it rejects when no identity was created.

For a transaction the helper cannot shape, build the object yourself and sign it with `signTransaction`. This is how to add `$expire`, which `labelledTransaction` has no option for (see [Transactions](../transactions.md) for why you want it on anything you might retry):

```typescript
const handler = new TransactionHandler();
const tx = await handler.signTransaction(
  {
    $tx: {
      $namespace: "myorg",
      $contract: "<contract stream id>",
      $i: { [key.identity!]: { amount: 1 } },
      $expire: "2030-01-01T00:00:00Z",
    } as any,
    $sigs: {},
  },
  key,
);
const response = await handler.sendTransaction(tx, connection);
```

`signTransaction` signs `JSON.stringify(tx.$tx)` and stores the signature in `$sigs` under the key's identity (its name if it has none). Nothing may change `$tx` afterwards.

`buildOnboardKeyTx(key, { contract?, namespace? })` builds the onboarding transaction without sending it, for when you onboard through your own contract. The options apply to that call only.

## Reading state

The SDK has no calls for reading streams. `Connection` has one method, `sendTransaction`. To read, post to the node's `/a/stream` endpoint with any HTTP client; see [the HTTP endpoints](../api.md#read-streams-post-astream).

```typescript
const res = await fetch("http://localhost:5260/a/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ $streams: [key.identity] }),
});
const documents = await res.json();
```

## Events

The SDK has `LedgerEvents`, but it is **deprecated** and will go in the next major version. It subscribes to ActiveCore, which is itself deprecated and no longer serves events. A node serves contract events from its storage service, which only listens on the node's own host and must not be exposed. A browser or phone has nothing it should connect to. Run a small server-sent events listener on the node's host and relay what your application needs; see [the HTTP endpoints](../api.md#events-get-activeledgereventsevents).

## Signing elsewhere

`PayloadHandler` signs and verifies anything that is not a transaction: an order, an attestation, a login challenge. It needs no connection and no identity.

```typescript
import { KeyHandler, PayloadHandler, KeyType } from "@activeledger/sdk-node";

const payloads = new PayloadHandler();
const key = await new KeyHandler().generateKey("maker", false, KeyType.MLDSA65);

const order = { pair: "VNR/USDT", side: "sell", amount: "100" };
const signature = payloads.sign(order, key);           // base64

// Elsewhere, holding only the public key and its type:
payloads.verify(order, signature, key.key.pub.pkcs8pem, key.type); // true or false
```

`verify` never throws; a bad signature, a wrong key or a malformed input all give `false`. A string is signed as it is; anything else is signed as its `JSON.stringify`. `payloads.canonical(value)` returns that exact string.

`TransactionHandler.signTransaction(text, key)` with a string instead of an object returns just the base64 signature, for when you assemble the transaction elsewhere. Sign the exact `$tx` text you send.

## Things that will bite you

- **A key's type cannot change.** It is recorded at onboarding. To move to another type, onboard a new identity.
- **`JSON.stringify` is key-order sensitive.** Store `payloads.canonical(value)` beside a signature and verify against that. If something rebuilds the object field by field before you verify (a mapper, an ORM, a defaulter), the signature fails and it looks like a bad key.
- **The transaction must reach the node as it was signed.** `signTransaction` signs `JSON.stringify($tx)`. Do not change `$tx`, including key order, between signing and sending.
- **Post-quantum signatures are large.** ML-DSA-65 is 3309 bytes. Falcon-512 is 649 to 662 bytes, and the length varies, so do not size a buffer or a column to a fixed width.
- **A recovery phrase is the identity.** Anyone with the words can sign as you, and a mistyped phrase is refused by the checksum rather than giving a wrong key unless you turn `validate` off.
- **Resending runs it twice** unless the transaction has `$expire`. See [Transactions](../transactions.md).
- **React Native and browsers need a random source.** `sdk-web` calls the global `crypto.getRandomValues` for post-quantum keys and signatures. A browser has it. React Native does not by default; install a polyfill for it before generating or signing.
- **`sdk-web` is ESM only**, and plain-Node use of the post-quantum types depends on Node being able to `require()` an ES module, which is why Node 20.19 is the floor.

## Testing and further reading

The source, issues and the cross-language test vectors are at [github.com/activeledger/SDK-JS](https://github.com/activeledger/SDK-JS). The packages are on npm: [`@activeledger/sdk-node`](https://www.npmjs.com/package/@activeledger/sdk-node), [`@activeledger/sdk-web`](https://www.npmjs.com/package/@activeledger/sdk-web) and [`@activeledger/sdk-core`](https://www.npmjs.com/package/@activeledger/sdk-core).

To run the SDK's own tests, clone the repository and run `npm install` then `npm test`. That builds all three packages and runs the unit tests, the cross-package signature checks and the vector checks. The upstream CI runs it on Node 20.19, 22 and 24.
