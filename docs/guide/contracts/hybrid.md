# Writing contracts that also run on hybrids

What to do in a contract so that it behaves well when a hybrid node runs it. If your network has no hybrids, nothing on this page is needed.

## How a hybrid runs your contract

A hybrid is a node that follows the network without voting (see [What a hybrid node is](../hybrid/index.md)). The voting nodes are called supernodes. When the supernodes commit a transaction, the hybrid receives it and runs the contract itself, then compares its own result with what the supernodes signed. A match is proof the hybrid holds the same data. A mismatch is a divergence, which the hybrid records and repairs.

Most contracts need no change: the same inputs give the same outputs on every node. A contract only differs on a hybrid when it uses something only a supernode has, such as a call to an outside service. A hybrid cannot make outbound network calls at all: `http`, `https`, `net`, `tls`, `dgram` and `fetch` throw `<name> is only available on a supernode` inside a contract there.

## `this.isSupernode()`

`isSupernode()` is available in every contract. It returns `true` on a supernode and `false` on a hybrid. Put supernode-only work inside it:

```ts
if (this.isSupernode()) {
  // outside call, volatile, anything only a supernode can do
} else {
  // what the hybrid does instead
}
```

Calling it also tells the hybrid that this run depends on the supernodes. The hybrid then expects its own result to differ, and instead of recording a divergence it **adopts** the supernodes' signed result: it fetches the committed documents, checks their hashes against what the supernodes attested, and saves them.

Fork on `isSupernode()` only where the work differs. Code that does not call it is checked in full, which is what you want.

## Say what the supernode branch writes

Adopting the whole document means the hybrid takes the supernodes' word for everything in it. The safety net is to declare, in the `else` branch, exactly which properties the supernode branch writes. The hybrid then accepts differences in those properties and nothing else.

On a stream (an `Activity`):

```ts
order.adoptFromSupernode({ signature: "string", status: "string" });
```

The shape maps each property name to a type: `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"` or `"any"`.

- A `?` suffix (`"string?"`) means the supernode may set the property, leave it out, or delete it.
- A nested object describes nested properties: `{ quote: { price: "number", at: "string" } }`.
- `{ atomic: true }` as a second argument means the declared properties change all together or not at all.
- `_id` and `_rev` cannot be declared, and the shape must name at least one property.

On a supernode the call does nothing. On a hybrid it records the declaration and marks the stream as written, so the hybrid's own result has a document to compare with.

When the hybrid checks an adopted document, it removes the declared properties from both the signed document and its own result; what remains must be identical, and each declared property must have its declared type. Anything else is a real divergence and is recorded as one.

If the supernode branch creates a new stream, the `else` branch must create the same stream (same name) with placeholder values and declare its properties. A signed document with no local counterpart is rejected.

### When the supernode branch decides which streams change

Use the contract-level form when supernode-only work chooses the streams, not only their values:

```ts
this.adoptStreamsFromSupernode(["alice", "bob"], { balance: "number" }, { atomic: true });
```

The names must be inputs or outputs of the transaction (`$i`/`$o` keys or their stream ids). Each listed stream may come back unchanged, or changed only within the shape.

## What happens with no declaration

A run that called `isSupernode()` (or hit the network block) but declared nothing is still adopted, in full. The hybrid emits an `adopt.undeclared` event naming the contract and `$entry`, so a missing safety net is visible to whoever operates the hybrid (see [Operating hybrids](../hybrid/operate.md)). Treat that event as a bug report against the contract.

## Volatile

Volatile is a stream's scratch space that stays on the node that wrote it. It is never shared, served or synced: a hybrid reads and writes its own copy, like every node. Because of that:

- A contract may keep something like `Date.now()` in volatile, but must not expect it to be the same on another node.
- Reading volatile does not mark a run as supernode-dependent.
- `setVolatile()` on a hybrid writes the hybrid's own copy.
- A contract that wants volatile only on supernodes forks on `isSupernode()` and builds something else on the hybrid.

Never put a per-node value into state. State is what consensus compares, and a value that differs per node makes every node disagree.

For time, use `this.cDate`: it is the transaction's own timestamp, set once when the transaction entered the network, so it is the same on every node and on a hybrid.

## Locks

A hybrid honours contract locks (see [Deploy](deploy.md)). A `lock` or `unlock` committed on the supernodes reaches the hybrid like any other transaction, and the hybrid writes or removes its own lock file. A transaction pinned to a locked version does not commit, whether it is sent to a supernode or relayed through a hybrid.

Deploys, updates and locks themselves must go to a supernode: a hybrid refuses them with `default/contract is not accepted by a hybrid`.

## A worked example

A contract that has an outside service sign an order. Only a supernode can make the call, so the hybrid declares what the call writes.

```ts
import { Standard, Activity } from "@activeledger/activecontracts";
import { HTTP } from "@activeledger/activetoolkits";

export default class Sign extends Standard {
  private order: Activity;

  public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise((resolve, reject) => {
      selfsigned ? reject("No self sign") : resolve(true);
    });
  }

  public vote(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const outputs = Object.keys(this.transactions.$o);
      if (!outputs.length) return reject("Need an order to sign");
      this.order = this.getActivityStreams(outputs[0]);
      resolve(true);
    });
  }

  public commit(): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      const state = this.order.getState();
      if (this.isSupernode()) {
        // Only a supernode may reach outside the network
        const reply = await HTTP.send(
          "https://sign.example.com/orders",
          "POST",
          undefined,
          { order: this.order.getId() }
        );
        state.signature = (reply.data as { signature: string }).signature;
        state.status = "signed";
        this.order.setState(state);
      } else {
        // A hybrid cannot make that call. Say what the call writes, and
        // the hybrid will take those two properties from the supernodes
        this.order.adoptFromSupernode({ signature: "string", status: "string" });
      }
      resolve(true);
    });
  }
}
```

On a supernode the `else` branch never runs. On a hybrid the `if` branch never runs, the hybrid adopts `signature` and `status` from the supernodes' signed document, and everything else on the order must match what the hybrid computed itself. Had the `else` branch been left empty, the hybrid would still adopt the document, but would emit `adopt.undeclared` every time.
