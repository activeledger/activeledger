# Contract Namespace Management

A namespace is used to group contracts into one location on the ledger. They all share the same signing key to allow for the identification of the contract author and to also validate the script hasn't been tampered with. 

Another advantage to registering a namespace for the developer is they can request additional resources to be available with the VM runtime that is processing their smart contract code. This means if you require additional modules to run within your contract you are able to include them. The namespace is there to isolate these additional resources so no other developer can code against them.

## Register a namespace

The reason you want to register a namespace is so that you can own a space on the ledger which references your smart contracts. It allows the ledger itself to validate you have the required access to deploy contracts into that Activeledger network. 

To register a namespace you're creating a transaction that runs a default contract that ships with Activeledger. 

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"namespace",
    "$i":{
      "[identity stream]":{
        "namespace":"[namespace]"
      }
    }
  },
  "$sigs":{"[identity stream]":"[signature]"}
}
```

## Request Native Module

If you want to require a standard NodeJS module within your smart contract you first need to have that module approved for your namespace to consume. To get this approval you need to get enough signatures of the network node hosts to reach consensus to run the request contract. For example you have the namespace **example** and you want to allow your contract to access the http module. The transaction request would look like this :

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "setup",
        "$entry": "approve",
        "$i": {
            "suggester": {
                "type": "[rsa | secp256k1]",
                "publicKey": "[PEM Public Key]",
                "namespace": "example",
                "libs": {
                	"std":"http"
                }
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

For this transaction to be successful you would need to have enough host node signatures inside the $sigs object to reach consensus. This transaction is similar to [dynamically adding and removing nodes](dynamic-nodes.md).

The **std** property can accept both a string or a string array so if your require multiple modules you only need one transaction.

## Revoke Native Module

It is also possible to remove all the allowed modules on a specific namespace. To revoke these modules just like with the request you need to get enough host node signatures on the transaction to reach consensus. To remove the added modules in the namespace **example** the transaction would be :

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "setup",
        "$entry": "revoke",
        "$i": {
            "suggester": {
                "type": "[rsa | secp256k1]",
                "publicKey": "[PEM Public Key]",
                "namespace": "example"
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

