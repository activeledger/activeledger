<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activecrypto

Key pairs, signatures and hashes for Activeledger, over several algorithms behind one interface.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activecrypto
```

Needs Node.js 24 or later.

```ts
import { ActiveCrypto } from "@activeledger/activecrypto";

const keyPair = new ActiveCrypto.KeyPair("rsa");   // or "secp256k1", "ed25519", the post-quantum types...
const keys = keyPair.generate();                   // keys.pub.pkcs8pem, keys.prv.pkcs8pem

const signature = keyPair.sign({ any: "object" });
new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem).verify({ any: "object" }, signature);

ActiveCrypto.Hash.getHash("text");                 // SHA-256
```

`rsa` is the default. `secp256k1`, `ed25519` and the post-quantum types (ML-DSA, FN-DSA) are also supported; [Keys, identities and namespaces](https://activeledger.github.io/activeledger/identities/) lists them and how each key is written. To reload a saved key, pass it to the constructor: `new ActiveCrypto.KeyPair("rsa", privatePem)`.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Keys, identities and namespaces](https://activeledger.github.io/activeledger/identities/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/crypto)

MIT licensed.
