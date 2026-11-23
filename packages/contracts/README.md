<img src="https://raw.githubusercontent.com/activeledger/activeledger/master/docs/assets/Asset-23.png" alt="Activeledger" width="300"/>

# Activecontracts

The base classes a smart contract extends, and the types it works with.

This package is one part of [Activeledger](https://github.com/activeledger/activeledger). Most people want [`@activeledger/activeledger`](https://www.npmjs.com/package/@activeledger/activeledger), the node and its command line tools, which installs this package for you. Install this one directly only if you are building on it.

```bash
npm install @activeledger/activecontracts
```

Needs Node.js 24 or later.

A contract is one TypeScript file whose default export extends `Standard`. The package gives you:

- `Standard`: the contract class with the three steps, `verify`, `vote` and `commit`, and the stream methods (`getActivityStreams`, `newActivityStream`, `returnToRemote` and the rest).
- `Event` and `PostProcess` / `PostProcessEvent`: contracts that emit events, or run after commit.
- `Stream` and `Activity`: read and write a stream's state, meta and volatile data.

A complete contract, as deployed in the quickstart:

```ts
import { Standard, Activity } from "@activeledger/activecontracts";

export default class Hello extends Standard {
  private message: string;
  private greeting: Activity;

  public verify(selfsigned: boolean): Promise<boolean> {
    return selfsigned ? Promise.reject("No self sign") : Promise.resolve(true);
  }

  public vote(): Promise<boolean> {
    // "sender" is the label the transaction gives the signing stream
    this.message = this.transactions.$i.sender.message as string;
    return this.message ? Promise.resolve(true) : Promise.reject("A message is needed");
  }

  public commit(): Promise<any> {
    this.greeting = this.newActivityStream("greeting");
    this.greeting.setState({ message: this.message });
    this.returnToRemote({ greeting: this.greeting.getId() });
    return Promise.resolve(true);
  }
}
```

Contracts are sent to the network as TypeScript source and every node transpiles them when they are deployed, so you do not compile them yourself. `activeledger audit` checks one before you deploy it, and `activeledger project deploy` uploads it.

## Documentation

- [The Activeledger guide](https://activeledger.github.io/activeledger/)
- [Writing a contract](https://activeledger.github.io/activeledger/contracts/write/) and [The contract API](https://activeledger.github.io/activeledger/contracts/reference/)
- [Source and issues](https://github.com/activeledger/activeledger/tree/master/packages/contracts)

MIT licensed.
