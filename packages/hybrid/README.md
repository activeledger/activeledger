<img src="https://www.activeledger.io/wp-content/uploads/2018/09/Asset-23.png" alt="Activeledger" width="300"/>

# Activehybrid Connect

Maintain every permissioned chain yourself, When you're not able to reach consensus to join the main network nodes Hybrid Connect allowes you to still have processing access to the transactions. If you have access to 1 or more main network nodes (upstream) they will relay all transactions to your hybrid node. The hybrid node doesn't assume that these upstream servers are trustworthy. What this means is all transactions will still be verified and all smart contracts are run locally.

Transactions are always relayed, The main network node may not pass the voting round for a specific transaction but it will send it to the connected Hybrid nodes. Transactions are relayed immediately after a failure is raised or the transaction is commited on that node. 

## Best Effort Eventual Conesnsus

To reduce the load on the upstream servers and the network, Hybrid nodes use a Best Effort Eventual Consensus mechanism. This consensus is improved as more upstream servers allow access. As Activeledger is transactional based the Hybrid node doesn't need the entire dataset to form consensus. If using the quick start method any missing data for a transaction to be processed is relayed by the upstream server(s) transaction checkpoints to speed up the processing.

## Getting Started

### Hybrid Connect Client Side

```bash
activehybrid
```

Modify the upstream section like so

```json
{
  "upstream": {
    "scheme": "http",
    "remote": "127.0.0.1",
    "port": 5260,
    "auth": "@uthC0de" // Create / Use Provided Random Authentication Code
  }
}
```

### Upstream Server Side

Modify the nodes config.json file. Currently after making the file change you need to restart your activeledger instance. 

```json
{
  "hybrid": [
    {
      "active": true,
      "url": "http://ip:5260",
      "auth": "@uthC0de" // Create / Use Provided Random Authentication Code
    }
  ]
}
```

## Contract Developer Notice

All contract features are supported there are however a few quirks to bare in mind. A hybrid node will always anounce itself as a hybrid instead of the usual reference. If you're using INC (Internode Communication) and this information is not shared currently to hybrid nodes. Territoriality information is also currently not shared.

| Language |                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------- |
| English  | [documentation](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/configuration.md) |
| Chinese  | [说明文档](https://github.com/activeledger/activeledger/tree/master/docs/zh-cn/configuration.md)      |
