[![Status on NPM](https://img.shields.io/badge/status-release%20candidate-orange.svg)](https://www.npmjs.com/package/@activeledger/activeledger) 
[![npm version](https://badge.fury.io/js/%40activeledger%2Factiveledger.svg)](https://badge.fury.io/js/%40activeledger%2Factiveledger) 
[![npm](https://img.shields.io/npm/dt/@activeledger/activeledger.svg)](https://www.npmjs.com/package/@activeledger/activeledger) 
[![lerna](https://img.shields.io/badge/maintained%20with-lerna-cc00ff.svg)](https://lernajs.io/)
[![MIT license](https://img.shields.io/badge/License-MIT-blue.svg)](https://lbesson.mit-license.org/)


<img src="https://www.activeledger.io/wp-content/uploads/2018/09/Asset-23.png" alt="Activeledger" width="300"/>

Activeledger is a powerful distributed ledger technology. Consider it as a single ledger updated simultaneously in multiple locations. As the data is written to a ledger, it is approved and confirmed by all other locations.

## Installation

Please see our documentation for detailed instructions. We currently have 2 languages available.

|Language| |
|--------|-|
|English| [documentation](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/README.md)|
|Chinese| [说明文档](https://github.com/activeledger/activeledger/tree/master/docs/zh-cn/README.md)|


## Quickstart Guide

Use NPM to install the 3 main applications for running activeledger.

```bash
npm i -g @activeledger/activeledger @activeledger/activerestore @activeledger/activecore
```

##### Creating a local Activeledger testnet

Run the following command to create a 3 node local testnet.

```bash
activeledger --testnet
```

![Activeledger Create Testnet](https://www.activeledger.io/wp-content/uploads/2018/10/testnet-create.png)

When the testnet has been created you can run all of them at once but running

```bash
node testnet
```

Alternatively you can run each instance of Activeledger independantly by navigating into the instance-x folders which have been created and running

```bash
activeledger
```
![Activeledger Launch Testnet](https://www.activeledger.io/wp-content/uploads/2018/10/testnet-run.png)

## Developer Tools

We have created an IDE for developers to create and manage Activeledger smart contracts across multiple networks. This IDE helps manage the private keys for developers to sign their contracts with and the namespaces their contracts will be stored under in each specific network. This tool is currently in beta but is available for Linux, Windows and OSX.

[IDE User Guide](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/ide/README.md) | [用户指南](https://github.com/activeledger/activeledger/tree/master/docs/zh-cn/ide/README.md)

![Activeledger IDE](https://activeledger.io/wp-content/uploads/2018/10/developer-tools-demo.gif)

### IDE Download

Register at our [Developer Portal](https://developers.activeledger.io/) to download the latest version of the IDE

## Public Testnet

We are currently running a free to use public testnet of Activeledger.

#### Important Information

1. This is an open ledger network do not upload information you don't want to be public as *anyone* will be able to view it.
2. Transactions to the ledger are restricted to 1 per second per IP.
3. Requests to the api are restricted to 3 per second per IP.
4. Uploads are restricted to 12kb in size.

Also as this is a testnet at **anytime we may reset the entire ledger.**

### Nodes & Endpoints

#### Hong Kong

* Node -  http://testnet-asia.activeledger.io:5260/
* API - http://testnet-asia.activeledger.io:5261/api
* API Explorer - http://testnet-asia.activeledger.io:5261/explorer/

#### United States of America

* Node -  http://testnet-usa.activeledger.io:5260/
* API - http://testnet-usa.activeledger.io:5261/api
* API Explorer - http://testnet-usa.activeledger.io:5261/explorer/

#### Europe

* Node -  http://testnet-eu.activeledger.io:5260/
* API - http://testnet-eu.activeledger.io:5261/api
* API Explorer - http://testnet-eu.activeledger.io:5261/explorer/

#### United Kingdom

* Node -  http://testnet-uk.activeledger.io:5260/
* API - http://testnet-uk.activeledger.io:5261/api
* API Explorer - http://testnet-uk.activeledger.io:5261/explorer/


## Building from source

### Prerequisites

We use [lerna](https://lernajs.io/) to manage this monorepo. Make sure you have lerna installed.

```bash
npm install --global lerna
```
### Building

```bash
npm i
npm run setup
```

## License

[MIT](https://github.com/activeledger/activeledger/blob/master/LICENSE)