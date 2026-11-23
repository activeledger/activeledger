<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activeoptions

Configuration and the command line layer shared by the Activeledger programs, with a few runtime helpers.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activeoptions
```

Needs Node.js 24 or later.

- `ActiveOptions`: read and set the node's configuration (`config.json`, command line overrides).
- `Cli`: argument parsing, help, exit codes, and the banner every command opens with at a terminal.
- `StartupDisplay`: the live start-up line (`[###]==[###]==[...]   consensus`).
- `ActiveRequest`, `ActiveGZip`, `ActiveClone`, the cache classes and the datastore connection (`ActiveDSConnect`).

`activeledger`, `activehybrid` and `activerestore` all use `Cli` and `StartupDisplay`, which is why they look and behave alike.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [The activeledger command](https://activeledger.github.io/activeledger/cli/activeledger/) and [Configuration](https://activeledger.github.io/activeledger/operate/configuration/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/options)

MIT licensed.
