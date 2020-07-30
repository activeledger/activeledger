# Smart Contracts

Activeledger contracts are created with Typescript. When contracts are called they run within a specific Virtual Machine controlling what code they can execute. Contracts need to be registered into a namespace on the running Activeledger network this is to prevent clashes and also allows the network to verify the original uploader of the contract using the ledger itself. These contracts are stored on the ledger and themselves become data assets that are controlled by the consensus and signature verification.

* [How to register a namespace](deployment/namespace.md)
* [How to deploy a new smart contract](deployment/deploy.md)
* [How to upgrade a contract version](deployment/upgrade.md)
* [How to run a contract](deployment/run.md)

### How do the contracts work

Each contract is an exported TypeScript class file. It is this TypeScript file which is submitted to the ledger to another smart contract within a normal Activeledger transaction. Smart contracts are stored on the ledger as encoded TypeScript and are cached after being transpiled.

Activeledger supplies multiple classes to inherit from to help you develop your smart contracts. You can use them individually or combined :

* [Standard](./standard.md) - Provides the basic abstract functions to code to.
* [Post Process](./postprocess.md) - Abstract functions to hook into post commit phase logic.
* [Query](./query.md) - Allows you to query the ledger at contract runtime. ⚠️Deprecated⚠️
* [Event](./event.md) - Allows you to emit events from the contract to trigger external processes.

Smart contracts are promised based allowing you to run long running tasks without causing the rest of the ledger to have any slow downs. This is achieved by how Activeledger manages the data on the ledger and having the sandboxed virtual machines.

## Getting Started

We are in the process of developing tools to help the creation and deployment of contracts.  Until then you do need to manually setup your environment.

You can use your favourite IDE, If it supports TypeScript that will be a bonus. Using Typescript you will need to import the following libraries to get their definition files

```typescript
import { Standard, Activity } from "@activeledger/activecontracts";
```

It is also recommended to use the Activelogger which can be imported by

```typescript
import { ActiveLogger } from "@activeledger/activelogger";
```

These will be published on NPM or you can build them yourself from source.

Following the [standard](./standard.md) documentation you should have your first contract ready to go for [deployment](deployment/deploy.md).

## Contract Timeouts

A smart contract has 3 phases for a successful transaction (Verify, Vote, Commit) and 1 more phase which happens after the successful return of a transaction request (Post). These 4 phases all return promises. Just in case a promise doesn't call its resolve or reject we have timeout management. Not part of the default configuration but there is 2 configurable options to manage timeouts on your node.

contractCheckTimeout - How often is the VM checked to see if it should time out. (Default 10 seconds)

contractMaxTimeout - Total amount of runtime allowed before timeout cannot be extended. (Default 20 minutes from VM start)

As a smart contract developer you may know that you're about to run a long running process and you will need to instruct the VM to not timeout on the next check. You can do this anywhere within your smart contract with this code :

```typescript
// Don't Timeout for another 15 seconds.
this.setTimeout(15000)
```

You can keep calling the above code to keep extending the timeout by another 15 seconds. This will continue to work until you exceed the Max Timeout setting mention above.