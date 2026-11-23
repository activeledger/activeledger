<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activehttpd

A lightweight, portable HTTP server, built on uWebSockets.js, that Activeledger uses for a node's API and for its storage server.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/httpd
```

Needs Node.js 24 or later.

```ts
import { ActiveHttpd } from "@activeledger/httpd";
```

`ActiveHttpd` routes by method and path (`use("path", "GET", handler)`, with `**` wildcards), serves static pages and answers with JSON. It prebuilds for specific Node majors through uWebSockets.js; if you see `This version of uWS.js ... supports only Node.js versions`, check your Node version (24 is the tested one).

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/httpd)

MIT licensed.
