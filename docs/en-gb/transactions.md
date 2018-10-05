# What is a transaction on Activeledger?

Transactions are how you tell Activeledger to run a smart contract. Transactions are a JSON message posted over HTTP to any node of a Activeledger instance. Below is a fully featured transaction :

```json
{
    "$tx": {
        "$namespace": "[contract namespace location]",
        "$contract": "[contract id to run]{@version}",
        "$entry": "[contract entry point]",
        "$i": {},
        "$o": {},
        "$r": {},
        },
    },
    "$selfsign": false,
    "$sigs": {}
}
```

### $tx

This object is the packet information which needs to be signed by all \$i identities. 

#### $namespace

Developers are able to register namespaces on each Activeledger instance this will allow developers to control and take ownership of contracts running on the network. 

There is a reserved namespace name "default" for contracts which ship with Activeledger.

#### $contract

The stream id of the contract that will be processing this transaction.

#### $entry

[Standard contracts](contracts/standard.md) require 3 main entry points these can then access \$entry and with this then run the required function within the contract.

```typescript
this.transactions.entry
```

#### $i

This object is to represent which identities streams will be responsible for this transaction. These means that they have to provide the matching transaction signature. An example for this is if you're the sending party you need to provide authentication that you can send.

The key for this object can be 2 types of values

##### Key - Stream id

This is their identities stream id on the ledger. This is where the ledger knows of the matching public key to provide verification.

##### Key - Self signature

If the transaction is a self signature then this value is just a unique string value for this transaction. This unique name will then be reference by \$sigs below

##### Value

From this point on the values can be defined by the contract developer. Anything added here the developer can access with

```typescript
this.transactions.$i["[key]"].
```

The only exception to this freedom is with a self signed transaction. If you're going to process a self signed transaction there has to be 2 properties 

```json
{
    "type":"[secp256k1 OR rsa]",
    "publicKey": "[Public PEM Format]"
}
```

This is to allow Activeledger to still process the signature validation. It is also useful for contract developers so if they do create a new activity stream they can assign the processing authority.

#### $o

This object follows the same rules as $i however any identities here do not need to provide any signatures for validation. In \$i we used the example of sending in this instance \$o is the receiver. Self signing cannot be used here it only accepts known identities. 

#### $r

This property contains a simple key-value object. This is used for accessing streams state in read only mode. The key is the reference name and the value is the stream id. So to access this read only stream you can call one of  helper functions :

```typescript
let state = this.getReadOnlyStream(this.transactions.$r["reference"])
```

state now contains the current execution time stream state .

### $selfsign

This Boolean instructs Activeledger that the identity issuing the transaction is going to self sign. That means they do not yet have an identity onboarded onto the network but want to raise a transaction. An example of this is [here](README.md) which explains how it is used to onboard. This information is available during the verify phase of contract operation .

### $sigs

This property contains a simple key-value object. They key has to much all the keys provided in the \$i object. The value is the private key signature of the entire \$tx object. 

## Secure Transaction Submission

While the network itself can be configured to secure the communication within itself this doesn't automatically secure the original transaction being sent into the network. You could achieve this yourself by putting Activeledger behind a proxy that can handle the SSL for you (which we do recommend) but it is also possible to encrypt the raw transaction message against the receiving nodes public key. 

At the moment Activeledger doesn't auto detect that the transaction has been encrypted you need to provide a hint using the header :

```http
X-Activeledger-Encrypt:yes
```

If you have used the correct public key for the encryption the transaction will work as normal however if if the node wasn't able to decrypt it for any reason it will return a 500 error with the body "Decryption Error"

## Hardened Keys Example

When the Activeledger network is set to use hardened keys. This does enforce an additional property (**\$nhpk**) which needs to be included within a transaction. This property has to be present inside every object which is forming part of the input (**\$i**). The transaction would now look like :

```json
    "$tx": {
        "$namespace": "[contract namespace location]",
        "$contract": "[contract id to run]{@version}",
        "$entry": "[contract entry point]",
        "$i": {
            "[stream id]":{
                "$nhpk": "[PEM Public Key]"
            }
        },
        "$o": {},
        "$r": {},
        },
    },
    "$selfsign": false,
    "$sigs": {}
}
```





