# Storage

Each node persists ledger state — stream data, sequence history, transaction errors, events — either in an embedded engine it runs itself, or in an external CouchDB instance. All nodes in a network currently have to use the same kind (mixing embedded and CouchDB across a network is on the roadmap, not implemented).

## The embedded engine: LevelDB via `classic-level`

The embedded engine (`packages/storage/src/levelme.ts`, the `LevelMe` class) talks to its actual database through a small abstraction, `IStorageDriver` (`packages/storage/src/driver.ts`):

```ts
interface IStorageDriver {
  get(key: string): Promise<Buffer>;
  getMany(keys: string[]): Promise<Buffer[]>;
  put(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
  batch(): Promise<LevelUpChain<any, any>>;
  createReadStream(options: any): any;
  createValueStream(): any;
  isOpen(): boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  compactRange?(start: string, end: string): Promise<void>;
}
```

As of `v4.1.0`, `LevelMe` always constructs a `LevelDBDriver` (`packages/storage/src/drivers/leveldb.ts`), built on [`classic-level`](https://github.com/Level/classic-level) — the actively-maintained modern binding in the Level ecosystem (the community that owns `abstract-level`/`classic-level`/etc. migrated away from the older `leveldown`/`levelup` packages years ago; `leveldown` has been effectively frozen at `6.1.1` since). Documents are serialized with MessagePack and optional gzip (`ActiveClone`, `packages/utilities/src/clone.ts`) rather than plain JSON — this was introduced alongside the driver abstraction.

The `db.selfhost.engine` config field (see [configuration.md](configuration.md)) is currently **informational only** — it gets logged and passed to the storage subprocess as an argument, but nothing branches on its value to pick a driver. `LevelDBDriver` is always what runs. Don't be misled by a config file that still says something else; that was a real leftover bug (see below) and has been fixed, but the field's value has never actually controlled behaviour.

## The RocksDB detour

An earlier, long-stalled feature branch (`hpe-11a`) had targeted RocksDB instead, via a dependency called `@nxtedition/rocksdb`. Worth recording *why that isn't what shipped*, since it's a real supply-chain story and might come up again:

That package has been **completely removed from the npm registry** — not one version unpublished, the whole package gone (confirmed via `npm view` returning a plain "Not found", not a version-specific error). Its GitHub source (`github.com/nxtedition/rocksdb`) still exists but is stale — last commit 2022-06-17, latest tag `v7.3.1` — and doesn't match the `^15.4.1` that had been pinned in `package.json`. A cached record on Snyk shows the real npm package once reached version 17.1.3, meaning whatever shipped on npm diverged substantially past what's preserved in the GitHub repo before the whole thing disappeared. There's no way to know what that code actually contained, so it wasn't installed from the stale GitHub source as a substitute — a version gap that size is a strong signal of an incompatible native binding API, not just a missing patch release.

The `RocksDBDriver` class (`packages/storage/src/drivers/rocksdb.ts`) is still in the tree, unused, in case the dependency situation ever gets resolved. It was runtime-tested as far as its logic could be verified without the actual native binding (two real bugs were found and fixed this way — see below) but has never actually run against RocksDB, since the dependency was never installable.

## Three bugs the switch to `classic-level` surfaced

All three were pre-existing in the original `hpe-11a` driver code, on both `LevelDBDriver` and `RocksDBDriver` (they share nearly identical logic) — none had ever been exercised at runtime before this work, because `@nxtedition/rocksdb` was never installable to test against.

1. **`batch()` crashed on first use.** The guard `if (this.db.status !== 'open')` assumed `this.db` existed; on a driver that had never been opened yet, `this.db` was `null`, and accessing `.status` on it threw immediately. Fixed to `if (!this.db || this.db.status !== 'open')`.
2. **`get()` silently broke every new-document write.** The old `levelup`/`leveldown` API threw an error with `.notFound = true` for a missing key. Modern `abstract-level`-based drivers (both `classic-level` and, presumably, whatever `RocksLevel` was) instead *resolve* `undefined` for a missing key. `prepareForWrite()` (`levelme.ts`) branches on `error.notFound` to detect "this stream doesn't exist yet, treat it as a new document" — since nothing ever threw, that branch never ran, and the code fell through to `Buffer.from(undefined)`, which throws a generic, unrelated-looking error. Fixed by having the driver's `get()` throw a `.notFound`-tagged error itself when the underlying value is `undefined`, restoring the convention the rest of the codebase depends on.
3. **`getMany()` failed an entire batch over one missing key.** Same root cause as #2, one level up: `classic-level`'s `getMany()` returns `undefined` in whichever array slots weren't found, rather than throwing. The driver's `getMany()` did `vals.map(v => Buffer.isBuffer(v) ? v : Buffer.from(v))` unconditionally — `Buffer.from(undefined)` throws, which rejected the *whole* batch over a single absent key. This one had a real, reproducible symptom: `permissionsChecker.ts`'s stream lookup always requests a stream's `:stream` companion key alongside its primary key, even though that companion doesn't exist for every stream — so *any* transaction referencing a stream without one failed every time with a generic "Stream(s) not found," discovered live while testing the two-transaction example in [transactions.md](transactions.md#a-worked-example-onboard-then-a-follow-up-transaction). `permissionsChecker.ts`'s own logic already tolerates a shorter-than-requested result set correctly (that's exactly what its "950" count check is checking for) and doesn't rely on positional correspondence between requested keys and returned values. Fixed by filtering out missing entries in the driver instead of converting them.

If you're extending or debugging either driver, all three are worth keeping in mind as one class of bug: this codebase's write and read paths were written against the older Level API's error-throwing conventions (single key throws `.notFound`, batch calls either succeed in full or don't), and a modern `abstract-level`-based driver needs to actively restore those conventions at the boundary — including for the "some keys legitimately don't exist" case that a batch read has to tolerate — rather than assume they're preserved automatically.

## Raw vs. resolved documents, and why the cache has two keys per document

`get(key, raw?)` has two return shapes for the same stream, and this distinction is load-bearing, not incidental. A document can be stored in an old rev-tree format (`winningRev`/`rev_map`/`rev_tree`/`seq` fields, from before the current schema) or the current flat format. `seqDocFromRoot()` (`levelme.ts`) resolves the old format down to the actual data document by crawling to its winning branch (`findCachedBranchEnd()`); for the current format it's a no-op, since the "raw" root document already *is* the resolved document. `get(key, true)` returns the raw stored document as-is; `get(key)` (the default) returns it resolved.

Because those can genuinely differ, the in-memory read cache keys them separately (`raw:<id>` vs. plain `<id>`) — collapsing them onto one key was a real bug fixed in earlier `v4.1` work: a write's cache population always used to know only about the raw shape, so a subsequent non-raw read would return the raw document as if it were resolved, silently wrong for any old-format document. The `hpe-11a` merge's driver rewrite reintroduced a version of this same problem from a different angle — see below.

**On write**, `post()`/`bulkDocs()` populate the `raw:` cache entry directly (safe — it's exactly the shape that was just written) but only *invalidate*, never populate, the resolved (`<id>`) entry, rather than trying to resolve it inline during the write. The next non-raw `get()` recomputes it correctly on demand. This was a deliberate choice made during the `hpe-11a` reconciliation over the alternative of caching a guessed resolved shape at write time: guessing wrong for an old-format document would have reintroduced exactly the bug this section describes, just from the write path instead of the read path.

**`seqDocFromRoot()`/`findCachedBranchEnd()` were entirely absent from `hpe-11a`'s rewrite of this file** — not modified, just gone, along with every call site that used them. For a document already in the current format this made no observable difference (resolving is a no-op for those anyway), which is presumably why it went unnoticed. For any document still in the old rev-tree format, though, it meant `get()` would return the raw rev-tree root — pointers and metadata — instead of the actual data document. This was caught and fixed during the merge, not before it; it's a good illustration of why a "clean" merge (no conflict markers) doesn't mean nothing was lost — both branches can touch nearby-but-different lines and still produce a semantically broken result that git's line-based diff has no way to flag.

## The self-hosted engine has its own full HTTP API — and it's the recommended way to read data and events

This is a significant correction to how [core.md](core.md) originally framed things, and came from the project's own direction rather than from reading the code cold: `core` is being considered increasingly redundant. The self-hosted storage engine (`packages/storage/src/selfhost.ts`, listening on `db.selfhost.port` — `5259` by default, see [configuration.md](configuration.md)) exposes a substantial, mostly CouchDB-compatible HTTP API of its own, directly — no need to go through `core` at all if you have (or can get) network access to it:

- **`GET /<database>/events`** — a direct SSE stream of everything a contract has emitted via `this.event.emit(...)` (see [contracts.md](contracts.md)), filtered to `event:`-prefixed keys and reconnect-safe via `Last-Event-ID`. This is a live, real endpoint — verified directly: `curl -N http://127.0.0.1:5259/activeledgerevents/events` (using the default `db.event` database name) streams events as they're emitted, in the same shape `core`'s `/api/events` was documented as providing — except this one actually worked in testing, where getting `core`'s equivalent running hit real operational friction (see [core.md](core.md)).
- **`GET /<database>/_changes`** — the general CouchDB-style changes feed, same idea, not filtered to events specifically.
- **`GET /<database>/<doc-id>`** and **`POST /<database>/_all_docs`** — direct document reads, single or bulk.
- **`POST /<database>/_find`** / **`POST /<database>/_explain`** — Mango-style queries (a real, working feature here — unrelated to the SQL/Mango `Query` contract base class that was removed, see [contracts.md](contracts.md)).
- **`POST /<database>/_backup`** / **`POST /<database>/_restore`** — the backup/restore mechanism referenced in [cli.md](cli.md), reachable directly over HTTP too, not just the CLI flags.
- **`GET /<database>/_all_dbs`**, **`GET /_session`**, **`GET /<database>/transactions`**, **`GET /<database>/umids`** and more — a fuller surface than is worth enumerating exhaustively here; read `selfhost.ts`'s `http.use(...)` registrations directly if you need something not listed.

**If you have localhost (or otherwise trusted network) access to a node**, this is the direct, low-overhead way to read ledger state and subscribe to events — not `core`'s REST wrapper around the same data. `core` still exists and still works for what it does, but treat it as the less-preferred path going forward rather than the default recommendation this doc set originally gave it.

### Reading data through a transaction instead

There's a second way to read data that doesn't touch the storage HTTP API at all: a transaction with no `$i` calls a dedicated read-only method on the contract (named by `$entry`, defaulting to `read()`) instead of running the normal vote/commit lifecycle, and — genuinely, verified — needs no real signature at all, just an empty `$sigs: {}`. This is a completely different, and correct, mechanism from what an earlier pass of this section described (which mistakenly concluded signature-free reads weren't possible, based on a test that kept `$i` in the transaction — the actual trigger for skipping signature checks is omitting `$i` entirely, not emptying `$sigs` on a transaction that still has one). See [contracts.md](contracts.md#a-third-lifecycle-signature-free-reads-via-entry) for the full mechanism, a working contract example, and two verified real transactions (default `read()` and a custom `$entry` name).

## `classic-level` and this monorepo's TypeScript version

`classic-level`'s type definitions use `Symbol.asyncDispose` (the TC39 explicit resource management proposal), which this monorepo's pinned TypeScript (`4.7.3`, from 2022) doesn't know about — it predates that feature landing in TypeScript's own lib definitions. Rather than bump TypeScript monorepo-wide (a much bigger, riskier change), `packages/storage/tsconfig.json` has `skipLibCheck: true`, scoped to just that package — the standard, low-risk way to deal with a third-party dependency's type definitions using newer language features than your own compiler targets, without disabling type-checking on your own code.

## External storage (CouchDB)

The `db.url` config field points at an external CouchDB instance instead. This path is older and less actively touched by recent work — the `secondaryCache` layer in `options/src/dsconnect.ts` has a self-documented, known `_rev`-tracking bug and has been repeatedly enabled/disabled in git history. If you're relying on CouchDB, that's worth being aware of; it wasn't in scope for the `v4.1` storage work described above.
