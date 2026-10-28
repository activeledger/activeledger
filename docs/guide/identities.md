# Keys, identities and namespaces

Before you can send a transaction you need an identity on the ledger. This page shows you how to make one, and how to register a namespace so you can deploy your own contracts.

## What an identity is

An identity is a record (a "stream") on the ledger that holds a public key. Every stream has an id: 64 hexadecimal characters, unique across the network. When you send a transaction you sign it with the matching private key, and every node checks the signature against the public key stored in your identity stream. If it does not match, the transaction is rejected.

The private key never leaves you. The ledger only ever sees the public key and signatures.

## Key types

Activeledger accepts these key types. The name in the left column is the string you send as `type`.

| Type | What it is | Key format |
|---|---|---|
| `rsa` | RSA, 2048 bits. The default. | PEM text (`-----BEGIN PUBLIC KEY-----`) |
| `secp256k1` | Elliptic curve, the curve used by Bitcoin and Ethereum. `bitcoin` and `ethereum` are accepted as aliases. | Hex string starting `0x` |
| `ml-dsa-65` | Post-quantum signatures (FIPS 204). | Raw key bytes, base64 |
| `falcon-512` | Post-quantum signatures (FN-DSA, draft). Smaller signatures than ML-DSA. | Raw key bytes, base64 |

If you have no reason to choose, use `rsa`. The post-quantum types are for ledgers that must resist future quantum computers; their signatures are much larger (ML-DSA-65 signatures are 3309 bytes, against 256 for RSA) and every signature is stored for good.

## Create a key pair

Key generation is done by the `@activeledger/activecrypto` package. In your working folder, run this once to get it:

```
npm init -y && npm install @activeledger/activecrypto
```

Inside a checkout of the Activeledger repository it is already installed, so skip that step there.

Save this as `keys.js` and run it with Node:

```js
const { ActiveCrypto } = require("@activeledger/activecrypto");
const fs = require("fs");

const keyPair = new ActiveCrypto.KeyPair("rsa");
const keys = keyPair.generate();

fs.writeFileSync("identity.pub", keys.pub.pkcs8pem);
fs.writeFileSync("identity.key", keys.prv.pkcs8pem, { mode: 0o600 });
console.log("public key written to identity.pub, private key to identity.key");
```

```
node keys.js
```

`keys.pub.pkcs8pem` holds the public key and `keys.prv.pkcs8pem` the private key, whatever the type (for `secp256k1` and the post-quantum types the field still has this name but contains a hex or base64 string rather than PEM).

To reload a saved key later, pass it to the constructor: `new ActiveCrypto.KeyPair("rsa", fs.readFileSync("identity.key", "utf8"))`.

## Onboard the identity

Onboarding is a transaction to the `onboard` contract in the `default` namespace. Because you do not have an identity yet, the transaction is "self-signed": you include the public key in the transaction itself and the node checks the signature against that.

```js
const { ActiveCrypto } = require("@activeledger/activecrypto");
const fs = require("fs");

const keyPair = new ActiveCrypto.KeyPair("rsa", fs.readFileSync("identity.key", "utf8"));

const txBody = {
  $namespace: "default",
  $contract: "onboard",
  $i: {
    identity: { type: "rsa", publicKey: fs.readFileSync("identity.pub", "utf8") },
  },
  $o: {},
};

const tx = {
  $tx: txBody,
  $selfsign: true,
  $sigs: { identity: keyPair.sign(txBody) },
};

fetch("http://127.0.0.1:5260/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(tx),
})
  .then((r) => r.json())
  .then((result) => console.log(JSON.stringify(result, null, 2)));
```

The pieces that matter:

- `$i` has one entry. Its key (`identity` here) is a label of your choosing, not a stream id, because you have no stream id yet.
- The value must contain `publicKey` and `type`. Always send `type`: without it the node assumes `rsa`, and a key of any other type fails with `Signature Incorrect`.
- `$selfsign: true` tells the node to check the signature against the `publicKey` in `$i`.
- `$sigs` uses the same label as `$i`, and the signature is over the `$tx` object. See [Transactions](transactions.md) for how signing works.

A successful reply looks like this (on a 3-node network; a single node gives `1`, `1`, `1`). The id under `$streams.new` is your identity's stream id. Keep it: it is how you refer to yourself in every later transaction.

```json
{
  "$umid": "…64 hex characters…",
  "$summary": { "total": 2, "vote": 2, "commit": 1 },
  "$streams": {
    "new": [
      { "id": "…64 hex characters…", "name": "activeledger.default.identity.identity" }
    ],
    "updated": []
  }
}
```

If `$summary` has an `errors` list, the identity was not created. The common causes are in [Transactions](transactions.md#common-errors).

On the ledger, the new stream records your public key as its "authority": the key allowed to sign for it. The `onboard` contract that ships with Activeledger approves every request, so anyone who can reach a node can onboard. If you need to control who may join, replace it with your own contract.

## Namespaces

A namespace is a name you own on the network. Contracts are deployed into a namespace, and only the identity that owns the namespace can deploy there. The `default` namespace holds the contracts that ship with Activeledger (`onboard`, `namespace`, `contract` and others) and cannot be claimed.

Register a namespace with a signed transaction to the `namespace` contract. This time `$i` is keyed by your stream id, and so is `$sigs`. This snippet is not a script on its own: `keyPair` is the one loaded at the top of the onboarding script, and `tx` is sent with the same `fetch` call. The easiest way is to copy the onboarding script, replace its `txBody` and `tx` with these, and run it again.

```js
const streamId = "…your identity stream id…";

const txBody = {
  $namespace: "default",
  $contract: "namespace",
  $i: { [streamId]: { namespace: "myorg" } },
};

const tx = {
  $tx: txBody,
  $sigs: { [streamId]: keyPair.sign(txBody) },
};
```

The rest of this guide uses `myorg` as the namespace. Rules the node applies:

- The name is lower-cased. `MyOrg` becomes `myorg`.
- `default` is refused with `Namespace Reserved`.
- A name already registered on that node is refused with `Namespace Reserved`.
- An identity owns one namespace at a time. Registering again moves the identity to the new name. The old name stays reserved: nobody can register it again, and nobody, including you, can deploy to it any more.

If the network's operator has set `security.deploy.allowlist` in the node's `config.json`, only the identity stream ids in that list can register a namespace; anyone else gets `Deployer not permitted`. See [Configuration](operate/configuration.md).

Once registered, you deploy contracts into the namespace with the same identity. See [Deploy](contracts/deploy.md).

## What to keep safe

- **Your private key.** There is no reset. Anyone who has it can sign as you, and if you lose it nothing can sign for your identity again. Keep the file out of version control and readable only by you (the `keys.js` script above sets mode `600`).
- **Your stream id.** This is not secret; it is in every transaction you send. You need it, so record it somewhere you will find it.
- **Your namespace.** It is tied to your identity stream, so it is only as safe as the private key.

!!! note
    Each node also has its own key pair in its `.identity` file. That is the node's identity, used for node-to-node traffic, and is separate from the identities on this page. See [Security](operate/security.md).
