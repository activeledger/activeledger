<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activelogger

Logging for Activeledger, and the timing marks used to profile a transaction.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activelogger
```

Needs Node.js 24 or later.

```ts
import { ActiveLogger } from "@activeledger/activelogger";

ActiveLogger.info("started");
ActiveLogger.warn("something to look at");
ActiveLogger.error(new Error("failed"), "what was being done");
```

Log lines carry a timestamp, a level and the process id. `ActiveLogger.sink` redirects them (the node uses it to print log lines above its start-up line).

`ActiveTiming` records a mark per stage of a transaction for the profilers in the repository. It does nothing unless `ACTIVELEDGER_PROFILE` is set, and should never be set in production: it writes a line per stage per transaction.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/logger)

MIT licensed.
