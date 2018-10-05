# Activeledger

This is the main application which processes the ledger and the transaction requests. It runs in a multiple process (if available) environment to increase transactional performance. Using streams as the data building block it allows consensus to be reached simultaneously for unrelated transactions. Each of these transactions can live in those separate processes. The main advantage is if there is a long running smart contract this doesn't block those unrelated transactions from processing and reaching consensus. An example of this is if you're wanting to interoperate with another ledger the contract can wait for that ledgers confirmation without impact on Activeledger. 

## CLI Arguments

###### --testnet [number]

This will create a locally hosted Activeledger network. By default it will generate a 3 node network. If you wish to create a larger network. Each node by default will share the same private key but the key will be stored inside inside each nodes instance directory.

###### --assert [contract stream id] or --assert-network [contract stream id]

When you have setup your initial network and all the nodes have joined by running this command option it will trigger a smart contract pross on Activeledger to move from file based configuration to ledger based configuration. Some file options are persistent as they're not network relevant such as the autostart feature.

Upon a successful assertion to the network the configuration file will be compacted but it will create a backup first.

The optional assert value [contract stream id] will setup the new ledger stream to be contract locked to both the default/setup contract which is bundled with Activeledger and another contract which has previously been uploaded into the network.

###### --db-only

Will only startup the embedded data storage engine.

###### --config \<path\>

Provide different location for the configuration file. Default location is ./config.json.

###### --port \<number\>

Provide a different binding port. Default port is 5260

###### --host \<ip address\>

Provide a different binding address Default address is 127.0.0.1

###### --identity \<path\>

Provide a different path to the identity file Default location is ./.identity

###### --data-dir \<path\>

Provide a different path for the data storage. Default location is ./.ds/

###### --merge \<path\> ...

This will merge each passed configuration file's network mapping into each other making it easier to create a valid network object.

###### --sign [file]

Will return this node's signature for that file. If the file contains a transaction object it will automatically sign just the contents of $tx and nothing else. Your main use for this argument is for :

[Adding & Removing nodes in the network](dynamic-nodes.md)

[Request & Revoke Namespace module access](contracts/deployment/namespace.md)

###### --setup-only

Manages just the configuration options for creating a network. It will prevent Activeledger from starting up.







