# Activeledger Changelog

## [2.13.5]

### New
* **Network** : $expire transaction check. Transaction cannot enter the network if expired.

### Fix
* **Utilities** : Request resent if reused socket connection closed.
* **Network** : Returns early if pending expected but has already been resolved.

## [2.13.4]

Emergency Patch - Under specific circumstances return statement closed the server

## [2.13.3]

### New
* **Network** : Dynamic Network Intervals - Connection timing based on current network status.

### Fix
* **Utilities** : Non 2XX errors return the error url in the payload.
* **Protocol** : Single stored database error now always returned instead of null.
* **Network** : Improved Error Handling for when processes are refreshed.

## [2.13.2]

### New
* **Activeledger** : Ability to un/lock contracts from executing globally or specific versions.

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "contract",
        "$entry": "lock or unlock",
        "$i": {
            "Contract Stream Identity": {
                "namespace": "Namespace",
                "contract": "Contract Id",
                "version": "Empty or version specific eg 1.1.9"
            }
        }
    }
}
```

### Fix
* **Activeledger CLI** : Another database auto start issue. Where a falsy value was triggering incorrectly.
* **Restore** : Not all transactions will have $rev this is now skipped instead of causing a crash.

## [2.13.1]

### Fix
* **Activeledger CLI** : --version doesn't generate .identity file anymore.
* **Activeledger CLI** : Database auto starting works as expected (no longer attempts to start when config is false)

## [2.13.0]

### New
* **Activeledger CLI** : --version or -v shows application version.

### Fix
* **Contracts** : When fetching volatile that is missing or invalid show a better error output.
* **Network** : Prevents and manages sub processes from crashing and restarts if needed.

## [2.12.5]

### New
* **Activeledger CLI** : Ability for a single host to run the database and ledger as seperate processes.

### Fix
* **Network / Protocol** : Further unhandledRejections handling improvements.


## [2.12.4]

### Fix
* **Network / Protocol** : Handles unhandledRejections better and returns the standard payload with contract errors if applicable. (No more 500 return payloads).

## [2.12.3]

### Fix
* **Crypto** : Import incorrectly assumed 02 03 04 would always be public. Switched to more relilable hex length+2 private keys are 64 vs public 66.

## [2.12.2]

### Feature
* **Protocol** : Database Error id appended to transaction error response
* **Protocol** : Contract execution error now return the code line that generated the error (Debug Only)

### Fix
* **Network** : Identities can appear in both $i/$o of a single transaction (Not Recommended, Specific use cases only).
* **Protocol** : Contract Id name no longer being incorrectly trimmed.

## [2.12.1]

### Fix
* **Protocol** : Prevents returning "Stream not found" for when a duplicate stream is found within the same i/o group.

## [2.12.0]

### Feature
* **Protocol** : Added functionality that allows a contract to store localised data linked to the stream ID of the contract so it has access to it for every transaction. 
* **Contract** : Added setContractData() and getContractData() to stream.ts to access the localised contract data.

## [2.11.8]

### Feature
* **Protocol** : Transaction level enforce 100% node coverage. Use $unanimous at the transaction root.

## [2.11.7]

### Feature
* **Core** : Allow Core to create Volatile Memory.

## [2.11.6]

### Fix
* **Crypto** : 0x prefix adding correctly to all public key instances.

## [2.11.5]

### Fix
* **Crypto** : Add compressed Public EC Support

## [2.11.3]

### Read Only Fix
* **Protocol** : Read Only doesn't require signatures and this resolves the issue of assumed signatures exist.

## [2.11.2]

### Prefix Fix
* **Protocol** : Converts any siganture references with prefixes to normal size so access to authorities is working again.

## [2.11.1]

### Storage Fix
* **Storage** : Self host database now has internal counters preventing runaway restarts for unexpected errors.

## [2.11.0]

### Security Fix
* **Protocol** : vm2 security dependency updated. Resolves published security issues that doesn't impact Activeledger contract runtime.

## [2.10.2]

### Bug Fix
* **Protocol / Network** : Upgrade contracts refreshes cache asap. (No longer waits for timeouts)

## [2.10.1]

### Bug Fix
* **Protocol** : Upgrade contracts now refresh all processor caches to always run the latest (If selected as default)
* **Restore** : Sometimes an error is raised incorrectly and the restore engine fails to handle it, Now has default values instead of crashes. 

## [2.10.0]

### Feature
* **Storage** : Removed the Btree revision history in the storage engine. This change is backwards compatible for the read and upgrades on write. This feature will increase overall system performance and also improve the reliability of the written data. History is still preserved due to the :umid records and the :stream transaction array list.

## [2.9.1]

### Bug Fix
* **Contract** : Volatile data only gets saved when a change is detected.

## [2.9.0]

### Features
* **Activeledger:** Virtual prefixes for Activity Streams (Identities). These are managed at the transaction level. If a new stream is created it will use the first found virtual prefix. It will keep the same prefixes upon updates.

## [2.8.1]

### Bug Fix
* **Protocol** : New method to select latest version by targeting and tracking semver. Can be overidden by transaction $contract targetting itself with contractid@version.

## [2.8.0]

### Features
* **Activeledger:** Flush old archives with --flush flag this will reduce space. Best to setup and run periodically.
* **Activeledger:** Read Only transaction support. These transactions do not require any signatures and are invoked by having no $i provided. By default it will call read() but this can be changed with the $entry of the transaction payload.
* **Protocol** : Upgraded contracts are removed from resolver cache.
* **Contract** : Verify phase is now optional.

#### Example Read-only transaction
```json
{
    "$tx": {
        "$namespace": "namespace",
        "$contract": "contract id",
        "$entry":"readMe" // Will call the method readMe() found in the contract
    }
}
```

### Bug Fix
* **Definitions** : Faster transaction schema validation.

## [2.7.10]

### Features
* **Protocol** : VM now supports "getAnyStreamReadOnly" from within the context of the smart contract, This function is awaitable.

## [2.7.9]

### Bug Fix
* **Contract** : Delete Authorities now only throws when empty.

## [2.7.8]

### Bug Fix
* **Restore** : Prevent an expected but unknown error from killing the entire process.
* **Protocol** : Remove INC from error logs to protect contract data privacy.


## [2.7.7]

### Features
* **Restore** : Archiving & Error backlog processing faster.

### Bug Fix
* **Crypto** : No longer causes webpack building error.
* **Protocol** : Default contracts are now installation location relative. (Improves Security).

## [2.7.3]

### Bug Fixes
* **Restore:** Engine now uses a schedule to check on errors, No longer holds connections open for real-time detection.

## [2.7.2]

### Bug Fixes
* **Network:** Bad error checking and casting caused exceptions from being handled correctly.
* **Protocol:** Bad error checking and casting caused exceptions from being handled correctly.

## [2.7.1]

### Features
* **Activeledger:** Manually Compact Database --compact flag will start the process. Make sure Activeledger is running and that you have more than 50% disk space. 

## [2.7.0]

### Features
* **Restore:** Archiving now deals with old sequence files. This will reduce the disk storage requirement by Activeledger. 

### Bug Fixes
* **Protocol:** When a contract tries to reconcile a stream which doesn't exists the error is now caught and handled.

## [2.6.6]

### Features
* **Contracts:** When clearing INC you can now preserve the next value set by that node.

## [2.6.5]

### Bug Fixes
* **Restore:** 950 error codes now processing correctly and creating streams when they do not exist.

## [2.6.4]

### Features
* **Protocol:** Third party packages can now be mocked by namespace if are a required but unused dependency.

### Bug Fixes
* **Storage:** Correctly returns error for a stream that cannot be found.
* **Restore:** Attempts to recover the not found stream from the network if is exists.

## [2.6.3]

### Bug Fixes
* **Restore:** Improved write performance and avoid local data corruption.

## [2.6.2]

### Bug Fixes
* **Storage:** In Memory stream count no longer goes negative.
* **Restore:** No longer loops on document being archieved.

## [2.6.1]

### Bug Fixes
* **Restore:** No longer attempts UMID processing when not formatted correctly.
* **Restore:** Network matching errors now get marked as processed.

## [2.6.0]

### Features
* **Restore:** Archives processed errors and continues to monitor for new & missed errors.

### Bug Fixes
* **Storage:** Search now handles autocomplete lookups.
* **Storage:** On first load now displays data instead of being blank rows.
* **Storage:** Improved accuracy on document / stream counts.

This release also has all dependencies upgraded. 

## [2.5.5]

### Bug Fixes
* **Utilities:** JSON detection improved.
* **Utilities:** Improved custom error handling while attempting to continue backwards compatible support.

## [2.5.4]

### Bug Fixes
* **Restore:** Await error document confirmation.
* **Storage:** Support new_edits.
* **Utilities:** Request now sends data as a buffer instead of string to improve UTF8 support.


## [2.5.3]

### Bug Fixes
* **Protocol:** INC (Internode Communication) now included in the voting round

## [2.5.2]

### Bug Fixes
* **Toolkits:** PDF Toolkit implementation fixed.
* **Protocol:** Enable external NPM libraries for specific contract namespaces using the configuration file.
* **Protocol:** IsExecutingOn contract code fixed.
* **Protocol:** Events no longer exposed to the VM.
* **Network:** Improves revision detection when P2P is in broadcast mode.

## [2.5.1]

### Bug Fixes
* **Contracts:** getActivityStreams now detects an object with a property called $stream and fetches.
* **Protocol:** Deterministic Activity Streams no longer crash on collision detection.

## [2.5.0]

### Features
* **Storage:** New data storage layer has been created. It is backwards comptible with data structure and endpoints. For new ledger installations it will use RocksDB and for existing ledgers it will use LevelDB.

### Deprecated
* **Query:** All query support (SQL, Indexes, Contracts, API) has been dropped. A new Query language is being designed and more control given to contract developers which wont impact transaction performance. This new query support is planned to support sub-queries after developer assigned streams have been indexed in real-time. 

## [2.4.0]

### Features
* **Activeledger:** CLI Controls Start / Stop / Restart.
* **Activeledger:** CLI Stats.

### Bug Fixes
* **Protocol:** Transaction I/O Streams are no longer multiple fetches instead a single fetch returns all streams (Read Performance Increase).

## [2.3.1]

### Bug Fixes
* **Network:** Locker correctly locks streams depending on transaction type. (Label or Key based).

## [2.3.0]

* **Storage:** Automatic Archiving - Metadata surrounding data files (Streams, Stream Metadata & Volatile Data) is archived. The underlying data is still available from the database ([stream]@[revision]) using these archive files to access the revision values. Archiving happens every 300 revisions. The **data is not** archived.

* **Storage:** New HTTP endpoint _raw to read the data files metadata.

## [2.2.0]

2 new features are published with this release of Activeleder

### Features
* **Toolkits:** Embdded Helper Libraries for Smart Contracts [Activetoolkits](https://github.com/activeledger/activeledger/tree/master/packages/toolkits)

* **Hybrid:** External smart contract transaction processing, Be part of a permissioned network without priviliges to assist in network wide consensus only local consensus. [Activehybrid](https://github.com/activeledger/activeledger/tree/master/packages/hybrid) 

## [2.1.12]
* **Protocol:** Default namespaces VM has correct permissions for all operations at boot. 

## [2.1.11]
* **Protocol:** No longer emits 1000 errors to be handled grouped with 1505.
* **Restore:** Filter vote failure errors to process the document if mismatched error messages are found
* **Restore:** Fixed stop/start listener from failing to emit the process event.

## [2.1.10]

### Bug Fixes
* **Core:** Subscriptions / Events close specific event listener instead of all.

## [2.1.9]

### Bug Fixes
* **Core:** SSE socket writes being flushed correctly.

## [2.1.8]

### Bug Fixes
* **Core:** SSE Proxy aware headers being set.
* **Core:** SSE Connections heartbeat timeout was 30 minutes not 10.
* **Core:** Event Notifications filtered correctly instead of all changes.

## [2.1.7]

### Features
* **Network:** Busy Locks & Network Stable errors are now returned with the status code 200.
* **Core:** SSE Connections now have native TCP Keepalive enabled.

### Bug Fixes
* **Core:** SSE Connections heartbeat uses SSE comments instead of 0 bytes.
* **Core:** SSE Connections heartbeat increased to 10 minutes.

### BREAKING CHANGES
* **Network:** Busy Locks & Network Stable errors no longer return as status code 500 instead it is now 200. This was done to bring them inline with other errors within Activeledger (Such as contract errors). If you're using one of the SDK's not many changes should be needed because the returned summary values will be blank apart from the error property. An example error response will look like :

```json
{
    "$umid": "",
    "$summary": {
        "total": 1,
        "vote": 0,
        "commit": 0,
        "errors": [
            "Busy Locks"
        ]
    },
    "$streams": {
        "new": [],
        "updated": []
    }
}
```

## [2.1.6]

### Bug Fixes
* **Protocol:** Read-only streams are correctly awaited before executing the contract.

## [2.1.5]

### Bug Fixes
* **Network:** Encrypted Consensus fixed, Issue with creating new node connections across processors excluded their key data.

## [2.1.4]

### Bug Fixes
* **Httpd:** Removed unnecessary break statement when route parsing. This fixes incorrect route handlers from being selected.
* **Tests:** Updated tests to reflect changes made in 2.1.X release.

## [2.1.3]

### Bug Fixes
* **Network:** Duplicate transaction input/output reference no longer run into a locking issue.
* **Network:** Busy locks now rejects error instead of resolving the error.
* **Restore:** Resolved implicit any build error for unknown stream data struts.

## [2.1.2]

### Bug Fixes
* **Contracts:** Setting Internode Communications no longer always throws an error.

## [2.1.1]

### Bug Fixes
* **Protocol:** No longer selects the incorrect VM container on initalisation of a broadcast transaction type.

## [2.1.0]

### Bug Fixes
* **Activeledger:** Improved build script (npm rum setup).
* **Contracts:** Unhandled rejections sent back to transaction client request.
* **Logger:** PID is now padded to align logs.
* **Logger:** Logs message improvements.

### Features
* **Activeledger:** Node 12 Support.
* **Activeledger:** ES2018 Builds.
* **Core:** Refactored to use Httpd package.
* **Httpd:** New HTTP server.
* **Protocol:** Refactored to improve maintainability.
* **Storage:** Custom PouchDB build for self hosted data storage.

### Performance Improvements
* **Logger:** Moved some INFO logs to DEBUG.
* **Network:** Improved processor handling for running transactions simultaneously.
* **Network:** Improved internal IPC calls / Emitted Events between processes.
* **Protocol:** New VM container which is reusable for multiple contract executions.
* **Protocol:** Fetches all related stream data per transaction as one batch.
* **Protocol:** Volatile stream data is now on demand.
* **Restore:** Converted promises to async / awaits.


### BREAKING CHANGES
* **Contracts:** [activity].getVolatile() now returns as a promise to return the data instead of returning the data synchronously.
