# Configuration File

Activeledger does have a single configuration file which is used by the 3 running instances ([activeledger](ledger.md), [activecore](core.md) & [activerestore](restore.md))

The configuration allows for each Activeledger instance to be customised and who has the ability to join this network as a fully permissive participant.

```json
{  
  "debug": true,
  "security": {
    "signedConsensus": true,
    "encryptedConsensus": true,
    "hardenedKeys": false
  },
  "host": "external-ip:5260",
  "proxy": "optional",
  "db": {
    "selfhost": {
      "host":"127.0.0.1",
      "port":"5259"
    },
    "url": "http://[user]:[pass]@[host]:[port]",
    "database": "main ledger storage",
    "error": "ledger error storage",
    "event": "ledger events storage"
  },
  "consensus": {
    "reached": 60
  },
  "autostart": {
    "core": true,
    "restore": true
  },
  "rate": {
    "minutes": 10,
    "limit": 20,
    "delay": 0
  },
  "CORS": ["http://example.com", "http://*.example.net"],
  "neighbourhood": [
    {
      "identity": {
        "type": "rsa",
        "public":
          "Public Key PEM format"
      },
      "host": "ip",
      "port": "5260"
    }
  ]
}
```

## Debug

Enabling debug mode will make the console output more verbose as well as the response from a transactional message will provide more information. When a node is not in debug mode it will not return any specific contract errors instead a general fault message will be returned during the vote & commit phase.

## Security

The network has multiple security options which may not be needed for all permissioned networks. While they provide additional security they do also increase the transaction processing overhead.

### Signed Consensus

Enabling signedConsensus will mean the receiving node will be able to verify that the data did come from the node it expected it to come from. This enabled inbound confirmation.

### Encrypted Consensus

Enabling encryptedConsensus this takes the signing consensus one step further the sending node will actually encrypt the data it wants to send on to the next node. This enables outbound confirmation.

### Hardened Keys

This enabled a transaction policy. It will require all \$i to contain a new property which is $nhpk. This stands for New Hardened Public Key. The value of this property needs to be a new public key in PEM format matching the current identity stream key type. This policy means there will only ever be 1 signature per valid transaction.

## Host

The external ip address and port that this node will be bound to.

## Proxy

When Activeledger is exposed to the internet via another port this settings allows Activeledger to know which port it is on.

## db

Currently Activeledger supports 2 data store engines. There is the embedded one that is self hosted by the Activeledger runtime and the external (CouchDb v2.1.1+). The aim is to support multiple data engines in the future. Currently all the nodes in a network have to use the same data store engine. This is on the roadmap to allow mixing of data storage engines.

### selfhost

The presence of this object instructions Activeledger to start up the embedded data engine.

#### host

Address for the embedded engine to listen on. (127.0.0.1 is recommended due to open permissions)

#### Port

Port for the embedded engine to listen on.

### url

The url to the CouchDB instance this node will use. The url can contain the login credentials if required.

### database

This is the main Activeledger data store location. This is where the stream states end up after the contract has made its relevant changes.

### error

Activeledger stores all transactional errors on the ledger. This assists the ledger in finding potentially bad data.

### event

When a contract raises an event this is where the event is stored for processing.

## Consensus

Allows you to set in percentage how much of the network has to be in agreement of a transaction (the voting phase) before it can be considered a valid transaction.

## Autostart

Enables Activeledger to auto startup the additional services.

## Rate

Activecore request rate limiter settings.

## CORS

To setup CORS for direct web transaction posting to the network node visit [CORS Middleware](https://github.com/Tabcorp/restify-cors-middleware/blob/master/README.md#allowed-origins). It accepts an array value of allowable web addresses.

## Neighbourhood

An array of node identities which are allowed to join this permissioned network. It is important to include your own node's details in this list.

### Identity

Every full node needs an identity to participate in maintaining the ledger. Activeledger will generate this identity for you on the first time you run Activeledger. This identity will be stored in the current working directory with the filename .identity.

### Host

The external address for this node.

### Port

The external port for this node.

## Optional Configuration

### contractCheckTimeout

How often should the VM running the smart contract should check to see if the timeout has been reached. Default value is every 10000ms.

### contractMaxTimeout

How long can the timeout be extended by. The default value is 20 minutes from the initial starting of the smart contract. The smart contract cannot extend its runtime beyond this point.