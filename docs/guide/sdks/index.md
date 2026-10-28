# SDKs

An SDK lets your own code create keys, sign transactions and send them to a node, without you building the JSON and signing it by hand. There is one for each of the languages below. They follow the same design, so what you learn in one carries over to the others.

An SDK is a client. It does not run a node; for that see [Install](../install.md).

## Choosing one

Use the language your application is written in. The table shows what each needs and which key types it can sign with.

| Language | Install | Needs | Key types you can generate |
|---|---|---|---|
| [JavaScript / TypeScript](js.md) | `npm install @activeledger/sdk-node` (Node) or `@activeledger/sdk-web` (browser, React Native) | Node 20.19+ for post-quantum keys | `secp256k1`, `ml-dsa-65`, `falcon-512` |
| [Python](python.md) | `pip install activeledger` | Python 3.9+ | `secp256k1`, `ml-dsa-65`, `falcon-512` (extras) |
| [Go](go.md) | `go get github.com/activeledger/SDK-Golang/v2@latest` | Go 1.25 | `secp256k1`, `ml-dsa-65` |
| [JVM (Kotlin and Java)](jvm.md) | `io.github.activeledger:activeledger:1.0.0` | JDK 11, Android minSdk 26 | `secp256k1`, `ml-dsa-65`, `falcon-512` |
| [C# / .NET](csharp.md) | `dotnet add package Activeledger.SDK` | netstandard2.0 or net8.0 | `secp256k1`, `ml-dsa-65`, `falcon-512` |
| [Rust](rust.md) | `activeledger = "2"` | Rust 1.88 | `secp256k1`, `ml-dsa-65` |
| [PHP](php.md) | `composer require activeledger/sdk` | PHP 8.1 | `secp256k1`, `ml-dsa-65` |
| [Dart](dart.md) | `dart pub add activeledger` | Dart 3.10 | `secp256k1`, `ml-dsa-65`, `falcon-512` (add-on package) |
| [Swift](swift.md) | Swift Package Manager, from the GitHub repository | Swift 5.9 | `secp256k1`, `ml-dsa-65`, `falcon-512` (add-on package) |

!!! note
    This table is a summary. Each language page has the exact install steps, versions and limits; check there before you rely on a row.

Every SDK reports that the post-quantum key types (`ml-dsa-65` and `falcon-512`) need Activeledger 4.7.0 or later on the node.

## What is the same everywhere

See [Concepts shared by every SDK](concepts.md). The language pages follow the same order: install, quick start, keys, seeds, transactions, reading state, events, signing elsewhere, and things that will bite you.

## Source and issues

Each SDK lives in its own repository under [github.com/activeledger](https://github.com/activeledger), named `SDK-` followed by the language. Report problems there.
