# Activeledger guide

This guide is the least you need to know to run, operate and use Activeledger.
It is for the person who has to stand up a network, keep it running, and send it work.

Activeledger is a distributed ledger: a shared record kept by several computers,
where a change is accepted only when enough of them agree. Application logic lives
in contracts you write in TypeScript. If you have never seen it before, read
[Concepts](concepts.md) first. It takes a few minutes and makes every other page shorter.

## Where to start

Pick the task you have. Each list is in the order to do it.

**Run a node**

1. [Install and build](install.md)
2. [Run a first node, then a small network](first-network.md)
3. [config.json: what you need to set](operate/configuration.md)
4. [How many nodes, consensus, builds and upgrades](operate/nodes.md)

**Send a transaction**

1. [Keys, identities and namespaces](identities.md)
2. [Sending a transaction and reading the result](transactions.md)
3. [The HTTP endpoints you need](api.md)

**Write a contract**

1. [What a contract is](contracts/index.md)
2. [Writing a contract](contracts/write.md)
3. [The contract API you will use](contracts/reference.md)
4. [Deploy, update, lock and unlock](contracts/deploy.md)
5. [Running a contract](contracts/run.md)

**Run a hybrid**

1. [What a hybrid node is and when to use one](hybrid/index.md)
2. [Set up and run a hybrid](hybrid/run.md)
3. [Operating hybrids](hybrid/operate.md)
4. [Writing contracts that also run on hybrids](contracts/hybrid.md)

**Restore a node**

1. [Restoring a node](operate/restore.md)
2. [The activerestore command](cli/activerestore.md)

## Reference

- [The activeledger command](cli/activeledger.md)
- [The activehybrid command](cli/activehybrid.md)
- [The activerestore command](cli/activerestore.md)
- [Keeping it safe](operate/security.md)
- [When something is wrong](operate/troubleshooting.md)

## Three programs

| Program | What it does |
| --- | --- |
| `activeledger` | Runs a node. This is the only one you must run. |
| `activerestore` | Heals a node that has fallen behind or started empty. A node starts it for you by default. |
| `activehybrid` | Runs a hybrid: a lighter node that follows the network but does not vote. Optional. |
