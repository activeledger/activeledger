[![Status on NPM](https://img.shields.io/badge/status-release%20candidate-orange.svg)](https://www.npmjs.com/package/@activeledger/activeledger) 
[![npm version](https://badge.fury.io/js/%40activeledger%2Factiveledger.svg)](https://badge.fury.io/js/%40activeledger%2Factiveledger) 
[![npm](https://img.shields.io/npm/dt/@activeledger/activeledger.svg)](https://www.npmjs.com/package/@activeledger/activeledger) 
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

[IDE User Guide](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/ide/README.md)

![Activeledger IDE](https://activeledger.io/wp-content/uploads/2018/10/developer-tools-demo.gif)

### IDE Download

* [Linux](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/ide/README.md)

* [Windows](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/ide/README.md)

* [OSX](https://github.com/activeledger/activeledger/tree/master/docs/en-gb/ide/README.md)

## License

[MIT](https://github.com/activeledger/activeledger/blob/master/LICENSE)