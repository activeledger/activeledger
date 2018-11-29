# Creating your first network

In this guide we will show you how to setup your first Activeledger network across multiple machines. These machines can be in the cloud or physically located.

If you're only looking to run test code on Activeledger you can use the built in testnet feature. [Testnet information can be found here](README.md#creating-a-local-activeledger-testnet)

## Minimum Requirements

Currently Activeledger is deployed as a permissioned ledger. One of the advantages to this setup is the reduced requirment of system resources. This means while your network isn't busy with transactions you can start with minimal system resources and then scale them as your network traffic increases like a traditional server application.

- OS : Linux (Debian Recommended)
- CPU : 2 vCores+
- Memory : 2GB+
- Storage : Application Specific (SSD Recommended)

## Single machines to an Activeledger network

Follow these [installation instructions](README.md#linux-installation-debian--ubuntu) to make sure your machines are ready to continue with the network setup. With Activeledger now available on all your machines all that is left is to generate the config.json.

### On every machine run the following

1. Create a new directory and enter it. (Recommended)
   ```bash
   mkdir activeledger & cd activeledger
   ```
2. Run Activeledger with the public argument
   ```bash
   activeledger --public
   ```
   This will setup a basic node file structure and output its public key.

Now on your local desktop go to the [Configuration Builder](https://activeledger.io/builder.html) and use the builder to generate the config.json file. Under the "Nodes" tab of the configuration builder you can copy / paste the outputs of step #2 above.

3. Overwrite the default config.json file with the one from the builder\*
   ```bash
   > config.json
   vi config.json
   ```
4. Run Activeledger
   ```bash
   activeledger
   ```

If you want to have Activeledger autostart with the system you can use PM2 with these [instructions](README.md#start-activeledger-at-system-boot).

It is also recommended to convert your newly created Activeledger network from [file based configuration to running from the ledger itself](README.md#convert-file-based-configuration-to-ledger-based-configuration). The main advantage to this is it makes it easier to add or remove nodes from the network.

\* We will be providing a cli download option.
