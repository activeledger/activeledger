# PHP SDK

The PHP SDK builds, signs and submits Activeledger transactions from PHP, and can submit transactions and read state. It is published on Packagist as `activeledger/sdk` and needs PHP 8.1 or later with the `curl`, `json` and `openssl` extensions. The SDK does not state a minimum Activeledger node version. Its live tests run against a network started from an Activeledger checkout, and the post-quantum key types need a node that accepts `ml-dsa-65` identities (see [Identities](../identities.md)).

It supports two key types: `ml-dsa-65` (post-quantum) and `secp256k1`. It cannot create `rsa` or `falcon-512` identities; see [Signing elsewhere](#signing-elsewhere) for those.

## Install

```bash
composer require activeledger/sdk
```

The only Composer dependency is `paragonie/pqcrypto_compat`, which is pure PHP. The `pqcrypto` extension is optional and makes ML-DSA signing faster when present. The `intl` extension is optional and only matters for non-ASCII recovery-phrase passphrases.

## Quick start

```php
use Activeledger\Client;
use Activeledger\KeyPair;
use Activeledger\Transaction;

$client = new Client('http://localhost:5260');

// Create a post-quantum identity and onboard it.
$key = KeyPair::generate();
$identity = $client->onboard($key);

echo $identity->streamId;

// Keep this. It is the only thing that can restore the identity.
file_put_contents('identity.seed', $key->seedBase64());

// Send a transaction signed by it.
$tx = Transaction::builder()
    ->namespace('default')
    ->contract('mycontract')
    ->input($identity->streamId, $key, ['amount' => 100])
    ->output('someotherstream')
    ->build();

$response = $client->submit($tx);

if (!$response->committed()) {
    print_r($response->errors());
}
```

To restore the identity on a later request:

```php
$key = KeyPair::fromSeedBase64(file_get_contents('identity.seed'));
```

`onboard()` throws a `RuntimeException` unless the reply is a commit (see `committed()` below) and the ledger created a stream. The transaction it sends is described in [Identities](../identities.md); the fields of the ones you build yourself are in [Transactions](../transactions.md).

## Keys

Both key classes implement the `Signer` interface, so either can be passed anywhere a key is needed.

| Class | `keyType()` | Public key | Private key | Signature | Encoding |
|---|---|---|---|---|---|
| `KeyPair` | `ml-dsa-65` | 1952 bytes | 32-byte seed | 3309 bytes | base64 |
| `Secp256k1KeyPair` | `secp256k1` | 33 or 65 bytes | 32 bytes | about 70 to 72 bytes, DER | `0x` hex |

### ml-dsa-65

```php
use Activeledger\KeyPair;

$key = KeyPair::generate();

$key->publicKey();         // base64, 1952 bytes, as the ledger stores it
$key->seedBase64();        // the 32-byte seed, base64. Store this.
$key->canSign();           // true

// Verification only
$verifier = KeyPair::fromPublicKeyBase64($publicKey);
$verifier->verify($message, $signature);   // bool
```

### secp256k1

```php
use Activeledger\Secp256k1KeyPair;

$key = Secp256k1KeyPair::generate();                    // compressed public key
$full = Secp256k1KeyPair::generate(compressed: false);  // uncompressed

$key->publicKey();    // "0x02a1b2..." for the ledger
$key->privateKey();   // "0x..." 32 bytes; works in the other SDKs too

$restored = Secp256k1KeyPair::fromKeys($key->publicKey(), $key->privateKey());  // throws if they do not match
$verifier = Secp256k1KeyPair::fromPublicKey($key->publicKey());
```

A secp256k1 transaction is roughly 22 times smaller than an ML-DSA-65 one (the SDK README's figure), and every signature is stored on the ledger for good. Use it unless the identity has to resist quantum computers. It uses PHP's `openssl` extension, the same implementation the node verifies with. Signatures are always low-S.

`fromKeys()` checks that the public key is the one derived from the private key, and throws `InvalidArgumentException` if the pair does not match, rather than signing with one key while publishing another. Public keys that are not a point on the curve are rejected too (checked through OpenSSL), and the DER signature parser is bounds-checked. The ML-DSA `KeyPair` has no two-key loader; restore it from its seed.

!!! warning
    The private key of an `ml-dsa-65` pair here is a 32-byte seed, not the 4032-byte key the other SDKs export. The underlying library cannot load a 4032-byte key, and the SDK throws if you pass one. It does this deliberately: the library would otherwise accept the bytes as seed material, derive an unrelated identity and sign happily, and the ledger would reject every transaction with `1220 Signature Incorrect`. To move an ML-DSA identity between SDKs, give the other SDK the seed through its seed constructor. secp256k1 private keys move freely in both directions.

Signing is not deterministic in this SDK. ML-DSA signatures are hedged, and OpenSSL uses a random nonce for ECDSA, so signing the same message twice gives different bytes. Verify signatures; never compare them for equality.

## Seeds and recovery phrases

Restore a key from its seed with `fromSeed()`, which takes the raw bytes:

```php
$pq = KeyPair::fromSeed($seed);               // exactly 32 bytes
$ec = Secp256k1KeyPair::fromSeed($seed);      // exactly 32 bytes, a valid scalar
```

A seed of the wrong length is refused, not padded. For secp256k1 the seed is the private scalar, so zero, or a value at or above the curve order, is also refused rather than reduced.

Recovery phrases are BIP-39:

```php
$pq = KeyPair::fromPhrase($phrase);
$ec = Secp256k1KeyPair::fromPhrase($phrase);
$withPassphrase = KeyPair::fromPhrase($phrase, 'my passphrase');
```

One phrase gives a different, independent seed for each key type, so the same phrase can back an `ml-dsa-65` and a `secp256k1` identity. The phrase is checked against the English wordlist and its checksum, and a mistyped phrase throws `InvalidArgumentException`.

`Secp256k1KeyPair::fromLegacyPhrase($phrase)` recovers a key from a phrase made by the older `@activeledger/sdk-bip39` package. Use it for recovery only, never for new keys.

The SDK does not generate new recovery phrases; it only restores keys from ones you already have.

## Sending transactions

`Transaction::builder()` returns a `TransactionBuilder`. `build()` signs the transaction and returns a `Transaction`.

```php
$tx = Transaction::builder()
    ->namespace('default')
    ->contract('mycontract')
    ->entry('transfer')                          // optional: $entry
    ->input($streamId, $key, ['amount' => 100])  // $i, signed by $key
    ->output($otherStream)                       // optional: $o
    ->readonly('label', $someStreamId)           // optional: $r
    ->build();

$response = $client->submit($tx);
```

| Method | Sets | Notes |
|---|---|---|
| `namespace()` | `$namespace` | Required. |
| `contract()` | `$contract` | Required. |
| `entry()` | `$entry` | Left out if not called. |
| `input($streamId, $signer, $payload = [])` | `$i` | At least one is required, and each one is signed by the `Signer` you pass. |
| `output($streamId, $payload = [])` | `$o` | Left out if none are added. |
| `readonly($label, $streamId)` | `$r` | Left out if none are added. |

`build()` throws a `LogicException` if the namespace, the contract or every input is missing. There is no method for `$expire`, so the builder cannot set it; see [Transactions](../transactions.md) for why you might want it.

`submit()` returns a `LedgerResponse`:

| Method | Returns |
|---|---|
| `committed()` | `true` only when `errors()` is empty: the HTTP status is 2xx, the body is a JSON object with a `$summary` object, and the node reported no errors |
| `errors()` | the messages from `$summary.errors`, or, if there are none, what the SDK found wrong with the reply |
| `newStreams()` | the ids of streams the transaction created |
| `responses()` | the values contracts returned, from `$responses` |
| `decoded()` | the whole reply as an array, or `null` if it was not a JSON object |
| `raw()` | the reply body exactly as the node sent it |

`submit()` throws a `RuntimeException` on a transport failure. `submitRaw()` reads the HTTP status from curl and does not follow redirects, so a 3xx reply is an error, not a commit.

An empty body, a body that is not JSON, a JSON array or scalar, `{}`, and any object without a `$summary` object are all not committed. `errors()` says why, with entries such as `Response body is not a JSON object`, `Response has no $summary object` and `HTTP status 302`. You can build a `LedgerResponse` yourself from a body and an optional status: `new LedgerResponse($body, 200)`.

!!! warning
    `new LedgerResponse($body)` without a status cannot check it, so only the body is judged. Pass the status if you have one.

Earlier versions treated any reply without errors as committed, including an empty or non-JSON one. This change is unreleased at the time of writing, so check the version you have installed. The `Client` constructor takes a timeout in seconds as its third argument; the default is 30. `submitRaw($json)` sends an envelope you built yourself.

To see exactly what was signed, which is the quickest way to diagnose a rejected signature:

```php
$tx->signedBytes();   // the $tx object alone
$tx->toJson();        // the full envelope, as submitted
```

## Reading state

The SDK has no read call. Reading is a transaction: name the streams in `$r` with `readonly()`, and the contract returns values to you.

```php
$tx = Transaction::builder()
    ->namespace('default')
    ->contract('mycontract')
    ->entry('read')
    ->input($identity->streamId, $key)
    ->readonly('target', $streamToRead)
    ->build();

foreach ($client->submit($tx)->responses() as $value) {
    echo $value['balance'];
}
```

What comes back is whatever the contract chooses to return, and `responses()` has one value per node that returned something. The shape above (`balance`) is only an example; it depends on your contract.

## Events

`Client::subscribeToActivity`, `subscribeToContractEvents`, `subscribe` and `LedgerEvent` are deprecated and will be removed in the next major version. Activecore is deprecated and no longer serves events. A node serves contract events only from its own storage service, which must never be reachable beyond the node's host, so a client SDK has nothing to connect to.

To react to events, run your own server-sent events listener on the node's host and relay what you need through your own backend. Each frame has an `id` of `<ms>-<counter>,<umid>` and `data` of `{name,data,phase,contract}`. See [The HTTP API](../api.md#events-get-activeledgereventsevents).

## Signing elsewhere

Everything that signs goes through the `Signer` interface, so keys can live in an HSM, a remote signing service or a wallet. This is also how you sign with an `rsa` or `falcon-512` identity, since the SDK has no key class for them but `KeyType` includes both.

```php
use Activeledger\KeyType;
use Activeledger\Signer;

final class HsmSigner implements Signer
{
    public function keyType(): KeyType
    {
        return KeyType::MlDsa65;
    }

    public function publicKey(): string
    {
        return $this->hsm->publicKeyBase64();
    }

    public function sign(string $message): string
    {
        return $this->hsm->sign($message);
    }
}
```

`sign()` receives the canonical bytes of `$tx` and returns the raw signature; the SDK base64-encodes it. `publicKey()` must return the key in the form the ledger stores for that type: base64 for the post-quantum types, `0x` hex for `secp256k1`. `$this->hsm` above stands for your own client and is not part of the SDK.

The `KeyType` enum has the cases `Rsa`, `Secp256k1`, `MlDsa65` and `Falcon512`. `KeyType::fromWire()` is strict and case-sensitive, and also accepts `bitcoin` and `ethereum` as `secp256k1`.

## Things that will bite you

!!! warning
    **A rejected transaction is an HTTP 200.** The node reports the failure in the body. Check `$response->committed()`, not the HTTP status. `submit()` does not throw for a rejected transaction, or for a non-2xx status or a non-JSON body; those come back as a `LedgerResponse` that is not committed.

- **Every signature problem is reported as `1220 Signature Incorrect`.** A wrong key type, the wrong key material and truly bad bytes all give that one message. Look at `$tx->signedBytes()` first.
- **Signatures cover exact bytes.** PHP's `json_encode` escapes `/` as `\/` and non-ASCII as `\uXXXX`, which changes the bytes, so the SDK uses its own serialiser, `CanonicalJson`. Array order is insertion order, and that order is what is signed. Do not edit the body after `build()`.
- **`[]` is both an empty array and an empty object in PHP.** Where JSON needs `{}`, use `CanonicalJson::object()`. The builder and `Transaction::onboard()` already do this for `$i`, `$o` and `$sigs`; it matters only if you write your own envelopes.
- **Whole-number floats print as integers.** `1.0` is serialised as `1`, as JavaScript does. `NAN` and `INF` are refused.
- **Namespaces are claimed for good.** A test that registers a fixed namespace passes once and then fails on every re-run against the same network.
- **Consensus is a majority.** When `submit()` returns, most nodes have committed and the rest may still be writing, so reading straight away from one particular node can race.
- **A seed cannot be recovered from a key you only hold as 4032 bytes.** Keep the seed, or the phrase, from the day you create an ML-DSA identity.

## Testing and further reading

```bash
composer install
vendor/bin/phpunit --testsuite unit
```

The unit suite needs no network. The `live` suite needs a running ledger and reads `AL_NODES` and `AL_STORAGE` from the environment; the docblock of `tests/LiveNetworkTest.php` shows how (`npm run test:network:serve` in an Activeledger checkout).

- Source, issues and README: <https://github.com/activeledger/SDK-PHP>
- Package: <https://packagist.org/packages/activeledger/sdk>
