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

## Two bugs the switch to `classic-level` surfaced

Both were pre-existing in the original `hpe-11a` driver code, on both `LevelDBDriver` and `RocksDBDriver` (they share nearly identical logic) — neither had ever been exercised at runtime before this session, because `@nxtedition/rocksdb` was never installable to test against.

1. **`batch()` crashed on first use.** The guard `if (this.db.status !== 'open')` assumed `this.db` existed; on a driver that had never been opened yet, `this.db` was `null`, and accessing `.status` on it threw immediately. Fixed to `if (!this.db || this.db.status !== 'open')`.
2. **`get()` silently broke every new-document write.** The old `levelup`/`leveldown` API threw an error with `.notFound = true` for a missing key. Modern `abstract-level`-based drivers (both `classic-level` and, presumably, whatever `RocksLevel` was) instead *resolve* `undefined` for a missing key. `prepareForWrite()` (`levelme.ts`) branches on `error.notFound` to detect "this stream doesn't exist yet, treat it as a new document" — since nothing ever threw, that branch never ran, and the code fell through to `Buffer.from(undefined)`, which throws a generic, unrelated-looking error. Fixed by having the driver's `get()` throw a `.notFound`-tagged error itself when the underlying value is `undefined`, restoring the convention the rest of the codebase depends on.

If you're extending or debugging either driver, both of these are worth keeping in mind as a class of bug: this codebase's write path was written against the older Level API's error-throwing conventions, and a modern `abstract-level`-based driver needs to actively restore those conventions at the boundary rather than assume they're preserved automatically.

## `classic-level` and this monorepo's TypeScript version

`classic-level`'s type definitions use `Symbol.asyncDispose` (the TC39 explicit resource management proposal), which this monorepo's pinned TypeScript (`4.7.3`, from 2022) doesn't know about — it predates that feature landing in TypeScript's own lib definitions. Rather than bump TypeScript monorepo-wide (a much bigger, riskier change), `packages/storage/tsconfig.json` has `skipLibCheck: true`, scoped to just that package — the standard, low-risk way to deal with a third-party dependency's type definitions using newer language features than your own compiler targets, without disabling type-checking on your own code.

## External storage (CouchDB)

The `db.url` config field points at an external CouchDB instance instead. This path is older and less actively touched by recent work — the `secondaryCache` layer in `options/src/dsconnect.ts` has a self-documented, known `_rev`-tracking bug and has been repeatedly enabled/disabled in git history. If you're relying on CouchDB, that's worth being aware of; it wasn't in scope for the `v4.1` storage work described above.
