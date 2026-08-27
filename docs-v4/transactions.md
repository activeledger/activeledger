# Transactions

A transaction is a single JSON document POSTed to any node's root URL (`http://<host>:<port>/`, handled by `Endpoints.ExternalInitalise` in `packages/network/src/network/endpoints.ts`). The node that receives it becomes the origin and starts the gossip/vote/commit cycle described in [architecture.md](architecture.md).

## Shape

```json
{
  "$tx": {
    "$namespace": "default",
    "$contract": "onboard",
    "$i": {
      "<streamId>": {
        "publicKey": "<PEM public key>",
        "type": "rsa"
      }
    },
    "$o": {}
  },
  "$selfsign": true,
  "$sigs": {
    "<streamId>": "<base64 signature of the $tx object>"
  }
}
```

- **`$tx.$namespace`** / **`$tx.$contract`** — which deployed contract handles this transaction. `default`/`onboard` is the contract bundled with every node, for registering new identities.
- **`$tx.$i`** / **`$tx.$o`** — input and output streams. Each key is a stream ID the transaction reads or writes; the contract decides what those keys mean. **Every stream referenced in either has to already exist unless the transaction is `$selfsign`** — see [contracts.md](contracts.md#the-rule-the-deployment-docs-dont-mention-io-streams-must-already-exist-unless-selfsign) for why, it's the single easiest mistake to make writing your first non-onboarding transaction.
- **`$sigs`** — one signature per stream ID referenced in `$i`, covering the entire `$tx` object (not just that stream's portion of it). The signing key must correspond to the identity already on that stream — except for onboarding, see below.
- **`$selfsign`** — set when a brand-new identity is authorising its own onboarding transaction. There's no existing ledger authority to sign against yet, so the transaction is signed by the very key it's registering.

The signature itself is `KeyPair.sign($tx)` (`packages/crypto/src/crypto/keypair.ts`) — RSA-SHA256 over the JSON-stringified `$tx` object, base64-encoded. If you're generating transactions programmatically, use the real `ActiveCrypto.KeyPair` class from `@activeledger/activecrypto` rather than reimplementing the signing scheme — the exact stringification it uses to turn an object into signable bytes isn't guaranteed to match a naive `JSON.stringify` in ordering or formatting, and using the real class guarantees compatibility with what the network's `signatureCheck` (`protocol/shared.ts`) verifies against.

## What the node adds server-side

The origin node fills in a few fields before broadcasting: `$datetime` (unless `$tx.$expire` is set and hasn't passed), `$umid` (a hash of the whole transaction, used for dedup — a second submission of the identical transaction is rejected as already existing), `$origin` (this node's reference), `$remoteAddr`, and `$broadcast: true` unless territoriality is already set.

## Response

On success:

```json
{
  "$umid": "e0b99c48b1547389a8a71b0543a9b95dfd9c4991989419959242a67ca5e4d356",
  "$summary": {
    "total": 30,
    "vote": 30,
    "commit": 30
  },
  "$streams": {
    "new": [
      { "id": "aedc2f06256a284c9f0be7ba914bf8c80d7fb765d489c2387be1b1d674776180", "name": "activeledger.default.identity.name" }
    ],
    "updated": []
  }
}
```

`$summary` reports how many nodes voted and committed out of the total participating. The new stream ID under `$streams.new` is what you reference as `$i`/`$o`/`$r` in future transactions involving this identity.

## A worked example: onboard, then a follow-up transaction

Everything in this section was run against a real single node this session — not just read from source. The code is complete and was actually executed; the JSON responses shown are genuine output, not constructed examples. If you're writing a client against Activeledger, this is a confirmed-working starting point as of `v4.1.0`.

### Step 1: generate a keypair and build the onboarding transaction

Use the real `ActiveCrypto.KeyPair` class, not a hand-rolled signer — see the note on canonical stringification above.

```js
const { ActiveCrypto } = require("@activeledger/activecrypto");

const kp = new ActiveCrypto.KeyPair("rsa");
const keys = kp.generate(); // { pub: { pkcs8pem }, prv: { pkcs8pem } }

const onboardTxBody = {
  $namespace: "default",
  $contract: "onboard",
  $i: {
    identity: { type: "rsa", publicKey: keys.pub.pkcs8pem },
  },
  $o: {},
};

// Self-signed: there's no existing authority yet, so the transaction is
// signed by the very key it's registering.
const signature = kp.sign(onboardTxBody);
const onboardTx = {
  $tx: onboardTxBody,
  $selfsign: true,
  $sigs: { identity: signature },
};
```

### Step 2: submit it

Plain HTTP POST, JSON body, to the node's root — no special headers required.

```js
const http = require("http");

function submit(tx, port = 5260) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(tx));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body)));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const onboardResult = await submit(onboardTx);
```

### Step 3: interpret the response

Real captured output from the run above:

```json
{
  "$umid": "0ad18a0d49e5bbe20a0593ba36b6c1156f8a6886eeb03dfaec3de382c79f44e8",
  "$summary": { "total": 1, "vote": 1, "commit": 1 },
  "$streams": {
    "new": [
      { "id": "77dca3e9475181bf4650224ec13d154c2589914734c2a39502b9357319ed2e0e", "name": "activeledger.default.identity.identity" }
    ],
    "updated": []
  }
}
```

The logic your client needs, in order:

```js
if (onboardResult.$summary.errors) {
  // Failed - see the error table below for what $summary.errors[i] means.
  // vote and commit will both be 0 (or well short of total) when this happens.
} else if (onboardResult.$summary.commit < onboardResult.$summary.total) {
  // Partial: enough of the network committed to satisfy consensus.reached,
  // but not literally every node (yet, or ever, if one's down). Still a
  // real success - don't treat this as a failure. Only $summary.errors
  // being present means something actually went wrong.
} else {
  // Every participating node committed.
}

const newStreamId = onboardResult.$streams.new[0].id;
```

**`$summary.vote`/`$summary.commit` being less than `$summary.total` is not itself a failure condition** — it means not every node had responded by the time this response was formed, which is expected and fine as long as `consensus.reached`'s threshold was met (see [architecture.md](architecture.md) for why nodes reach their own conclusions independently rather than waiting for unanimous agreement). The one field that actually indicates a problem is `$summary.errors` being present at all.

### Step 4: a follow-up transaction, signed by the identity you just created

This is the part worth having verified for real: a **non-self-signed** transaction, using the identity `onboardResult.$streams.new[0].id` just returned, to register a namespace (see [contracts.md](contracts.md) and [`docs/en-gb/contracts/deployment/namespace.md`](../docs/en-gb/contracts/deployment/namespace.md)):

```js
const newStreamId = onboardResult.$streams.new[0].id;

const namespaceTxBody = {
  $namespace: "default",
  $contract: "namespace",
  $i: {
    [newStreamId]: { namespace: "docstest" },
  },
};

// NOT self-signed - the identity already exists, signs with its own key.
const namespaceSig = kp.sign(namespaceTxBody);
const namespaceTx = {
  $tx: namespaceTxBody,
  $sigs: { [newStreamId]: namespaceSig },
};

const namespaceResult = await submit(namespaceTx);
```

Real captured response:

```json
{
  "$umid": "9f881d06f4831c802085aac72f59cddc722ea368b52c16630ef9b767f8ad197c",
  "$summary": { "total": 1, "vote": 1, "commit": 1 },
  "$streams": { "new": [], "updated": [{ "id": "77dca3e9475181bf4650224ec13d154c2589914734c2a39502b9357319ed2e0e" }] }
}
```

Note `$streams.updated` rather than `$streams.new` this time — the transaction modified an existing stream (granting it the namespace) rather than creating one. This is the general pattern for every subsequent transaction against an identity you've already onboarded: sign with that identity's own key (`kp.sign(...)`, using the same `KeyPair` instance, or reconstruct one from stored private key material), no `$selfsign`.

### Step 5: what a real failure looks like

Deliberately submitting the namespace transaction again with a broken signature:

```json
{
  "$umid": "c5c53a623094e8b87cda5e8805f23281cd27b23eb5991d45f8a3f10a64903e0e",
  "$summary": {
    "total": 1,
    "vote": 0,
    "commit": 0,
    "errors": ["Input Signature Incorrect - Error c5c53a623094e8b87cda5e8805f23281cd27b23eb5991d45f8a3f10a64903e0e:1787851582537"]
  }
}
```

`vote`/`commit` both `0`, and `$summary.errors` populated — this is the actual failure shape to check for, not the HTTP status code (a rejected transaction still comes back `200 OK`; the failure is only visible inside the body).

## Error reference

Every error a node can return during permission checking, voting, or commit carries a numeric `code`, checked against `v4.1.0`'s source (`permissionsChecker.ts`, `process.ts`, `endpoints.ts`, `streamUpdater.ts`). Not exhaustive — contracts can throw their own arbitrary rejection reasons — but this covers every code the core ledger logic itself raises.

| Code | Reason | What it means |
|---|---|---|
| 950 | Stream(s) not found | A referenced stream (or one of its required companion documents) genuinely doesn't exist. Can also appear transiently during the SPI repair cycle — see [spi.md](spi.md). |
| 1200 | (Input/Output) Stream Position Incorrect | The classic SPI trigger — this node's local revision for the stream doesn't match what the transaction expected. Usually self-heals; see [spi.md](spi.md). |
| 1220 | (Input/Output) Signature Incorrect | The signature in `$sigs` doesn't verify against the stream's authority public key for the exact `$tx` object sent. |
| 1225 | (Input/Output) Incorrect Signature List Length | `$sigs` doesn't have the right number of entries for a multi-signature stream. |
| 1230 | (Inputs/Output) Security Hardened Key Transactions Only | `security.hardenedKeys` is enabled (see [configuration.md](configuration.md)) and the transaction is missing the required `$nhpk` (New Hardened Public Key) on an input. |
| 1401 | Contract Not Found | `$tx.$namespace`/`$tx.$contract` don't resolve to a deployed contract on this node. |
| 1510 | Failed to save streams | The commit phase's actual disk write failed. A storage-layer problem, not a transaction-validity one — see [storage.md](storage.md) if you see this. |
| 1700 | Stream contract locked | The stream has a `contractlock` that doesn't include the contract this transaction is trying to run. |
| 1710 | Stream namespace locked | Same idea as 1700, scoped to namespace rather than a specific contract. |

If you're building a client and want to distinguish "genuinely invalid transaction, don't retry" from "transient, safe to retry" — 1200 (SPI) is the one that resolves itself given time; the others generally won't change on a bare retry with the same transaction.
