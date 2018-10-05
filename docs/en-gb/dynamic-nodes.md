# Dynamic Node Management

To enable dynamic node management you must first have asserted your network from [file based configuration to ledger based](README.md#convert-file-based-configuration-to-ledger-based-configuration). When adding or removing a node from the network you will be issuing a multi signature transaction. The signatures will have to come from the network node hosts. You do not need to obtain all of the host node signatures just enough to reach your configured consensus.

As node identities are different from the standard transaction based identities we will be issuing the following transaction as a self signed transaction. We will be using the nodes file based identities (./.identity) to provide additional signatures which the smart contract will use to verify.

In the below examples you will see a reference to **network configuration stream** this can be found inside the compacted configuration file under the property **network**.

### Adding Node

When adding a node the transaction only needs to be submitted once enough signatures have been obtained for a successful transaction. The smart contract will return errors if more signatures are needed. 

When submitting a new node request you will need to provide the data under the self signed object and provide the new nodes generated identity and its hosted location.

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "setup",
        "$entry": "add",
        "$i": {
            "suggester": {
                "type": "[rsa | secp256k1]",
                "publicKey": "[PEM Public Key]",
                "identity": {
                    "type": "rsa",
                    "public": "[new-node-pem]"
                },
                "host": "[new-node-ip]",
                "port": 5260
            }
        },
        "$o":{
        	"[network configuration stream]":{}
        }
    },
    "$selfsign": true,
    "$sigs": {
        "suggester": "[signature]",
        "[node-1-ip]:5260": "[signature]",
        "[node-2-ip]:5260": "[signature]"
    }
}
```

### Node Removal

When removing a node the transaction only needs to be submitted once enough signatures have been obtained for a successful transaction. The smart contract will return errors if more signatures are needed. 

When submitting a node removal request you will need to provide the data under the self signed object and provide the details about the node you would like to be removed.

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "setup",
        "$entry": "remove",
        "$i": {
            "suggester": {
                "type": "[rsa | secp256k1]",
                "publicKey": "[PEM Public Key]",
                "identity": {
                    "type": "rsa",
                    "public": "[node-3-pem]"
                },
                "host": "[node-3-ip]",
                "port": 5260
            }
        },
        "$o":{
        	"[network configuration stream]":{}
        }
    },
    "$selfsign": true,
    "$sigs": {
        "suggester": "[signature]",
        "[node-1-ip]:5260": "[signature]",
        "[node-2-ip]:5260": "[signature]",
        "[node-4-ip]:5260": "[signature]"
    }
}
```

This same technique can be used to allow native NodeJS modules to be required within a smart contract which has a specific namespace. [Learn more about namespace modules](contracts/deployment/namespace.md).

