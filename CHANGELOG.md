# Activeledger Changelog

## [4.5.14]

### Fix
* **Storage** : `@activeledger/activestorage` had been publishing without its compiled `lib/` and `es/` since 4.5.11 - 38 files, none of them built - while its manifest still declared `main` as `./lib/index.js`. It installed cleanly, resolved, reported the right version and threw `MODULE_NOT_FOUND` on require, which blocked a node deploy. `packages/.gitignore` ignores `lib` and `es`, and npm falls back to `.gitignore` when a package has no `files` field and no `.npmignore`. All sixteen other packages declare `files: ["es", "lib"]`, which overrides that ignore; activestorage was the only one that never had it. Under lerna this never showed, because lerna packed by its own rules - dropping lerna in 4.5.11 handed packing to npm and made a long-latent bug live. Nothing in the package itself had changed. The tarball goes from 38 files to 113.
* **CI** : Nothing caught the above for three releases. The release workflow verifies every package is *fetchable* from the registry, which they all were, and no test imports a published artefact - so being on npm was mistaken for being usable. `scripts/check-package-contents.mjs` now asserts that whatever `main`, `types` and `module` point at is actually inside the tarball. It runs on every push and again in publish before anything leaves the runner, because a broken tarball cannot be unpublished. It fails only when the file exists on disk and npm leaves it out, which is the real failure mode; `nano-gateway` builds itself from `prepublishOnly` and is legitimately unbuilt at check time, and failing on that would have made the check noise.

### Changed
* **Build** : `nyc` removed. It was a devDependency that no script, workflow or config referenced, and it had just been bumped three majors purely to clear advisories against a tool nothing invoked. Drops 1574 lines from `package-lock.json`. If coverage is wanted later it should return with a script attached.

## [4.5.13]

### Known Issue
* **Storage** : `@activeledger/activestorage` was published without its compiled `lib/` and `es/`, so `require("@activeledger/activestorage")` throws `MODULE_NOT_FOUND` on a clean install. The package installs, resolves and reports the right version - it is simply unusable. Affects 4.5.11, 4.5.12 and 4.5.13; a published tarball cannot be repaired in place, so **use 4.5.14 or later**.

### Security Fix
* **Protocol** : A contract could reach the `Function` constructor through `this`. `securityScan()` is the only barrier in front of contract code - there is no runtime sandbox behind it - and its dynamic-element-access rule exempted any chain that started at `this`. Once a hop lands on a banned name the object is no longer the contract, so `const k = "constructor"; (this.constructor)[k](...)` passed the scan and was a full escape. A chain is now tainted by a demonstrably banned hop; dynamic access directly on `this` and computed reads of transaction data still pass.
* **Storage** : The self-hosted data store listened on every interface and ignored its own `db.selfhost.host` setting - that value had only ever been used to build a client connection string. The store has no authentication of any kind: `_bulk_docs` sets any document to any revision (the repair primitive, which has to stay), `DELETE` removes a stream or the whole database, and `_utils` serves files. It now binds `127.0.0.1` by default and honours `db.selfhost.host` when set. Loopback, SSH tunnels and containers sharing the node's network namespace (how the gateways reach it) are unaffected; if you deliberately expose the store, set `db.selfhost.host` explicitly.
* **Options / Storage / Activeledger** : Three inputs that were trusted further than they are owned. Document ids are now encoded before becoming a URL path segment, so a relative segment in an id from a peer can no longer redirect a request to a different database. The Fauxton static handler resolves and contains its path rather than concatenating it - traversal reached far enough in to touch the working directory holding `config.json` and the `.identity` private key. A newly generated `.identity` is written `0600` instead of landing at `0644` under a default umask; tightening one already on disk is a separate, deliberate step.

### Fix
* **Network** : The SPI "skipped" branch - taken when fewer nodes answer than consensus needs - referred to a `const output` declared in the sibling block above it. The name resolved to a later declaration in an enclosing scope, so the compiler said nothing and the branch threw `ReferenceError: Cannot access 'output' before initialization` at runtime. The throw happened inside the SPI check's `setTimeout` callback, so it surfaced as an unhandled rejection: the submitting client's promise never settled and `host.release()` was never reached, leaving every stream the transaction named locked until the three minute sweep. This fired precisely when the network was already short of responding nodes.
* **Build** : TypeScript upgraded from 4.7.3 to 5.6.3. 4.7 cannot parse `const` type parameters, so any modern `@types/node` failed at parse time and blocked the types update. 5.6.3 rather than latest, because 5.7 makes the typed arrays generic and turns every `Buffer.concat` in crypto, utilities, httpd and network into a variance error. No source changes.
* **Build** : Dependency round - `@types/node` 18.0.0 -> 24.10.1 (matching the Node the workflows actually run, rather than a major ahead of it), `@types/levelup`, mocha 10.8.2, ts-node 10.9.2, browserslist and brace-expansion transitively. `npm audit --omit=dev` reports no vulnerabilities. An earlier build break from undici 6.28's types needing DOM globals is fixed in the same range.
* **CI** : Dependabot did not know the repository had become an npm workspace, so its updates targeted the wrong manifests. `actions/checkout` and `actions/setup-node` moved to v7.

## [4.5.12]

### Known Issue
* **Storage** : `@activeledger/activestorage` was published without its compiled `lib/` and `es/`, so `require("@activeledger/activestorage")` throws `MODULE_NOT_FOUND` on a clean install. The package installs, resolves and reports the right version - it is simply unusable. Affects 4.5.11, 4.5.12 and 4.5.13; a published tarball cannot be repaired in place, so **use 4.5.14 or later**.

### Fix
* **Activeledger CLI** : The CLI symlinks `node_modules` into `contracts/` and `default_contracts/` so contracts can require dependencies at runtime, and resolved it as the package's own folder. npm only creates that folder when a dependency cannot be hoisted, and converting the repository to workspaces hoists everything to the root - at which point the CLI died with `ENOENT ... packages/activeledger/node_modules` before doing anything at all. It now asks Node where the modules are (`require.resolve.paths()`), which is correct in a package folder, a workspace root and a global install alike.
* **CI** : The post-publish registry check asked npm too soon and failed a release that had published correctly.

## [4.5.11]

### Known Issue
* **Storage** : `@activeledger/activestorage` was published without its compiled `lib/` and `es/`, so `require("@activeledger/activestorage")` throws `MODULE_NOT_FOUND` on a clean install. The package installs, resolves and reports the right version - it is simply unusable. Affects 4.5.11, 4.5.12 and 4.5.13; a published tarball cannot be repaired in place, so **use 4.5.14 or later**.

### Fix
* **Network** : A node that originates a transaction on a stream it lags could never heal. SPI only runs on a failed vote, and a broadcast contract update holds a lock on its output stream on every node for the life of the round - so every peer answered "locked" to the origin's own SPI sample and it abstained on a sample its own transaction had spoiled. It is doubly stuck, because `$revs` is stamped by the first node to see the stream: a lagging origin stamps its stale position into the broadcast and the round dies with one yes vote. A peer now answers with its real revision instead of the locked marker, but only when the lock is held by the same transaction the asker is running SPI for (matched on umid) and that peer has already voted against it - a node that voted no cannot commit, so its copy is stable by construction. Everything else stays refused. In the failing case all three peers reject on the position gate, the origin gets a clean majority and corrects itself inside the same round. Re-submitting the transaction after an in-round heal is deliberately not included.

### Changed
* **Build** : lerna is gone, replaced by npm workspaces. `lerna bootstrap` -> `npm ci` / `npm install`, `lerna publish` -> `npm publish --workspaces`, `lerna version` -> `scripts/set-version.mjs`. lerna 6 had misreported three releases in a row and lerna 7 removes `bootstrap` entirely, handing workspace linking to the package manager - which is where this ends up anyway. The version script moves the three things that have to move together or a release is inconsistent: the root version, every package version, and every dependency range pointing at a sibling. Building from source is now `npm i` at the root; nothing needs installing globally.
* **CI** : A release is called done only after the registry confirms it, rather than on the publisher's own success line.

## [4.5.10]

### Fix
* **Restore** : Reverted the interagent stream reconciler added in 4.5.9. Restore talks to the store over HTTP and takes no part in the Locker protocol that serialises transactions against a stream, so a write from there could land on top of a transaction committing on this node - and because it wrote with `force_rev`, which checks nothing, it would have done so silently, destroying a commit. It also ignored the `{ _id, locked: true }` markers, so it could vote on a sample taken while a transaction held the stream. Restore's remit returns to adding documents this node is missing rather than overwriting ones it holds. The 1200 error document from 4.5.9 is kept - it writes to the error database, never to a stream, and is a durable record that this node disagreed about a stream. Reconciling the stream itself belongs to SPI, inside the transaction's own lifecycle, which reaches it 10-50x sooner in any case.
* **Tests** : An RSA key test asserted its own boundary and flaked.

## [4.5.9]

### Fix
* **Utilities** : The HTTP client outlived the server's connection and writes died on dead sockets. undici's `keepAliveTimeout` had been raised to 30s to avoid a handshake between consensus rounds, while the server closes idle connections at around 10s - leaving roughly twenty seconds in which a request is handed to a socket the server has already closed. undici does not retry non-idempotent requests, and a stream write is a `POST` to `_bulk_docs`, so the write died, `ActiveRequest.send()` returned `{ data: null }`, and the node raised 1510 "Failed to save streams" and dropped out of the round. It looked intermittent, affected writes but not reads (GETs are idempotent and are retried silently), left nothing in the server's log because the close was deliberate, and was worse on quiet nodes whose connections sit idle longer. On a four node network, losing two nodes this way puts a round below consensus and commits nothing anywhere. **If you have seen unexplained intermittent 1510s, this is the release to take.**
* **Network** : SPI took a write lock to do a read and starved the writer. `Endpoints.streams()` held `Locker.hold(stream, "SPI")` for a second on every request, and `hold()` refuses a transaction if any of its streams is held by anything - so a stream several peers were asking about had a read lock on it more or less continuously and the transaction trying to write it was pushed into the busy-locks queue again and again. Seen live as a contract update running 30 seconds to its TTL while every node logged "Lock busy for `<stream>` ... requested by SPI". The endpoint now reads without locking, and still answers `{ _id, locked: true }` when a real transaction holds the stream.
* **Network / Restore** : An even split was resolved by coin toss rather than by evidence. Two revisions with equal support can mean two different things: a lag has different positions (103 against 104), where one side simply missed a transaction and taking the later position loses nothing; a fork has the same position with different content (104-aaa against 104-bbb), where each side committed something the other did not and adopting either silently destroys a transaction. Revisions are content addressed, so there is nothing to choose between them on merit. Both reconcilers now refuse a fork and say so - endpoints abstains with "forked - two revisions at the same position, needs a human", restore logs it as an error. A forked stream now surfaces instead of being quietly resolved one way.
* **Protocol / Restore** : A node that dissents on a stream now leaves a durable record of it. A 1200 position error in broadcast mode writes an error document, which the interagent's five second poll picks up; previously only a 950 did, so a dissent left nothing behind and a lagging node had no route to reconcile a stream while idle. (The reconciler this originally fed was reverted in 4.5.10; the error document remains.)
* **Tests** : A commit is now judged by what the nodes wrote rather than by what the origin heard, and the network suite gained a live contract-divergence case with a real convergence assertion.

## [4.5.8]

A repair release. Every mechanism a node has for getting back onto the network's revision of a stream - SPI, restore, and the changes feed the gateways read - was broken in at least one way. Recommended for any network that has seen a node stuck voting "Stream Position Incorrect".

### Fix
* **Network** : A node could only self-heal a stale stream on broadcast transactions. A node that misses one committed update votes "Stream Position Incorrect" against that stream forever, and the recovery for it - the SPI lookup, where the node asks its peers for the stream, takes the revision they agree on and force-writes it locally - is gated entirely on the node's own record of why it voted no. `postVote()` only ever wrote that field inside the `$broadcast` branch, so a node that fell behind on a territorial or round-robin transaction never opened the gate and had no route back by any path.
* **Network** : The SPI self-repair decision ignored what the nodes actually reported. `error?.indexOf(...) !== -1` evaluates to `undefined !== -1`, which is true, so every node that reported no error at all was counted as disagreeing - the gate measured how many nodes were in the transaction rather than what any of them said.
* **Network** : SPI voted on whatever came back, so a busy stream elected its own stale revision. `Endpoints.streams()` silently omitted any stream it could not take an SPI lock on, at HTTP 200 with no marker, so the nodes holding the current revision of a busy contract stream routinely answered as though they had never heard of it - while an idle stream, like a deployer identity, always answered. Observed live: a node one revision behind on a contract stream elected its own copy against three peers.
* **Network** : One node answering twice counted as two votes. The tally now counts one vote per node per stream, which is what the threshold assumes it is counting.
* **Network** : SPI treated a repair that never landed as a completed one. Nothing under `bulkDocs()` reports failure by throwing - LevelMe returns `false`, the self-hosted HTTP layer turns that into `200 { ok: false }`, `ActiveRequest.send()` resolves `{ data: null }` for every transport fault, and CouchDB reports per-document errors - so a node whose disk was full, which is exactly the condition that puts a node behind in the first place, would run the repair, fail to write, mark itself caught up and say nothing. All three shapes are now read, the failure is logged loudly, and the next transaction retries rather than skipping the stream.
* **Restore** : A full restore (`activerestore --full`) could repair a missing document but not a divergent one. It wrote everything with a single `bulkDocs(docs, { new_edits: false })`, which is precisely the mode the store refuses for a document that already exists on a different revision - the throw aborted the whole batch and the run ended with "There was an error running quick full restore". Only the not-found branch ever wrote, so the one state a full restore is the obvious thing to reach for was the one it could not fix. Each document now picks its own mode.
* **Restore** : Restore discarded the one record that could recover a stale stream. On a failed vote the interagent raised an error document and tried to recover by fetching the missed transaction's umid from a peer and replaying its events - but the `:umid` record only exists on nodes that committed, and this node is asking precisely because it did not. The fetch failed, the document was marked processed and purged unarchived, and the stream was never looked at again.
* **Storage / Core** : A longpoll round delivered one document of a multi-document commit. `bulkDocs` emits one change per document in a synchronous loop, and the listener responded to the first by writing it, ending the response and detaching itself - synchronously - so every remaining document in the same commit found no listener, with no sequence backfill able to replay them. Every transaction is a multi-document commit (a stream's state document and its `:stream` meta document move together), so one of the two was dropped on every commit, and which one was arbitrary. Consumers that exclude `:` ids, such as nano-gateway's SSE handler, therefore received nothing at all for a transaction whenever the meta document won - which reads as an intermittent push bug.
* **Storage** : The changes feed could not report failure, and could spin or double-run. `ActiveRequest.send()` never rejects - it returns `{ data: null }` for connection refused, DNS failure, body timeout, socket reset, non-2xx and unparseable body alike - so no consumer could ever be told the datastore was unreachable, and the entire restart machinery driven by that error event was dead code. With the datastore completely down this polled in silence forever.

### Changed
* **Build** : Internal `@activeledger` dependencies are pinned exactly rather than by caret range, so what a build installs is decided by the repository rather than by whatever npm happens to hold at that moment. 69 ranges across 14 packages. In-repo versions are also put in lockstep with the release tag - they had drifted from every tag since v4.0.0, so a manifest inside a built image reported the wrong version and the only way to identify a build was to grep compiled output for a symbol.
* **CI** : The test suite now runs in CI. Nothing ran it before: publish was the only workflow, so `npm test` only ever ran when someone remembered to, on code that decides consensus and repairs divergent ledger state. Tests, build and publish all run on Node 24.

## [4.5.7]

### Fix
* **Storage** : One empty longpoll round permanently killed the changes feed.
* **Storage** : The longpoll heartbeat had been commented out, so a quiet feed timed out.
* **CI** : Publishing never created a GitHub Release, so the releases page went stale.

## [4.5.6]

### Fix
* **Protocol** : A `:stream` meta document's umid was permanently frozen at the transaction that created it. `buildReferenceStreams()` only set `meta.txs`/`meta.umid` in the branch handling a genuinely new stream, and for a plain `setState()` change the meta object was not passed to the stream updater at all. Anything resolving "which transaction last touched this stream" through `meta.umid` - which is what a client does after a live push, since a push event carries only the changed stream's own document - was silently resolving a stale transaction for any stream updated more than once.

## [4.5.5]

### Fix
* **Storage** : The `_changes` handler called Node `http.ServerResponse` methods that do not exist on the real uWebSockets response.

## [4.5.4]

### Fix
* **Storage** : A live `_changes` push carried no real sequence number, which broke the response JSON.

## [4.5.3]

### Fix
* **Storage** : `since="now"` crashed `_changes` with an opaque 500.

## [4.5.2]

### Fix
* **Storage** : The `_changes` longpoll response body was corrupted by garbage header bytes.

## [4.5.1]

### New
* **Nano Gateway** : SSE resume via `Last-Event-ID`, matching Activecore's convention.

### Fix
* **Storage** : The self-hosted `_changes` longpoll never finalised its response.
* **Storage** : Missing-key reads leaked LevelDB error objects to the caller.

## [4.5.0]

### New
* **Nano Gateway** : New package `@activeledger/nano-gateway` - a lightweight, permissioned SSE and read gateway for light-node clients. Modelled on activehybrid: direct datastore access alongside a real node, no consensus involvement, no Activecore dependency. Its SSE implementation is written against the uWebSockets response the httpd layer actually provides (cork-wrapped writes, a 5s heartbeat against uWS's ~10s idle timeout) rather than the Node `http.ServerResponse` API Activecore's controller assumes.

## [4.4.0]

### Features
* **Network** : Neighbourhood health is now tracked reactively instead of by routinely full-mesh polling every neighbour every 10-25s. A neighbour is assumed connected until a real broadcast to it fails, at which point it is marked down and individually re-polled every few seconds until it recovers - one fewer permanently running job per node. Two paths in `knock()` that assumed a failed request would reject (it never does) were fixed along the way.

## [4.3.4]

### Security Fix
* **Crypto** : secp256k1 private keys are padded to a fixed 32 bytes. `ECDH.getPrivateKey()` strips leading zero bytes rather than returning a fixed-width scalar, so roughly 1 in 400 generated keys came back short in both the raw hex and SEC1/PEM paths. OpenSSL's own sign and verify tolerate it, which is why it went unnoticed, but the key material is spec-noncompliant and stricter external parsers and other-language SDKs may reject it.

### Fix
* **Activeledger** : npm package homepage links point at GitHub rather than the dead activeledger.io.
* **CI** : `lerna publish` has no `--access` flag, which had been failing the publish step.

## [4.3.3]

### Security Fix
* **Storage** : Path traversal blocked in the self-hosted `/_backup` and `/_restore` routes.
* **Storage** : Unused `ethers` and `dd-trace` dependencies removed.

### Fix
* **CI** : `publish.yml` failed schema validation, which blocked every push including tags - no workflow ran at all, tag or not.
* **CI** : Packages publish to npmjs.org alongside GitHub Packages again. 4.3.3 is the first 4.x release available from npmjs.org; 4.0.0 through 4.3.2 are on GitHub Packages only.

### Performance
* **Network** : `Locker.cell` as a `Map` instead of a plain object.
* **Core** : Multi-stream SSE subscriptions use a `Set` instead of `Array.indexOf()`.
* **Storage** : Directory entries stat'd concurrently in the self-hosted admin endpoints; a plain string split in place of a single-character regex.
* **Restore** : A umid's events are replayed concurrently instead of one at a time, and quick-restore's pagination loop no longer copies the array on every page.
* **Protocol** : `filterPrefix(streamId)` computed once per stream instead of up to three times; `hasOutstandingVotes()` reuses the cached neighbourhood length.

## [4.3.2]

### Fix
* **Network** : The origin node ran the expensive SPI lookup for errors that had nothing to do with stream position.

## [4.3.1]

### Fix
* **Protocol** : Deterministic streams always false-positived as an existing collision, so a deterministic stream could never be created after the first.

## [4.3.0]

### Security Fix
* **Protocol** : `import x = require("y")` was a complete, silent bypass of the contract module allow-list. TypeScript's import-equals syntax is a distinct AST node, and `securityScan()`'s module-loading check only ever inspected call expressions and import declarations. Confirmed end to end on a real node before the fix: a contract using it read the host's `/etc/hostname` and returned the contents through ledger state.
* **Protocol** : Backtick module specifiers bypassed every module-loading check.
* **Protocol** : Bracket-access and computed-destructuring sandbox escapes closed.

### Features
* **Protocol** : `policy.allowLocalLibs` - a per-namespace flag allowing a contract to require sibling files in its own namespace directory. Previously every shared library file had to be named literally in each node's `config.namespace.<ns>` allow-list, and re-added on every version bump.

## [4.2.1]

### Fix
* **Storage** : The PID-file "already running" check was unreliable and has been removed.
* **CI** : The publish pipeline had been silently broken since v4.0.0. The published version is now derived from the git tag rather than from committed manifests, which had drifted from every tag.

## [4.2.0]

### Features
* **Protocol / Restore** : Raised events are stored in the umid document and replayed on restore, so a node that missed a transaction also recovers the events it should have emitted.
* **Tests** : A live 4-node network integration test (`npm run test:network`), plus negative-path coverage and unit coverage for the storage fixes in 4.1.x.

### Fix
* **Activeledger CLI** : `activeledger --stop` hung forever instead of exiting.
* **Protocol** : `buildPromises()` masked every specific error (1700 / 1710) into a generic 950.
* **Network** : `Error` content on a 500 response is normalised rather than serialising to `{}`.

## [4.1.2]

### Fix
* **Storage** : `LevelMe.post()` always reported success, even on a real write failure.
* **Storage** : `bulkDocs()` spuriously failed every transaction while an `/events` client was connected.
* **Httpd** : The dead `enableCORS` flag is gone; CORS is always on and is now documented as such.

### Performance
* SSE listeners are cleaned up immediately on disconnect rather than on the next write; the P2P receive buffer is no longer re-concatenated per TCP chunk; the verify-key cache is actually reachable; contract security denylists, `ActiveOptions.get("build")` and `URLSearchParams` parsing hoisted out of hot paths.

## [4.1.1]

### Changed
* **Core** : `autostart.core` defaults to `false` in the config template written for new installations. The self-hosted storage engine now exposes its own HTTP API - SSE events, changes feed, document reads and Mango queries - covering most of what Activecore provided. Restore still starts by default, and core remains fully installable and usable for anyone who wants it; it simply is not started unless asked for. Existing configuration files are not modified.

### Fix
* **Crypto** : Deprecated `new Buffer()` in `KeyPair.sign()` replaced (Node 24 compatibility).
* **Storage** : `getMany()` crashed the whole batch on a single missing key.
* **Activeledger** : The default config still named storage engine "rocks" after the LevelDB fallback in 4.1.0. Cosmetic - the value is ignored - but it misled every node's startup log.

## [4.1.0]

### Features
* **Storage** : New `LevelDBDriver` built on `classic-level`. `@nxtedition/rocksdb`, which the RocksDB driver needed, was removed from the npm registry entirely - not unpublished at one version, the whole package is gone - and its GitHub source does not match the pinned version, so there is no safe way to know what that code contained. `RocksDBDriver` is left in place, unused.
* **Storage** : Internal storage moved to V8 serialization with a JSON fallback, plus process-level instance locking.
* **Network** : Persistent P2P binary stream transport with an HTTP legacy fallback, a smarter reconnection policy, and transport identification in the logs.
* **Network** : Admin configuration hot-reload.
* **Contracts** : Predicate-based key deletions and audit-trail archiving; the transaction umid is recorded on authority additions and updates.

### Security Fix
* **Protocol** : Contract transpile security check added, contract lifecycle access hardened, and authenticated spoofing prevented.

### Fix
* **Core** : Cache pollution and stale contracts on upgrade; labels and symlinks pointing at a superseded contract id are cleared.
* **Protocol** : The static contract path cache is invalidated on a version mismatch.
* **Storage** : Deserialization data loss resolved; backup and restore I/O converted to `fs.promises`.

### Performance
* Hybrid async `ActiveClone` on msgpackr with gzip, contract path cache persisted across process instances, and the vmscript proxy replaced by direct contract execution in the VM.

## [4.0.1]

### Fix
* **Network** : Unresolved early-vote placeholders were broadcast as real votes, and a stale early flag was not cleared once a vote actually resolved.
* **Storage** : A stale resolved-document cache entry survived a write.

### Performance
* gzip skipped for small request bodies; undici keep-alive raised for inter-node requests (revisited in 4.5.9); `openapi.json` cached instead of read per request; consistent raw/parsed cache keys in LevelMe; cached public `KeyObject` in `KeyPair.verify()`; a `Set` for busy-lock queue dedupe; no full deep clone in `storeError()`; no O(n^2) buffer growth reading request bodies.

## [4.0.0]

The 4.0.0 line is two years of work between 2.15.7 and this tag, and the entries below group it by theme rather than listing every change.

### BREAKING CHANGES
* **Protocol** : vm2 has been removed. Contracts no longer execute inside a vm2 sandbox - vm2's breakout problem is not fixable - and the boundary is now the per-transaction worker process together with a static security scan of the contract source at deploy time. `export2ledger` is no longer needed.
* **Network / Httpd** : The HTTP layer is uWebSockets.js, with undici as the client. This is where the node's sensitivity to the Node major version comes from: uWebSockets.js ships prebuilt bindings for a specific set of Node majors, and a node will not start on one it does not cover.
* **Distribution** : Packages are published on version tags to GitHub Packages. npmjs.org publishing was restored in 4.3.3.

### Features
* **Network** : Stream Position Index (SPI). A node that votes "Stream Position Incorrect" asks its peers for the stream, takes the revision they agree on and force-writes it locally, rather than being stuck against that stream indefinitely. Includes inline correction, longest-chain-first matching on a race, exclusion of self-signed inputs from the count, and a requirement that a corrected document reach consensus.
* **Network** : A busy-lock queue that holds and replays contended transactions instead of rejecting them, locking keyed by umid, and faster lock release.
* **Network** : Batch processing and internal HTTP bundling for inter-node traffic; early and delayed broadcast modes; stable dual peering modes.
* **Protocol** : Contract data (`getContractData`) with a cache layer, and an L2 database cache.
* **Protocol** : Expiring and repeatable transactions; transactions that take no locks; inputs that sign only; self-signed contract data access.
* **Activeledger** : Backup and restore process; `--cpus` argument to set the processor count.
* **Logger** : Winston file logging with an optional Datadog integration, single-line response logging, and a graceful shutdown routine.

### Fix
* **Network** : SSE works again under uWebSockets, and the missing CORS allow-headers are sent.
* **Network** : Multiple crash points, memory growth and keep-alive/timeout handling; unhandled rejections surfaced rather than swallowed.
* **Protocol** : Error documents keyed by umid, consistent umid output, and error passthrough for non-broadcast transactions.
* **Restore** : On-demand consensus data restoring, and umid recovery that no longer archives false positives.

## [2.15.7]

### New
* **Network** : Experimental leadership mode.

### Fix
* **Network** : Default back to gzip networking.

## [2.15.6]

### Fix
* **Protocol** : Prevent overwritting of the GeneralContractVM instance. (No more dropped / lost transactions)

## [2.15.5]

### New
* **Network / Protocol** : Broadcast transaction right away no longer waits for vote response.

### Fix
* **Network** : Improve processor memory management.
* **Protocol** : Improves general error handling and messaging.
* **Utilities** : Allow all HTTPS certificates.

## [2.15.4]

### Fix
* **Network** : Make sure processor exists and running correctly before sending next update.
* **Protocol** : Fix event engine from interrupting valid transactions from completing.

## [2.15.3]

### Fix
* **Network** : Somehow an object is masquerading as a Buffer is sneaking through. This is acts as a backstop to prevent and recover the TX.

## [2.15.2]

### Fix
* **Network** : Standby Processors now receiving updates as if it was in the processor pool.
* **Network** : GZip compression now optional from the configuration file gzip:true.

## [2.15.1]

### New
* **Network** : Process Memory Manager. Process will not be used anymore if memory limits are exceeded.

### Fix
* **Network** : Better GZip detection. Headers & Magic number checks.
* **Protocol** : Improved Logging.


## [2.15.0]

### New
* **Network / Protocol** : "Trust The Network" the node will still not write data but it will return to the calling client the $summary information if the other nodes agreed and committed the transaction.
* **Network** : Transaction implied network signing with $signed.
* **Restore** : Checks occur more often and document date is a suffix as lookups have been a higher priority than order.

### Fix
* **Network** : $sigs must always be present in every transaction (including read).
* **Network** : Improved Logging.
* **Protocol** : Inverted $selfsign check resuling in every $i must needing a matching signature.

## [2.14.8]

### New
* **Network** : Internal busy locks now raise errors

## [2.14.7]

### Fix
* **Network** : Internal busy locks no longer prevents transaction propergation.

### Fix
* **Network** : Improved error responses. Now come back as 200 OK with $summary.errors.
* **Network** : Prevent multiple new processors launching.
* **Network / Protocol** : Improved Logging
* Lerna build working again

## [2.14.6]


### Fix
* **Protocol** : Improved Logging
* **Protocol** : Transaction time stored in UMID

## [2.14.5]

### New
* **Network** : Process Memory Manager. Process will not be used anymore if memory limits are exceeded.
* **Network** : Interface to view current locks and trigger to run checker.
* **Locker** : Failsafe Unlocker of Streams. If an unhandled event still occurs this will auto unlock based on expected timeouts.

### Fix
* **Network** : Busy Lock Queuer Improvements. (Internal have highest priority, Broadcast lowest)

## [2.14.0]

### New
* **Network** : Standby Process, Setup an additional transaction processor ready to be hot swapped right away.
* **Network** : Simple busy lock queue. Retries 3 times after small delay to see if the locks have been released.

### Fix
* **Network** : Increase first connection delay (+100ms)
* **Protocol** : When sending right only (not broadcast mode) retry 3 times instead of failing right away.

## [2.13.8]

### New
* **Protocol** : UMID Events - Events created for every UMID to better help walkthrough the transaction list.
* **Network** : Payload encryption between nodes with $encrypt.
* **Network** : Remap reference names from config file with neighbourhoodRemap (Useful to change IP without breaking generated reference)

### Fix
* **Network / Logger** : Optional chaining to prevent null errors from not being handled nicely.
* **Network** : Kill hanging processes that have had an unhandled event.
* **Network** : Improved handling of unhandled rejection events for a more graceful shutdown.

## [2.13.7]

### Fix
* **Storage** : Improved database management, Less code and reduced writes.
* **Protocol** : Virtual Prefixes can now be mixed without prefix for the same stream.

## [2.13.6]

### Fix
* **Network** : Prevent unhandled error in the unhandled error handler from occuring when processor reconnects.
* **Activeledger** : Testnet multi run file no longer runs out of buffer and crashes.

## [2.13.5]

### New
* **Network** : $expire transaction check. Transaction cannot enter the network if expired.

```json
{
    "$tx": {
        "$expire": "1970-01-01T00:00:00.000Z (isostring)",
    },
}
```

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
