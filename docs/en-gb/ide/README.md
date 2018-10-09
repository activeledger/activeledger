# Activeledger IDE (Active Harmony) User Guide

In this guide we will explain how to setup the IDE so you can begin publishing smart contracts right away. As you can see in the image below, the IDE will take care of everything for you, allowing you to concentrate on your smart contract logic.

![Activeledger IDE](https://activeledger.io/wp-content/uploads/2018/10/developer-tools-demo.gif)

### 1. Connection Setup

The first step is to configure the Activeledger node connections. On the top right you will see a spanner icon. Click this to load the General settings screen.

![General Settings](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-50-00.png)

Under the *Connections* section add the location of your Activeledger node. If you're running a local testnet you can use these settings :

* Name : Local Testnet
* Protocol : http
* Address : localhost
* Port : 5260

Encrypted Transactions is not required. However, if you are submitting transactions over an untrusted network this will hide the transaction data.

In the general settings you will find other options. The most important one is the backup and restore functionaility. The backup function allows you to generate a single file that exports all the information within the IDE. It has a password protection function, as this backup can include your private keys.

### 2. Key Generation

As smart contracts are stored on the ledger itself you need to have an identity registered on each network you will be publishing contracts to. 

On the left hand side select *Keys*, you will be taken to a screen which lists all the keys managed in the IDE. You will find a tab labeled *Generate*. Here you can create a new key and onboard it to a previously entered connection. (You don't have to onboard a key right away)

![Key Management](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-50-32.png)

### 3. Namespaces

[Namespaces](../contracts/deployment/namespace.md) are designed to prevent collisions. Contracts are stored inside a namespace as an Activeledger asset and they are referenced by unique stream IDs. They also allow additional libraries to be imported into the smart contract VM. 

To register a namespace, on the left hand side select *Namespaces* and you will be taken to a screen which lists all the registered namespaces. You will find a tab labeled *Create*. Select this tab and you can create a namespace for a specific key. Currently Activeledger only supports a single namespace per key. However, you can maintain as many keys as you need.

Select your key and enter a name for your namespace. After clicking save, the IDE will create a transaction request to the network the key is registered to and attempt to reserve your namespace if it hasn't already been taken.

![Namespace Management](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-51-39.png)

### 4. Writing Smart Contracts

Now the IDE is ready to publish your [smart contracts](../contracts/README.md). You can create a new smart contract from anywhere within the IDE by clicking the quick action button on the top left (the + icon). This will load up a code editor with built in auto completion. You can learn more about the basics of [writing a smart contract here](../contracts/standard.md).

![Composing Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-52-43.png)

Clicking the save icon at the top of the editor will allow you to set the name and version of this smart contract. Remember, Activeledger supports multiple versions of contract code so you can continue to revise and update the contract but still run transactions against previous versions.

![Version Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-06.png)

### 5. Uploading Smart Contracts

Once you have written and saved your smart contract you need to publish it to an Activeledger network. On the same screen you will see a tab labeled *Upload*. Select this tab to open the upload manager. On the left hand side you will see all the smart contracts the IDE is managing. When you select the smart contract you wish to upload it will default to the latest version. If you wish to upload a different version there is a small arrow on the right hand side above the minimap. This will open a dropdown menu allowing you to change versions and manage other settings.

When you have selected your contract you need to choose the network you would like to upload to. Below the editor you will be able to select the key, namespace, and connection you would like to use. Clicking *upload* will generate a new transaction with your smart contract as the payload. 

![Upload Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-25.png)

### 6. Managing Smart Contracts

On the same screen you will see a tab labeled *Editor* this will list all the smart contracts the IDE is aware of, both local only and published. If the smart contract has been publish you can access its stream ID via 2 methods. 
Activeledger also supports contract labeling to make it easier to run smart contracts. This is can be done by going to the contract information. In the Editor tab click "Show" under "Info" or in an open contract, select the kebab icon in the top right and click "Show info".

![Manage Smart Contracts](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-45.png)

* The first "Stream ID" will show a dialog listing all the networks the smart contract has been uploaded to and the corresponidng stream id. 

* The second "Info" will change the page and provide further information about the smart contract status. From this screen you can also add reference labels for a smart contract so you can run the contract using the label name instead of having to remember the longer stream id. Referenced contract names allow you to reuse a transaction across multiple networks but run different contracts.

![Manage Smart Contracts Detail](https://activeledger.io/wp-content/uploads/2018/10/2018-10-09_11-53-51.png)
