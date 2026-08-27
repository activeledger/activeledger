# `logger`

`@activeledger/activelogger` (`packages/logger/src/index.ts`) is one class, `ActiveLogger`, used everywhere in this codebase — every doc in this set has code examples that call it. A few things about it that aren't obvious from the call sites alone.

## `fatal()` returns an `Error` — it doesn't just log one

```ts
throw ActiveLogger.fatal(data, "Cannot sign with rsa Public key");
```

This pattern shows up throughout the codebase (`crypto/keypair.ts` is a good example). `fatal()` logs at the FATAL level (and to `WinstonLogger` too, if configured — see [options.md](options.md#extendconfig-pulling-network-config-from-the-ledger-itself)) *and* returns `new Error(msg)`, so the call site can `throw` it in the same expression rather than logging and constructing an error separately. If you're adding a new fatal-error path, this is the established convention to follow, not `console.error` + a separate `throw new Error(...)`.

## Debug and trace are gated; info/warn/error/fatal aren't

`trace()` and `debug()` both check `ActiveLogger.enableDebug` before emitting anything — this is set from the `debug` config flag (see [configuration.md](configuration.md#debug)) at startup. `info()`, `warn()`, `error()`, and `fatal()` always emit regardless of that flag. If a log line you'd expect to see isn't showing up, check whether it's a `debug()`/`trace()` call and whether `debug: true` is actually set — this is a common source of "why isn't this logging" confusion.

## VM-originated log lines are colour-coded differently

`ActiveLogger.setVMRuntime(true)` flips a static flag that changes the ANSI colour used for the message body — bright yellow for anything logged from inside the sandboxed contract VM (see [contracts.md](contracts.md)), cyan otherwise. If you're watching a node's console output and trying to tell "this came from a contract" apart from "this came from the host/network layer" at a glance, that colour is the signal — not something documented anywhere else, and easy to miss if you're not looking for it.

## Every log line is prefixed with the process ID once, not recomputed

The `(Activeledger/PID)` prefix visible in every log line is built once at module load (`processString`, a cached, pre-coloured string) rather than reconstructed per call — a small but deliberate detail if you're wondering why changing `process.pid` mid-run (you can't, but hypothetically) wouldn't be reflected.

## Winston is opt-in, and lives in an unexpected place

File-based rotating logs (for something like a Datadog pipeline) route through `winston` + `winston-daily-rotate-file`, but they're not set up in this package at all — the setup code lives in `ActiveOptions.extendConfig()` (`packages/options/src/options.ts`), gated behind a `winston` config flag. See [options.md](options.md#extendconfig-pulling-network-config-from-the-ledger-itself). `ActiveLogger.WinstonLogger` is just where that gets assigned once configured; `fatal()`/`error()` check for its presence and mirror to it if set.
