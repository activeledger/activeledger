# Deploy, update, lock and unlock

How to put a contract on the network, replace it with a new version, and stop a version (or the whole contract) from running. All of these are transactions to the built-in `contract` contract in the `default` namespace. The examples deploy the notebook from [Writing a contract](write.md), saved as `notebook.ts`.

## Before you start

You need an identity that owns a namespace (see [Identities](../identities.md)). Only that identity can deploy into the namespace, and only to a node that is part of the network. A hybrid never accepts a deploy: its answer is `default/contract is not accepted by a hybrid`.

Every transaction below is signed by that identity and sent the way [Sending a transaction](../transactions.md) describes. The examples show only the `$tx` part; `<identity>` is the identity's stream id.

Contract and namespace names are lowercased when they are stored.

## Versions

A contract has a name and one or more versions. Each version is the source you sent, compiled once by every node and kept as a file. A transaction that names the contract runs its highest version; a transaction can also pin an older one (see [Running a contract](run.md)). Use dotted numbers such as `0.0.1`, `0.1.0`, `1.0.0`: versions are sorted number by number, so `0.0.10` is newer than `0.0.9`.

## Deploy a contract

Send the TypeScript source as base64 in the `contract` field.

```json
{
  "$namespace": "default",
  "$contract": "contract",
  "$i": {
    "<identity>": {
      "version": "0.0.1",
      "namespace": "myorg",
      "name": "notebook",
      "contract": "<base64 of notebook.ts>"
    }
  }
}
```

To make the base64:

```sh
base64 -w0 notebook.ts
```

Every node checks the source before voting yes. Code that reaches outside the contract (for example `process`, `fs`, `require` of anything but `@activeledger/activecontracts` and `@activeledger/activetoolkits`) is refused with `Security Violation [line:column]: ...`, and nothing is deployed.

The result carries the contract's stream id. Keep it: it is how you run, update and lock the contract. On a 3-node network:

```json
{
  "$umid": "...",
  "$summary": { "total": 2, "vote": 2, "commit": 1 },
  "$streams": {
    "new": [{ "id": "<contract stream id>", "name": "contract.myorg.notebook@0.0.1" }],
    "updated": []
  }
}
```

`total`, `vote` and `commit` are node counts, explained in [Sending a transaction](../transactions.md#reading-the-reply). If `errors` appears in `$summary`, the deploy did not happen; the messages say why (`Invalid Namespace` means the identity does not own that namespace).

Each node writes the compiled code to `contracts/<namespace>/<stream id>.js` (the latest version) and `contracts/<namespace>/<stream id>@<version>.js`. The contract's stream records every version it has.

## Update to a new version

Make a small change to the notebook so there is something to deploy: have `read()` say it is version `0.0.2` and count the notes. Only the `read` method changes.

```diff
   public read(): any {
-    return { version: "0.0.1", notebook: this.getReadOnlyStream("nb") };
+    const notebook = this.getReadOnlyStream("nb");
+    return { version: "0.0.2", notebook, count: (notebook.notes || []).length };
   }
```

An update is the same transaction as a deploy with `$entry: "update"`, a new version, and the contract's stream id as the only output in `$o`.

```json
{
  "$entry": "update",
  "$namespace": "default",
  "$contract": "contract",
  "$i": {
    "<identity>": {
      "version": "0.0.2",
      "namespace": "myorg",
      "name": "notebook",
      "contract": "<base64 of the changed notebook.ts>"
    }
  },
  "$o": { "<contract stream id>": {} }
}
```

The reply has the same shape as a deploy. The old version stays and can still be pinned; the new one becomes the latest, so a read of a notebook now answers with `"version": "0.0.2"` (see [Running a contract](run.md#read-without-changing-anything)). Give each update a version you have not used before.

`security.deploy.enforceContractOwnership: true` in `config.json` limits updates to the identity that first deployed the contract. `security.deploy.allowlist` (a list of identity stream ids) limits every deploy, update and lock to those identities. Both are off by default.

## What a lock is for

A lock stops a version from running. Use it when a version has a bug, or when you have replaced it and do not want anyone pinning the old one. A locked version is still in the ledger; unlocking it brings it back. Locking the whole contract stops every version.

A transaction that hits a lock fails with `Init Contract Error - Contract Version Lock 0.0.1` (or `Contract Global Lock`) in `$summary.errors`.

## Lock old versions in an update

Add `lock` to the update: `"all"` locks every other version the contract has, or list the versions by name.

```json
"$i": {
  "<identity>": {
    "version": "0.0.3",
    "namespace": "myorg",
    "name": "notebook",
    "contract": "<base64>",
    "lock": ["0.0.1", "0.0.2"]
  }
}
```

The new version and the locks land in the same commit. The update is refused if `lock` names the version being deployed, a version the contract does not have (`Cannot lock unknown version 9.9.9`), or anything but `"all"` or an array of strings.

## Lock or unlock one version

```json
{
  "$entry": "lock",
  "$namespace": "default",
  "$contract": "contract",
  "$i": {
    "<identity>": {
      "namespace": "myorg",
      "contract": "<contract stream id>",
      "version": "0.0.1"
    }
  },
  "$o": { "<contract stream id>": {} }
}
```

`$entry: "unlock"` with the same body removes it. Locking a version that is already locked fails with `Lock already exists`; unlocking one that is not fails with `Lock doesn't exists`.

## Lock or unlock the whole contract

Send the same `lock` or `unlock` transaction with `"version": ""`. The field must be present, even though it is empty.

## Why `$o` is the contract stream

From build 40300, a lock is a file on each node and, with the contract's stream as the only output, is also recorded on the contract stream itself under `locks`, so a node that loses its files gets the locks back when it is restored (see [Restoring a node](../operate/restore.md)). After locking version `0.0.1` the stream holds `"locks": { "versions": ["0.0.1"] }`; `"all": true` is added only by a whole-contract lock. The output must be that one stream and no other: anything else is refused with `A lock output must be the contract stream`.

A lock sent without `$o` still works, but as files only. Below 40300 the output is ignored and the lock is a file only, with no `locks` field on the stream.

## Build levels

Some of the above depends on the `build` value in each node's `config.json` (see [Nodes](../operate/nodes.md)). Raise it only once every node runs a release that supports it, or nodes will write different state for the same transaction.

| Build | What it turns on |
|---|---|
| `40100` | A contract stream records a reference to the deploy transaction and a hash of the source, instead of a copy of the source. |
| `40300` | `lock` in an update, and locks recorded on the contract stream. Below it an update with `lock` is refused with `Locking versions on update needs build 40300`. |

## Give a contract a name to run by

A link is a label that points at a contract. Transactions can then use the label instead of the stream id.

```json
{
  "$entry": "link",
  "$namespace": "default",
  "$contract": "contract",
  "$i": {
    "<identity>": {
      "namespace": "myorg",
      "contract": "<contract stream id>",
      "link": "notebook"
    }
  }
}
```

`$entry: "unlink"` removes it. A label always runs the contract's latest version. Labels are lowercased; a label already in use in the namespace is refused with `Link already exists`.

## Next

- [Running a contract](run.md) to create a notebook and read it back.
