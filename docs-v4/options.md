# `options`: config, caching, and the CouchDB client

`@activeledger/activeoptions` (`packages/options/`) bundles four things that don't obviously belong together, but are grouped here for historical reasons: CLI/config parsing (`ActiveOptions`), a small TTL cache (`ActiveCache`/`ActiveCacheManager`), the CouchDB HTTP client (`ActiveDSConnect`), and a changes-feed wrapper (`ActiveChanges`). It also re-exports `ActiveRequest`/`ActiveGZip`/`ActiveClone` from `@activeledger/activeutilities` — those actually live in `utilities` now (see [transport.md](transport.md) and [storage.md](storage.md)), kept re-exported here for compatibility with code written before that split.

## `ActiveOptions`: config precedence is not what you'd guess

This is `ActiveOptions.get<T>(name, defValue)` — the call used everywhere in this codebase, including throughout [configuration.md](configuration.md) and [transport.md](transport.md). Its actual precedence, from `options.ts`:

```ts
public static get<T>(name: string, defValue: any = null): T {
  return ActiveOptions.config[name] ?? ActiveOptions.argv[name] ?? defValue;
}
```

**`config.json` wins over a CLI flag of the same name, not the other way round.** This is easy to get backwards intuitively — you'd expect a flag passed on the command line to override a file — but it's `config[name]` checked first. In practice this rarely bites because most CLI flags (like `--port`) are only meaningful *before* `config.json` exists (`--setup-only`, generating the file for the first time) — see the `--port` gotcha in [cli.md](cli.md). But if you're passing a flag on every startup expecting it to override an existing config file's value for that same key, it won't; edit the config file instead, or use `--config <path>` to point at a different file entirely.

`ActiveOptions.init()` just parses `process.argv` (via `minimist`) into `.argv`; `parseConfig()` separately reads and JSON-parses the config file into `.config` — these are two distinct steps, not one. Both get mirrored onto `global.argv`/`global.config` too, with a comment marking it `"Transition period"` — worth knowing that global access exists if you're tracing where a value came from, but it's explicitly not meant to be the long-term way to read config.

`ActiveOptions.set(name, value, reload)` exists, but **its `reload` parameter is currently a no-op** — the branch that would act on it is empty. Setting a value at runtime doesn't propagate anywhere beyond `ActiveOptions`'s own in-memory config object; the process-reload behaviour you'd expect from a `reload: true` argument doesn't happen here (compare to `/a/admin-reload`, the actual config-hot-reload mechanism — see [configuration.md](configuration.md#remote)).

## `extendConfig()`: pulling network config from the ledger itself

This is the mechanism behind `--assert`/dynamic node management (see [`docs/en-gb/dynamic-nodes.md`](../docs/en-gb/dynamic-nodes.md)): rather than every node's `security`/`consensus`/`neighbourhood` living only in a local file, they can be asserted onto the ledger as a stream, and every node fetches and merges that stream's current state on boot via `ActiveDSConnect`. This is also, slightly unexpectedly, where Winston file-based rotating log setup lives (gated by a `winston` config flag) — not somewhere you'd think to look for logging configuration.

## `ActiveCache`: TTL-based, not LRU

This is what backs `LevelMe`'s document cache (see [storage.md](storage.md#raw-vs-resolved-documents-and-why-the-cache-has-two-keys-per-document)) and other in-memory caching around the codebase — worth being precise about what it actually is, since "cache" alone undersells the design: **it's a `Map` with one `setTimeout` per key, not an LRU.** There's no size limit and no least-recently-used eviction — every entry lives until its own TTL timer fires (default 20 minutes, `1200000`ms), full stop. `get(key, extend)` can push a key's TTL back on read (a sliding-window pattern — this is exactly what `LevelMe.get()` does, passing `30000` to extend a hot document's cache life by 30 seconds every time it's read) but that only delays eviction, it doesn't cap how many distinct keys can be resident at once.

The practical implication: a workload with high unique-key churn — this session's own onboarding benchmark ([transport.md](transport.md)) is a good example, thousands of unique fresh identities in a short window — will grow this cache's memory footprint for the full TTL window of every key touched, since nothing ever evicts for size, only for age. Not a bug, just a design tradeoff worth knowing about if you're capacity-planning a node under heavy, high-cardinality write load.

`ActiveCacheManager.fetch(name, ttl)` is a get-or-create registry of named `ActiveCache` instances — different subsystems get their own independently-TTL'd cache by name rather than sharing one.

## `ActiveDSConnect` and `ActiveChanges`

`ActiveDSConnect` (`dsconnect.ts`) is the actual CouchDB HTTP client — `get`/`post`/`put`/`bulkDocs`/`exists`, implementing the shared `IActiveDSConnect` interface also used by the embedded engine. Its `secondaryCache` layer (an attempt at read-caching CouchDB responses) is almost entirely commented out — see [storage.md](storage.md#external-storage-couchdb) for the known `_rev`-tracking bug behind that. `ActiveChanges` (`changes.ts`) wraps CouchDB's `_changes` feed as a Node `EventEmitter`, for live change notification when using external storage.
