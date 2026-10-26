# Version Upgrade of a Smart Contract  

Activeledger supports versioning of smart contracts. When running a contract you can choose either a specific version or always run the latest.

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$entry":"update",
    "$i":{
      "[identity stream]":{
        "version":"0.0.2",
        "namespace":"[your namespace]",
        "name":"[contract name]",
        "contract":"[base64 string of typescript contract]"
      }
    },
    "$o":{
      "[contract stream]": {
      }
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```


## Retiring Old Versions

A version stays callable with `$contract: "[contract stream]@[version]"` after a newer one is deployed. To stop that, lock it. An `update` can lock the versions it replaces in the same commit as the new version, by adding a `lock` property to its input:

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$entry":"update",
    "$i":{
      "[identity stream]":{
        "version":"0.0.3",
        "namespace":"[your namespace]",
        "name":"[contract name]",
        "contract":"[base64 string of typescript contract]",
        "lock":["0.0.1","0.0.2"]
      }
    },
    "$o":{
      "[contract stream]": {}
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```

`lock` is either `"all"`, which locks every other version the contract has, or an array of version names. The transaction is refused, and nothing is locked, when:

* a name in the array is not a version of the contract;
* the array contains the version being deployed (a version is never locked by its own update);
* `lock` is neither `"all"` nor an array of strings, or the array holds more than 1000 names;
* the network build is below `40300`. Raise `build` only once every node is upgraded, so no node ignores a lock another one honours.

A locked version is refused at run time with `Contract Version Lock [version]`. The check runs every time a contract is resolved, so a node that has already run the version stops accepting it straight away.

## Locking and Unlocking a Contract

The `lock` and `unlock` entries lock a single version, or the whole contract, without deploying anything. They are sent by an identity in the contract's namespace.

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$entry":"lock",
    "$i":{
      "[identity stream]":{
        "namespace":"[your namespace]",
        "contract":"[contract stream]",
        "version":"0.0.1"
      }
    },
    "$o":{
      "[contract stream]": {}
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```

* `version` names the version to lock. An empty string, `"version": ""`, locks the whole contract: no version of it can be called until it is unlocked.
* `unlock` takes the same input and removes the lock. It is refused when the lock is not held, and `lock` is refused when it already is.
* Name the contract stream as the only output (`$o`), as above. From build `40300` that records the lock on the contract stream, which is what lets [activerestore](../../restore.md) put it back. Without the output the lock is still honoured, but only as a file on each node, and a node restored from the ledger will not have it. An output that is not a contract of the namespace is refused.

## Where Locks Are Kept

Each node holds a lock as an empty file beside the contract's compiled code, in `contracts/[namespace]/`:

| File | Locks |
| ---- | ----- |
| `_LOCK.[contract stream]` | every version of the contract |
| `_LOCK.[contract stream]@[version]` | one version |

From build `40300` the same locks are also written to the contract stream's state, as `locks: { "all": true, "versions": ["0.0.1"] }`. A lock counts as held if either the file or the state has it, so a node that lost its files still agrees with the others. Locks made before 5.1.0 are not in the state and are not restored.
