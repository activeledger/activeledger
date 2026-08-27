# Architecture: consensus and the network model

This is the part of Activeledger that has no accurate documentation anywhere else. It's written from direct study of `packages/network/src/network/host.ts` and `packages/protocol/src/protocol/process.ts` during this session, including tracing and fixing a real consensus bug — so where this doc asserts something about the protocol's behaviour, it's from reading the code that implements it, not from a design document.

## It's gossip, not request/response

It's easy to assume a consensus protocol looks like classic PBFT: a leader collects votes and replies to a client once a quorum is reached. Activeledger doesn't work that way.

1. A client POSTs a transaction to any node. That node becomes the transaction's **origin**.
2. The origin locks the relevant stream(s) locally (see "Streams are the unit of concurrency" below), runs the smart contract's vote phase, and broadcasts an `init` message containing the transaction to every other node in the network — in parallel, not one at a time.
3. Each peer that receives `init` does the same: runs its own vote phase locally, then **re-broadcasts its own vote to every other node** — not back to the origin only. This is the "gossip" part: a node's vote propagates outward the same way the original transaction did.
4. Every node independently accumulates votes into the transaction's `$nodes` map as they arrive. Once a node judges consensus has been reached (see `consensus.reached`, a percentage, in [configuration.md](configuration.md)), it runs the commit phase locally and the transaction is done, from that node's point of view.

There is no single moment when "the network" agrees — each node reaches its own conclusion by watching the same gossip traffic. This is why the transport layer matters more than it would in a request/response design: `broadcast()` (`network/host.ts`) is the single most consequential function in the codebase, and it's called for both the initial `init` fan-out and every vote re-gossip.

## Streams are the unit of concurrency

Locking happens per-stream (`packages/network/src/network/locker.ts`), not globally. Two transactions touching unrelated streams can be held, voted on, and committed at the same time, in different worker processes. This is the main lever for throughput: contention only happens when transactions actually touch the same data. A benchmark of purely independent transactions (fresh identity onboarding, one per transaction) will look very different from a benchmark of transactions all fighting over the same stream.

Each transaction gets dispatched to a worker process from a pool sized to the number of physical CPU cores (`network/host.ts`, `PhysicalCores.count()`). This is a real, current resource limit on this codebase specifically — a benchmark run on a machine that's busy with other work will bottleneck on CPU contention for these workers, not on network transport. That's exactly what happened in this session's own benchmark (see [transport.md](transport.md)): swapping the transport made no measurable difference to throughput, because CPU time (contract execution, RSA sign/verify) was the actual bottleneck.

## The `$nodes` map and the early-vote pitfall

Every transaction's ledger entry carries a `$nodes` object, keyed by node reference, tracking what each node has decided so far. This is worth understanding in some detail because it's the source of a real bug this session fixed (three commits: `78de5a0`, `243b1d6`, `eb9cb53`, all now in `master`).

Before a node's own vote has actually resolved, `hold()` (`network/host.ts`) sets that node's own entry in `$nodes` to a placeholder: `{ vote: false, commit: false, early: true }`. This exists so the node has *something* to broadcast even before its local vote phase finishes — a courtesy re-broadcast, useful for fast convergence. The bug was that this unresolved placeholder could get broadcast to peers *as if it were a real, resolved vote*, because the code deciding whether to send it was gated on the wrong thing (a call parameter, not the entry's own resolution state). Receiving nodes would then blindly merge that placeholder into their own copy of `$nodes`, and once every neighbour's placeholder had accumulated, vote-counting logic that only checks "is a key present" (not "is this key actually resolved") would conclude voting had finished — when it hadn't. The symptom was a `Failed Network Voting Round - No More Voters` failure roughly 35ms after broadcast, far too fast to be a genuine timeout.

The general lesson, if you're touching `broadcast()` or anything that reads `$nodes[self]`: a node's own tentative state and its resolved state need to be reliably distinguishable as they flow through IPC (the subprocess sends its whole `$nodes` map back to the host) and broadcast (the host merges peer data in). It is not enough to check whether a key exists — you have to check whether it's been resolved. `postVote()` (`protocol/process.ts`) is the single point every non-leader broadcast-mode resolution path converges through, which is why the fix (`delete this.nodeResponse.early` there) lives in one place rather than scattered across every individual resolution call site.

## The contract VM lifecycle

A transaction runs through up to four phases, each returning a promise:

1. **Verify** — permission and signature checks, before any contract code runs.
2. **Vote** — the contract's `verify()`/`vote` logic executes in a sandboxed VM. This is what gets broadcast to peers.
3. **Commit** — once consensus is reached, the contract's `commit()` logic actually writes the resulting stream state.
4. **Post** — runs after a successful commit, for side effects that shouldn't block the transaction's own completion (e.g. notifying an external system).

Each phase has a timeout, checked periodically (`contractCheckTimeout`, default 10s) up to a hard ceiling (`contractMaxTimeout`, default 20 minutes from the vote phase starting) — a contract can call `this.setTimeout(ms)` from inside its own code to push that ceiling back in increments, useful for a contract that's deliberately waiting on something slow like another ledger's confirmation.

## Where this leaves node roles

There's no fixed leader. Any node can originate a transaction by being the one a client happens to submit to. The "leader" language that shows up in a few code comments refers to whichever node originated a given transaction, not a persistent role — that node's vote bypasses the general `postVote()` broadcast path and goes out via the commit phase instead, which is deliberate and out of scope for the early-vote fix described above.
