# Activeledger V2 Documentation

Activeledger is a protocol for distributed ledger technology (DLT). Activeledger is built in a module fashion allowing for easier maintenance and upgrade paths.

* [configuration](configuration.md) - Activeledger network configuration.
* [contracts](./contracts/README.md) - How to & Premade smart contracts to inherit from.
* [core](core.md) - API to expose the ledger data, events and subscription to changes.*
* [crypto](crypto.md) - Wrapper for managing multiple cryptographic options.
* definitions - Specific TypeScript definition files to help with contract development.
* [ledger](ledger.md) - This is the main Activeledger process.*
* logger - Wrapper for providing logging information out output to the terminal.
* network - P2P network handler.
* protocol - Underlying protocol which handles consensus and the smart contract virtual machine.
* query - Wrapper to enable querying of the ledger data. ⚠️Deprecated⚠️
* [restore](restore.md) - Handles the network healing and rebuilding from an empty node.*

\* These are 3 individual applications to run. Only Activeledger is required but the other 2 are recommended. The reason they have been separated is to give deployment control for performance and cost.

## Installation

##### Linux Installation (Debian / Ubuntu)

Make sure your system is up to date.

```bash
sudo apt-get update
sudo apt-get upgrade
sudo apt-get install git build-essential
```

Activeledger run in the Node.js environment. Below will help you install the Node runtimes as a local user account (not needing su).

````bash
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.11/install.sh | bash
````

To learn more about the above command visit http://www.nvm.sh. This has installed an application called nvm (Node version Manager). Using this to install the latest 9.X release of node.

````bash
nvm i 10
````

This will download the latest release of Node version 10. Then you just need to install Activeledger into the global scope of Node.

```bash
npm i -g @activeledger/activeledger @activeledger/activerestore @activeledger/activecore
```

After this installation is complete you can start your Activeledger node by running the command :

```bash
activeledger
```

This will generate a new identity for this node, It will create the default configuration file and in this mode setup the data store directory. Using the configuration file you can setup the neighbourhood object from other nodes outputs.

##### Creating a local Activeledger testnet

It is possible to run mutiple instances of an Activeledger on the same host. To help setup & run these instances you can use the activeledger cli directly. To create a 3 node network all you need to do is run

```bash
activeledger --testnet
```

If you wish to run more than the default 3 nodes you can pass that as an argument

```bash
activeledger --testnet 10
```

When running all the instances on the same host machine the API & Restore engine is disabled on all but the default instance running on port 5260 (instance-0). The API will be available on port http://localhost:5261 the explorer will be available on http://localhost:5261/explorer. 

##### Creating a live Activeledger network

[How to create your first network](create-first-network.md).

##### Convert File Based Configuration to Ledger Based Configuration

When you have setup your initial network you should migrate to having it boot up from the ledger instead of the file based configuration. Doing this allows you to issue transactions which can [dynamically  add / remove nodes](dynamic-nodes.md) from the network.

To convert the configuration when all the nodes are connected run this command

```bash
activeledger --assert
```

This will remove the majority of the configuration from the file and place it into a new activity stream. The configuration file will still exist to point to that activity stream and to provide local configuration options such as autostart.

[learn more about dynamically adding and removing nodes](dynamic-nodes.md)

###### Network Assertion Extension with Contract lock

By default when running the Activeledger CLI with the assert argument the new ledger stream that now manages the configuration across the network can only be modified by the default/setup contract. You can extend this to include another contract that already exists on the network. To do this you pass a value with the assert argument. The value you pass is the stream id of the contract you have previously installed.

```bash
activeledger --assert [contract stream id]
```

##### Windows NVM & NodeJS Installation

There is also a NVM tool for windows which is recommended https://github.com/coreybutler/nvm-windows.  With NVM installed use it to find the latest 9.X and install

````powershell
nvm list available
nvm install 10.XX.X
````

Windows also requires build tools as well but these can be installed with npm.

```powershell
npm i -g --production windows-build-tools
```

Some of the package dependencies requires access to git repositories. To install git please visit one of these websites :

- https://desktop.github.com
- https://gitforwindows.org
- https://git-scm.com/downloads

From this point onwards you can follow the above instructions.

##### Start Activeledger at system boot

[PM2](http://pm2.keymetrics.io/) can be used to manage system processes including starting up script on system boot. First install PM2.

```bash
npm i -g pm2
```

Then setup PM2 to run the Activeledger process.

````bash
pm2 start activeledger
````

Then we can use PM2 to setup the auto startup feature.

````bash
pm2 startup
````

This may output further instructions to the screen. After running this instructions all that is left is to update the PM2 instance to boot up with using :

````bash
pm2 save
````

Activeledger should now be running at system boot.

###### Installation Notes

Activeledger will be running with its embedded data store engine. At this moment in time the network has to be using the same source embedded or external. It is on the roadmap to enable data storage engine mixing.

## Onboarding as an Identity

You're able onboard an identity to a brand new Activeledger network by using a default contract which ships with Activeledger. This default contract accepts self signing to add your public identity to the network. All you need to do is issue this transaction message to the network :

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "onboard",
        "$i": {
            "identity": {
            	"type":"[secp256k1 OR rsa]",
                "publicKey": "[Public PEM Format]"
            }
        }
    },
    "$selfsign": true,
    "$sigs": {
        "identity": "[signature of $tx object]"
    }
}
```

This message is sent as a raw POST to the Activeledger instance for example :

```
http://127.0.0.1:5260
```

On response to this transaction you will be given a new stream id. 

```json
{
    "$umid": "e0b99c48b1547389a8a71b0543a9b95dfd9c4991989419959242a67ca5e4d356",
    "$summary": {
        "total": 30,
        "vote": 30,
        "commit": 30
    },
    "$streams": {
        "new": [
            {
                "id": "aedc2f06256a284c9f0be7ba914bf8c80d7fb765d489c2387be1b1d674776180",
                "name": "activeledger.default.identity.name"
            }
        ],
        "updated": []
    }
}
```

This stream id is what you use for \$i \$o and the value of \$r when creating a transaction. [Learn More](./transactions.md)