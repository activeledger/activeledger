# Activerestore

This is ran as a separate application from Activeledger. This application is used to correct any data which is modified outside of consensus and also used to rebuild the entire ledger if required.

When using CouchDB as your storage engine this process requires the correct permissions to the file location of the CouchDB instance.

## Full Rebuild

To run a full rebuild you run restore with the --full flag. This can be along running process but it when it reaches the end it will stop execution and then you can run the restore application without the flag and it will listen and check on errors.

## Which Copy Wins

Restore reads `consensus.reached` from the `config.json` in the directory it runs from. Without it there is no majority to take and a full restore restores nothing; it logs an error saying so.

Restore asks every neighbour for each stream it holds and keeps the revision most of them agree on. It counts votes the way the transaction-time repair (SPI) does:

* one vote per node per stream;
* a node that cannot answer, because the stream is busy in a transaction, abstains rather than vetoes;
* a revision must reach the `consensus.reached` percentage of the neighbours **and** be held by more nodes than could not report, so nothing unseen could overturn it.

When no revision reaches that, the stream is left alone and reported, not overwritten. Restore only adds what this node is missing or repairs a copy the network agrees on.

## Contracts

When restore finds a contract stream it rebuilds the compiled contract files in `contracts/[namespace]/` for every version, from the source in the stream or the deploy transaction it points to. A version whose source cannot be found (a hash-only entry whose deploy transaction this node does not hold) is reported as a warning and skipped; the rest of the restore carries on.

Contract locks are restored too, from the `locks` the contract stream carries (see [Locking and Unlocking a Contract](contracts/deployment/upgrade.md)). Locks made by a `lock` entry that did not name the contract stream as its output, and locks made before 5.1.0, are only files and cannot be restored.


## Going easy on the network

A full restore asks the same nodes that are taking transactions, so it goes one stream at a time and pauses between them. It pauses 5ms before each stream and a further 200ms after every 100 streams, and it backs off while the neighbours are slow to answer (a fetch over 400ms doubles the pause, up to 5s) and eases back once they are not. On a small local network that is about 100 documents a second, against about 530 with no throttle.

A stream the node already holds at the revision the network agreed on is not fetched at all. A contract stream it holds still has its files rebuilt, from the local copy.

Change it in the `restore` section of the `config.json` restore runs from:

```json
"restore": {
  "throttle": { "pauseMs": 5, "batch": 100, "batchPauseMs": 200, "slowMs": 400, "maxBackoffMs": 5000 }
}
```

`"throttle": false` turns it off, as does `activerestore --full --fast`. Use that for a node that is not serving anything.

Volatile data is for one node only, so a restore never copies or creates it.
