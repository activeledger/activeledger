# Smart contracts

Contracts are TypeScript classes, uploaded to the ledger as a transaction (registered under a namespace so ownership and origin can be verified), transpiled and cached, and run inside a sandboxed VM. This overview is checked against `packages/contracts/src/*.ts` at `v4.1.0`; the deployment mechanics (registering a namespace, deploying, upgrading, running) are unchanged from [`docs/en-gb/contracts/deployment/`](../docs/en-gb/contracts/deployment/) — those are still accurate and not reproduced here.

## Base classes

```ts
import { Standard, PostProcess, Event, Activity, Stream } from "@activeledger/activecontracts";
```

- **`Stream`** — the base every contract ultimately extends. Gives you `Activity` objects (read/write access to a stream's state) for the `$i`/`$o`/`$r` streams a transaction references.
- **`Standard`** — extends `Stream`. This is what you inherit from for a normal contract. Two methods to implement:
  - `vote(): Promise<boolean>` — required. Can this transaction go ahead (permissions, available data, business logic)? This is what gets broadcast to peers during the gossip phase (see [architecture.md](architecture.md)).
  - `commit(possibleTerritoriality?: boolean): Promise<any>` — required. Actually write the resulting state, once consensus is reached.
  - `verify(signatureless: boolean): Promise<boolean>` — optional. An earlier check for whether this contract even understands the transaction shape, before the vote phase runs.
- **`PostProcess`** — extends `Standard`, adds an abstract `postProcess(...)` hook that runs after a successful commit, for side effects that shouldn't block the transaction's own completion (notifying an external system, chaining another action).
- **`Event`** — extends `Standard`, adds the ability to emit named events from within the contract (`packages/query/src/index.ts`'s `EventEngine`, despite living in a package literally named "query" — see the note below). Events are stored and can trigger external processing via `core`'s SSE/subscriptions API.

## What used to also be here: `Query`

Earlier documentation (and `docs/en-gb/contracts/query.md`, still present, marked deprecated) describes a `Query` base class letting a contract run SQL or Mango queries against the ledger at runtime. **That class, and the SQL query engine behind it, were removed** in the `hpe-11a`→`v4.1` merge (`packages/query/src/sql.ts` deleted, along with `postprocessqueryevent.ts`/`queryevent.ts`/`query.ts` in the contracts package). Confirmed safe to remove: the code implementing the `core` API's `/search` endpoint that would have used it (`packages/core/src/controllers/query.ts`) was already fully commented-out, dead code before the removal — nothing was actually using this feature.

If you have older contracts extending `Query`, they'll need to move to plain `Standard` (or `Event`, if what you actually needed was event emission rather than ad-hoc querying) — there's no query replacement as of `v4.1.0`.

## Multi-signature and weighted authority

`Stream`/`Activity` expose two helpers for contracts that need more than "any one valid signature": `getMofSignatures(m)` (plain M-of-N count) and `hasAuthorityStake(minimum, activity)` (do the presented signatures' authorities sum to at least this much weight, out of a stream's `meta.authorities` — each authority carries its own `stake`, defaulting to `100` for a freshly-onboarded single identity). Neither is automatic; a contract's own `vote()`/`commit()` logic calls them explicitly. See [definitions.md](definitions.md#multi-authority-streams-have-a-weighted-stake-model-not-just-a-signer-list) for the full type shape and the removed-authority audit trail that goes with it.

## The VM sandbox's import allowlist

Contract code runs with `eval`, `require`, dynamic property access, and direct `process`/`global` access all disabled (`packages/activeledger/src/contracts/default/contract.ts`'s VM policy). More specifically relevant if you're writing a contract with a dependency: **only an explicit allowlist of modules can be imported at all**, and by default that list is exactly `@activeledger/activetoolkits` (see [toolkits.md](toolkits.md) — PDF generation, an HTTP client re-export) and `@activeledger/activecontracts` (this package, for chaining base classes). A network can extend that allowlist per-namespace via `security.namespace[<namespace>].std`/`.external` in config, but nothing beyond those two is importable out of the box. If a contract needs some other capability, either it needs to be requested into that namespace's allowlist, or built as a `toolkits`-style pre-approved module.

## Contract lifecycle and timeouts

Four phases, each a promise: **Verify** (optional, pre-vote) → **Vote** (broadcast to peers) → **Commit** (writes state, once consensus reached) → **Post** (side effects, doesn't block the transaction). See [architecture.md](architecture.md#the-contract-vm-lifecycle) for how these interact with the network layer.

Each phase is watched for timeout — checked periodically (`contractCheckTimeout`, default 10s) up to a hard ceiling (`contractMaxTimeout`, default 20 minutes from the vote phase starting). If you know you're about to do something slow — waiting on another ledger's confirmation, for example — extend the check window from inside your own contract code:

```ts
// Don't time out for another 15 seconds. Callable repeatedly, up to contractMaxTimeout.
this.setTimeout(15000);
```

## Deployment

Unchanged from the existing docs — worth reading in this order:

1. [Register a namespace](../docs/en-gb/contracts/deployment/namespace.md)
2. [Deploy a contract](../docs/en-gb/contracts/deployment/deploy.md)
3. [Upgrade a contract version](../docs/en-gb/contracts/deployment/upgrade.md)
4. [Run a contract](../docs/en-gb/contracts/deployment/run.md)

## Building and submitting the onboarding contract's transaction

Every network ships the `default`/`onboard` contract, which any new identity uses to self-sign itself onto the ledger — no pre-existing authority required. See [transactions.md](transactions.md) for the exact request shape, verified against a real running network as part of this session's work.
