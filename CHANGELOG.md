# Activeledger Changelog

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