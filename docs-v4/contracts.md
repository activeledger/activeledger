# Smart contracts

Contracts are TypeScript classes, uploaded to the ledger as a transaction (registered under a namespace so ownership and origin can be verified), transpiled and cached, and run inside a sandboxed VM. This overview is checked against `packages/contracts/src/*.ts` at `v4.1.0`. The deployment *mechanics* (registering a namespace, deploying, upgrading, running) in [`docs/en-gb/contracts/deployment/`](../docs/en-gb/contracts/deployment/) are still structurally accurate — the transaction shapes are right — but their examples are silent on one rule that will trip up a first attempt at writing a real contract; see the worked example below, which was actually deployed and run against a live node rather than just read from source.

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
- **`Event`** — extends `Standard`, adds the ability to emit named events from within the contract (`packages/query/src/index.ts`'s `EventEngine`, despite living in a package literally named "query" — see the note below). Events are stored and can be consumed live over SSE — directly from the storage engine (recommended, see [storage.md](storage.md#the-self-hosted-engine-has-its-own-full-http-api-and-its-the-recommended-way-to-read-data-and-events)) or via `core`'s equivalent, less-preferred endpoint (see [core.md](core.md)).

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

## A third lifecycle: signature-free reads via `$entry`

Separate from vote/commit entirely, and genuinely signature-free — confirmed live, correcting an earlier, incomplete finding in this doc set that mistakenly concluded no signature-free read path existed. The actual mechanism, traced to `protocol/process.ts`:

```ts
// If no $i or $sigs (only need to check on 1 as they're required)
if (this.entry.$tx.$i) {
  // ... normal verify -> vote -> commit lifecycle ...
} else {
  // Read only so lets call the $entry (or default which is read())
  this.nodeResponse.return = await virtualMachine.read(
    payload.umid,
    this.entry.$tx.$entry || "read"
  );
}
```

**The branch is decided purely by whether `$tx.$i` is present.** Omit it, and the transaction skips `verify()`/`vote()`/`commit()` altogether and instead calls a plain, no-argument method on your contract instance — named by `$tx.$entry`, or literally `read()` if `$entry` is omitted — and whatever that method returns comes straight back to the client in the response's `$responses` field. Use `$o` (not `$i`) to tell the contract which stream(s) to read, since `$i` is what's deliberately absent here.

The one thing that still has to be present, even though nothing in it needs to verify against anything: `$sigs`, but as a genuinely empty object (`$sigs: {}`) works fine — `ExternalInitalise` (see [transactions.md](transactions.md)) only rejects a transaction for `$sigs` being *absent* (`!tx.$sigs`), not empty, and with no `$i` there's no per-stream signature check for anything inside it to fail against.

```ts
// A contract supporting both the default read() and a named alternative
export default class Reader extends Standard {
  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise((resolve) => resolve(true));
  }
  public vote(): Promise<boolean> {
    return new Promise((resolve) => resolve(true));
  }
  public commit(): Promise<any> {
    return new Promise((resolve) => resolve(true));
  }

  // Called for $entry omitted or $entry: "read"
  public read(): any {
    const oStreams = Object.keys(this.transactions.$o || {});
    const activity: Activity = this.getActivityStreams(oStreams[0]);
    return activity.getState();
  }

  // Called for $entry: "summary"
  public summary(): any {
    const oStreams = Object.keys(this.transactions.$o || {});
    const activity: Activity = this.getActivityStreams(oStreams[0]);
    return { name: activity.getState().name };
  }
}
```

```js
// No $i. $sigs present but empty. $o names the stream to read.
const readTx = { $namespace: ns, $contract: contractStreamId, $o: { [identityId]: {} } };
const res = await submit({ $tx: readTx, $sigs: {} });
// res.$responses[0] === whatever read() returned

const namedRes = await submit({ $tx: { ...readTx, $entry: "summary" }, $sigs: {} });
// namedRes.$responses[0] === whatever summary() returned
```

Both verified working, real captured responses: `[{"via":"default read()"}]` and `[{"via":"custom $entry=summary","name":"<streamId>"}]` respectively, against a contract implementing exactly the shape above.

**`verify()`/`vote()`/`commit()` still need to exist on the class** (they're `Standard`'s abstract requirements) even for a contract that's only ever used in read mode — they just never run for an `$i`-less transaction. `verify()`'s own `selfsigned` parameter is unrelated to this: it's `$entry.$selfsign`, not a signal that the transaction is read-only.

This is a different mechanism from `returnToRemote()` (`Stream`'s protected `returnToRemote(data)`/`getReturnToRemote()` pair, `packages/contracts/src/stream.ts` — see [transactions.md](transactions.md#response) for how its output surfaces in `$responses`), which is the equivalent "send data back to the caller" tool for the *normal* vote/commit lifecycle, called from inside `commit()`. Read mode's named method just returns its value directly — no `returnToRemote()` call needed there.

## Deployment mechanics

Transaction shapes for each step, unchanged from the existing docs:

1. [Register a namespace](../docs/en-gb/contracts/deployment/namespace.md)
2. [Deploy a contract](../docs/en-gb/contracts/deployment/deploy.md)
3. [Upgrade a contract version](../docs/en-gb/contracts/deployment/upgrade.md)
4. [Run a contract](../docs/en-gb/contracts/deployment/run.md)

## The rule the deployment docs don't mention: `$i`/`$o` streams must already exist, unless `$selfsign`

This is the single most important thing to know before writing your first contract beyond onboarding, and it isn't stated anywhere in the existing docs' abstract examples. Found by actually deploying and running a real contract against a live node — the first two attempts below are exactly what went wrong, not a hypothetical.

**A normal (non-`$selfsign`) transaction cannot spontaneously create a brand-new output stream by just naming it in `$o`.** `process.ts` only skips the existing-stream check for both `$i` and `$o` when `$entry.$selfsign` is true:

```ts
if (!this.entry.$selfsign) {
  const inputStreams = await this.permissionChecker.process(this.inputs);
  const outputStreams = await this.permissionChecker.process(this.outputs, false);
  // ...
}
```

For any transaction that isn't self-signed, **every** stream referenced in `$i` *and* `$o` gets looked up first, and the transaction fails with `950`/"Stream(s) not found" (see the error table in [transactions.md](transactions.md#error-reference)) if any of them don't already exist — this is a general check, not specific to inputs. `$selfsign` is what the onboarding contract uses to create a stream from nothing; it isn't a general "create a new record" mechanism a normal contract can reach for. A contract that legitimately wants to *initialize* new state generally does so by writing to a stream that something upstream (typically onboarding, or another prior transaction) already created — not by inventing a fresh key inline.

### Worked example

A minimal contract that writes a message onto an existing stream's state:

```ts
import { Standard, Activity } from "@activeledger/activecontracts";

export default class Greeter extends Standard {
  private oActivity: Activity;
  private message: string;

  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (selfsigned) {
        reject("No self sign");
      } else {
        resolve(true);
      }
    });
  }

  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const oStreams = Object.keys(this.transactions.$o);
      if (!oStreams.length) {
        reject("Need an output stream");
        return;
      }
      this.oActivity = this.getActivityStreams(oStreams[0]);
      this.message = this.transactions.$o[oStreams[0]].message as string;
      if (!this.message) {
        reject("Need a message");
        return;
      }
      resolve(true);
    });
  }

  public commit(): Promise<any> {
    return new Promise<any>((resolve) => {
      const state = this.oActivity.getState();
      state.message = this.message;
      state.updatedAt = new Date().toISOString();
      this.oActivity.setState(state);
      resolve(true);
    });
  }
}
```

Deploy it (base64-encoded source, uploaded under a namespace the deploying identity already owns — see [transactions.md](transactions.md) for `submit()`/`KeyPair` setup, omitted here for brevity):

```js
const contractSrc = fs.readFileSync("./greeter-contract.ts", "utf8");
const deployTxBody = {
  $namespace: "default",
  $contract: "contract",
  $i: {
    [identityId]: {
      version: "0.0.1",
      namespace: myNamespace,
      name: "greeter",
      contract: Buffer.from(contractSrc).toString("base64"),
    },
  },
};
const deployTx = { $tx: deployTxBody, $sigs: { [identityId]: kp.sign(deployTxBody) } };
const deployRes = await submit(deployTx);
const contractStreamId = deployRes.$streams.new[0].id;
```

Real captured response — `$namespace`/`$contract` becomes deploy's own `$contract: "contract"` call, and the *new contract's* stream id comes back the same way an onboarded identity's does:

```json
{
  "$streams": {
    "new": [{ "id": "14bcafd35488de48d3d4e8c08d381ccc679986a15bb225760fff7e80c7b72722", "name": "contract.greetertest.../greeter@0.0.1" }],
    "updated": []
  }
}
```

Then run it — `$contract` is now the deployed contract's *stream id* (or `id@version`, per the deployment docs), and critically, `$o` targets a stream that **already exists** (here, the caller's own identity stream, updating it in place rather than inventing a new one):

```js
const runTxBody = {
  $namespace: myNamespace,
  $contract: contractStreamId,
  $i: { [identityId]: {} },
  $o: { [identityId]: { message: "hello from the docs test" } },
};
const runTx = { $tx: runTxBody, $sigs: { [identityId]: kp.sign(runTxBody) } };
const runRes = await submit(runTx);
```

Real captured response:

```json
{
  "$summary": { "total": 1, "vote": 1, "commit": 1 },
  "$streams": { "new": [], "updated": [{ "id": "4f618836d870e1c4893830560f134f4f6672374ee4946b8157ecbdc005cbae34" }] }
}
```

The first attempt at this — targeting a made-up `"greeting-output"` key that had never existed — failed every time with `950`/"Stream(s) not found," for exactly the reason explained above. Retargeting `$o` at a stream that genuinely already existed (the same identity stream used as `$i`) is what made it work.

## Building and submitting the onboarding contract's transaction

Every network ships the `default`/`onboard` contract, which any new identity uses to self-sign itself onto the ledger — no pre-existing authority required. See [transactions.md](transactions.md) for the exact request shape, verified against a real running network as part of this session's work.
