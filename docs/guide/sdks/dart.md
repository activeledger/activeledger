# Dart SDK

The Dart SDK is for Dart and Flutter apps. It is a port of the JavaScript SDK and ships as two packages: `activeledger`, which holds everything (keys, onboarding, transactions, payload signing), and `activeledger_falcon`, an optional add-on that enables Falcon-512 keys. It needs Dart 3.10 or later, and Activeledger 4.7.0 or later if you use the `ml-dsa-65` or `falcon-512` key types. Both packages are published on pub.dev at version 1.0.0.

Key files, seeds and signatures are byte-compatible with the JavaScript SDK, so a key made in one can be used in the other. For what the fields below mean, see [Sending a transaction](../transactions.md) and [Identities](../identities.md).

## Install

```bash
dart pub add activeledger
```

For Flutter, use `flutter pub add activeledger`. To use Falcon-512 as well, add the add-on:

```bash
dart pub add activeledger_falcon
```

The add-on is backed by liboqs. Its native libraries are bundled and downloaded by Dart's build hooks, for Android, iOS, macOS, Linux and Windows. You do not need `activeledger_falcon` for secp256k1 or ML-DSA-65, which are pure Dart.

`activeledger_falcon` re-exports `package:activeledger`, so with the add-on one import is enough.

## Quick start

Start a node first (the default port is 5260). Then:

```dart
import 'package:activeledger/activeledger.dart';

Future<void> main() async {
  final ledger = Activeledger('http://localhost:5260');

  final key = ledger.generateKey('identity', type: KeyType.mlDsa65);
  await ledger.onboard(key);
  print(key.identity); // the new identity's stream id

  final tx = ledger.transactions.labelledTransaction(
    key: key,
    namespace: 'default',
    contract: 'namespace',
    inputLabel: key.identity!,
    stream: key.identity!,
    inputData: {'namespace': 'example'},
  );

  final response = await ledger.send(tx);
  print(response.committed ? 'Committed ${response.umid}' : response.errors);

  await ledger.close();
}
```

`Activeledger` bundles a `Connection` and the three handlers (`keys`, `transactions`, `payloads`). You can also use `KeyHandler`, `TransactionHandler`, `PayloadHandler` and `Connection` on their own.

## Keys

| `KeyType` | Wire string | Public key | Private key | Signature | Encoding |
|---|---|---|---|---|---|
| `secp256k1` | `secp256k1` | 33 or 65 bytes | 32 bytes | about 70 to 72 bytes, varies | `0x` hex |
| `mlDsa65` | `ml-dsa-65` | 1952 bytes | 4032 bytes | 3309 bytes | base64 |
| `falcon512` | `falcon-512` | 897 bytes | 1281 bytes | 649 to 662 bytes, varies | base64 |
| `rsa` | `rsa` | PEM | PEM | 256 bytes for 2048-bit | PEM |

`generateKey` defaults to `KeyType.secp256k1`. Pass `compressed: true` for a 33-byte secp256k1 public key. RSA is for legacy identities only: an existing PEM key can sign and verify, but the SDK cannot generate one.

```dart
final keys = KeyHandler();

final ec = keys.generateKey('me');                         // secp256k1
final pq = keys.generateKey('me', type: KeyType.mlDsa65);
```

A `Key` has `name`, `type`, `key` (the pair, as `key.key.publicKey` and `key.key.privateKey`), `identity` (null until onboarded) and `phrase`. `Key` also has a `publicKey` shortcut. The private key is the secret; keep it out of logs.

Falcon-512 needs the add-on. Call `ActiveledgerFalcon.enable()` once at startup:

```dart
import 'package:activeledger_falcon/activeledger_falcon.dart';

final enabled = ActiveledgerFalcon.enable(); // true if the native library loaded
final key = KeyHandler().generateKey('identity', type: KeyType.preferredPostQuantum);
```

`enable()` loads liboqs, runs a sign-and-verify self-test and registers the scheme. It returns `false` if the library cannot load (pass `throwOnFailure: true` to throw instead, or read `ActiveledgerFalcon.failure`). `KeyType.preferredPostQuantum` is Falcon-512 when enabled and ML-DSA-65 otherwise, so the same code runs either way. Asking for `KeyType.falcon512` without enabling it throws `KeyTypeUnavailableException`.

Save and load keys in the JavaScript SDK's file format:

```dart
await keys.exportKey(key, 'keys', createDir: true); // writes keys/<name>.json
final loaded = await keys.importKey('keys/identity.json');
```

`exportKey` refuses to overwrite unless you pass `overwrite: true`. The file contains the private key, so store it accordingly. (These two use `dart:io` and fail on the web; the rest of the SDK does not.)

`importKey` (and `Key.fromJson`) checks that the public key belongs to the private key, and throws a `FormatException` if not. For secp256k1 it derives the public key and compares; for ML-DSA-65 it signs and verifies a probe message. Falcon-512 is checked the same way when the add-on is enabled. RSA pairs are not checked. A mismatched pair would otherwise sign happily and only fail at the node, as `1220 Signature Incorrect`.

A secp256k1 public key must be a real point on the curve. The SDK rejects points that are off the curve, have a coordinate at or above the field prime, or are the point at infinity, in both the compressed and uncompressed encodings. Verifying against such a key returns `false`.

## Seeds and recovery phrases

```dart
final key = keys.generateBip39Key('me', type: KeyType.mlDsa65);
print(key.phrase); // 12 words; store them

final same = keys.restoreBip39Key('me', key.phrase!, type: KeyType.mlDsa65);
final withPass = keys.restoreBip39Key('me', key.phrase!, passphrase: 'extra');

final fromSeed = keys.generateKeyFromSeed('me', seed, type: KeyType.mlDsa65);
```

`generateKeyFromSeed` takes the algorithm's own seed as a `Uint8List`, with no key derivation applied: 32 bytes for secp256k1 and ML-DSA-65, 48 for Falcon-512. The same seed gives the same identity in every Activeledger SDK. A seed of the wrong length is refused, not padded.

One phrase can back a key of each type; each type derives its own seed from it. `Recovery` exposes the steps: `generateMnemonic`, `validate`, `toSeed`, `deriveSeed` and `deriveBip32MasterKey`.

!!! warning
    `restoreBip39Key` checks the phrase's wordlist and checksum and throws `ArgumentError` if it fails. Pass `validate: false` only for a string that is not a mnemonic. An unchecked typo derives a valid key for an identity nobody owns.

`legacy: true` recovers a phrase made by the old `@activeledger/sdk-bip39` package (SHA-256 of the phrase, secp256k1 only). Use it to recover, never for new keys.

## Sending transactions

Onboarding is `onboard`, shown above. It sets `key.identity` and throws `OnboardException` if the reply is not committed or the node created no stream.

For a transaction with one input signed by one key, use `labelledTransaction`:

```dart
final tx = ledger.transactions.labelledTransaction(
  key: key,                     // must be onboarded
  namespace: 'mynamespace',
  contract: 'mycontract',       // the contract's stream id
  inputLabel: 'input',
  stream: key.identity!,
  inputData: {'message': 'hello'},
  entry: 'update',              // optional $entry
  outputs: {'target-stream': <String, Object?>{}},   // optional $o
  readonly: {'prices': 'stream-id'},                 // optional $r
);

final response = await ledger.send(tx);
if (!response.committed) throw Exception(response.errors);
print(response.streams.created); // List<StreamRef>
```

`$stream` is added to the input for you. For anything else (several inputs, several signers, `$expire`), build the `$tx` yourself and sign once per key:

```dart
final tx = Transaction(tx: {
  r'$namespace': 'mynamespace',
  r'$contract': 'mycontract',
  r'$i': {alice.identity!: {'amount': 5}, bob.identity!: {}},
  r'$expire': DateTime.now().add(const Duration(minutes: 5)).toUtc().toIso8601String(),
});
ledger.transactions.signTransaction(tx, alice);
ledger.transactions.signTransaction(tx, bob);
await ledger.send(tx);
```

`signTransaction` keys `$sigs` by the key's identity (or by name if it has none). `labelledTransaction` and `signTransaction` also take `selfsign` and `selfSignLabel` for the self-signed path used when onboarding.

`$expire` is worth setting on anything you might retry; see the warning in [Sending a transaction](../transactions.md).

`LedgerResponse` has `committed`, `errors`, `umid`, `summary` (`total`, `vote`, `commit`), `streams` (`created`, `updated`), `responses`, `debug` and `raw` for the decoded JSON. `ledger.send` is `connection.sendTransaction`, which also accepts a plain map or a JSON string.

`committed` is true only when the reply has a `$summary` object and its `errors` are absent or an empty list. An empty `{}` body, a reply with no `$summary`, or an `errors` value that is not a list (which `errors` reports as text) is not committed. It does not look at `commit`. The accessors do not throw on a wrongly typed field: they return `null`, an empty list or an empty summary instead, and `raw` holds whatever arrived.

## Reading state

There is no read or storage endpoint in this SDK, because a node's storage service listens only on the node's own host. Read state through a transaction: name the streams in `readonly` (`$r`), and have the contract return values with `returnToRemote`. They arrive in `response.responses`.

```dart
final tx = ledger.transactions.labelledTransaction(
  key: key,
  namespace: 'mynamespace',
  contract: 'mycontract',
  inputLabel: 'input',
  stream: key.identity!,
  readonly: {'prices': 'stream-id'},
);
final response = await ledger.send(tx);
print(response.responses); // List<Object?>
```

## Events

This SDK has no events client, by design. A node serves contract events from its storage service, which must not be exposed beyond the node's host, so a mobile or desktop app cannot and should not connect to it. To react to events, run a listener on the node's host and relay what your app needs through your own backend.

## Signing elsewhere

Every handler, and the `Activeledger` constructor, takes a `crypto:` argument of type `CryptoProvider`. Implement it (`generate`, `generateFromSeed`, `sign`, `verify`) to sign in an HSM or secure enclave without changing anything else:

```dart
final ledger = Activeledger('http://localhost:5260', crypto: MyEnclaveCrypto());
```

To supply only a post-quantum algorithm, implement `PostQuantumScheme` and call `PostQuantum.register(scheme)`. That is how `activeledger_falcon` works.

To sign something that is not a transaction, use `PayloadHandler`:

```dart
final signature = ledger.payloads.sign({'pair': 'VNR/USDT', 'side': 'sell'}, key);
final ok = ledger.payloads.verify(order, signature, key.publicKey, type: key.type);
```

`verify` returns `false` for a malformed signature rather than throwing. `payloads.canonical(order)` returns the exact string that is signed.

## Things that will bite you

!!! warning
    A rejected transaction is HTTP 200. `sendTransaction` throws `LedgerHttpException` for a non-2xx status, and `ActiveledgerException` for a 2xx body that is not a JSON object (including a body that is not JSON at all). It does not throw for a rejection. Always check `response.committed`.

- **Signature errors are vague.** A wrong type string, a wrong-length key or signed bytes differing by one character all come back as `1220 Signature Incorrect`. `tx.signedString` is exactly what was signed; compare it with what another implementation signed.
- **Key order matters.** Signatures cover `canonicalJson($tx)` and the node does not sort keys. If you change `tx.tx` after signing, sign again. For payloads, persist `payloads.canonical(...)` with the signature and verify that.
- **Use `canonicalJson`, not `jsonEncode`.** Dart's `jsonEncode` differs from JavaScript's `JSON.stringify` on numbers (`1.0` against `1`). `canonicalJson` matches JavaScript, and refuses `NaN`, infinities and integers a JavaScript number cannot hold exactly.
- **The type is always sent.** The ledger treats a missing `type` as `rsa`. The SDK sends it every time; do the same if you hand-build an envelope.
- **Post-quantum signatures are randomised.** Two signatures over the same message differ and both verify. Falcon signature length varies, so never assume a fixed width.
- **Falcon needs enabling.** Forgetting `ActiveledgerFalcon.enable()` gives `KeyTypeUnavailableException`, or a silent fall back to ML-DSA-65 if you used `preferredPostQuantum`.
- **Falcon seeded generation.** liboqs has no seeded key generation, so deriving a Falcon key from a seed or phrase points liboqs's random source at the seed for the duration of the call. That source is process-wide, so do not run other liboqs operations on other isolates at the same moment.
- **Close the client.** `ledger.close()` releases the HTTP client.

## Testing and further reading

From a checkout of the SDK, run the tests from inside each package directory:

```bash
dart pub get
cd packages/activeledger && dart test
cd ../activeledger_falcon && dart test
```

The tests check canonical JSON, signatures and seed derivation against the JavaScript SDK's cross-language vectors. Integration tests in `test/integration` need a running network and are set up through the `AL_NODES` and `AL_STORAGE` environment variables; see the package README.

Source, issues and the package READMEs: [github.com/activeledger/SDK-Dart](https://github.com/activeledger/SDK-Dart).
