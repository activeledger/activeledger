# SPI: Stream Position Incorrect, and how the network heals it

"SPI" is all over the code comments in `packages/network/src/network/endpoints.ts` and nowhere explained — it stands for **Stream Position Incorrect**, error code `1200`. It's one of the more elaborate pieces of self-healing logic in the codebase, and it exists because of a fundamental property of the gossip model in [architecture.md](architecture.md): nodes don't have a synchronized, globally-agreed view of "what revision is this stream currently at" at every instant — they converge on one, but there's a window where they can legitimately disagree.

## Where it comes from

Every transaction carries `$revs.$i`/`$revs.$o` — the *expected* current revision (`meta._rev:state._rev`) for each input/output stream, established once by whichever node processes the transaction first (`permissionsChecker.ts`):

```ts
if (revType && revType[streamId]) {
  if (revType[streamId] !== currentRevision) {
    return reject({ code: 1200, reason: "Input Stream Position Incorrect (...)" });
  }
} else {
  revType[streamId] = currentRevision; // first node to see it sets the expectation
}
```

Every subsequent node that processes the same transaction (as it gossips outward) compares its *own* local revision for that stream against the expectation the first node set. If a node is even slightly behind — it hasn't yet committed an earlier transaction on that same stream that a faster peer already has — its local revision won't match, and it votes `false` with a `1200`/"Stream Position Incorrect" error. This is not a sign that anything is broken: it's an expected consequence of gossip convergence taking a non-zero amount of time, most likely to show up when the same stream is touched by multiple transactions in quick succession.

## What the origin does about it

If a transaction's origin sees a vote round come back with no commits and errors mentioning "Stream Position Incorrect" — either the majority of respondents disagree, or the origin's own vote was the wrong one — it suspects the *local* revision is stale rather than the transaction being genuinely invalid, and starts a repair sequence (`endpoints.ts`, both the origin path and, separately, a non-origin path with the same idea — up to `MAX_COUNTERS` = 10 retry attempts):

1. **Ask the whole network** what it currently has for every stream the transaction touches (`host.neighbourhood.knockAll("stream", { $streams })`) — the primary stream, its `:stream` companion, and the contract's own cached `:data` entry, since any of the three could be the one that's stale.
2. **Tally votes per (stream, revision) pair** across every response — how many nodes currently agree on each candidate revision.
3. **Require the same threshold consensus normally needs** (`consensus.reached`, see [configuration.md](configuration.md)) before accepting a revision as "the real one" — a lone disagreeing node doesn't get to declare itself right just because it responded.
4. **Break ties by preferring the more advanced revision** — CouchDB-style revision strings start with a numeric position (`3-abc123...`); if two candidates get equal votes, the higher position wins.
5. **Rewrite the local copy** to match the network's winning revision (`bulkDocs`) if it doesn't already match — with a short (1.5s) cache to avoid redoing the same rewrite repeatedly if several transactions trip over the same stale stream in a tight window.
6. **Retry the original transaction** now that the local copy should be current.

## What this means in practice

- **You don't need to special-case SPI as a client.** It's primarily a node-to-node concern the origin resolves on its own — most of the time you'll never see `1200` at all, since the repair-and-retry cycle happens before a response is ever sent. If the retries genuinely exhaust (`MAX_COUNTERS` reached, see below), the last vote round's error — which can be `1200`/"Stream Position Incorrect" itself — does surface to the client the same way any other failed transaction's error would (see the error table in [transactions.md](transactions.md)). The point isn't that you'll never see it, it's that there's no separate handling to write for it: treat it like any other transient failure and retry the transaction yourself if that's appropriate for your use case.
- **A transaction touching a "hot" stream — one being written to frequently — is more likely to trigger this**, since that's exactly the condition (multiple in-flight transactions racing to update the same stream) that makes nodes' local revisions diverge in the first place. If you're seeing elevated latency or retry counts on a specific stream, this self-healing cycle is a plausible cause worth checking node logs for (`grep SPI` on a node's log is genuinely the fastest way to find out — every step above logs with an `SPI` prefix).
- **This is a different repair mechanism from `restore`'s `Interagent`** (see [restore.md](restore.md)). `Interagent` handles a stream that's *missing entirely* from a node (`StreamNotFound`); SPI handles a stream that *exists* but is at the wrong revision. They're solving adjacent but distinct problems, and the restore package doesn't touch `1200`/SPI at all — it's fully contained within the request-handling path in `endpoints.ts`.

## Honest caveat

The implementation in `endpoints.ts` reads as logic that evolved incrementally against real production symptoms rather than a cleanly specified algorithm up front — several of its own code comments are open questions the original author left in place ("*However what about I am the only one that is wrong (As they may send via me)*", "*problem happens if they are the same? Maybe announce no winner?*"). This document describes the mechanism as it currently behaves, not a guarantee that every edge case in a multi-way revision disagreement is handled optimally. If you're debugging a specific SPI-related incident, read the relevant block in `endpoints.ts` directly rather than assuming this summary covers every branch.
