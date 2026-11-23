# The database explorer

Each node's embedded store serves a page for looking at its own data. Open it in a browser on the node's host:

```
http://127.0.0.1:5259/_explorer
```

The port is `db.selfhost.port` (5259 unless you changed it; a node made with `--port` uses `port - 1`). The old `/_utils` address redirects here. It is one static page that reads the store's own API, so nothing is installed and nothing runs on the node for it.

**There is no login.** The store has no access control, which is why it binds to loopback by default (`db.selfhost.host`). Reach it from another machine with an SSH tunnel (`ssh -L 5259:127.0.0.1:5259 node`), do not bind it to a public address, and see [Keeping it safe](security.md).

## What it does

- **Browse** the node's databases (the ledger, events and errors, and any custom ones), page through their documents, and open one to see its state, meta, volatile data and history. A contract's source is shown on its own tab.
- **Go to** a transaction, stream or document by pasting its id (Ctrl+K).
- **Export** the page you are on as JSON or CSV, or a whole database as JSON lines.
- **Maintain** the store the page is talking to: compact, back up and prune. Compact and backup are safe on a live node. Prune counts first and asks before it removes anything, and only touches the events and errors databases (see [Pruning old data](prune.md)).
- **Edit and delete** documents, one at a time or several selected together. Before a change is saved the page shows a diff of what will change, and you confirm it.
- Light and dark themes.

## Consensus data is read only

The ledger's own documents (stream state and meta) must be the same on every node, so the page shows them read only. **Danger mode** (the button at the top) allows editing them. Turn it on only when you mean to: a change made here makes this node disagree with the network, so it can fail votes or be overwritten by a repair from the other nodes. Every such change asks you to type part of the document id first, and restoring a backup needs Danger mode too.

A stream's volatile data, the node's working stores (events, errors) and custom databases can be edited without it.

## Reading, not building

The explorer is for an operator on the node's host checking what is there. It is not an API: do not build on it, and use the [node's endpoints](../api.md) for applications. Writing to the store bypasses consensus.
