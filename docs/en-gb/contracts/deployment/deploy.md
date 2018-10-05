# New smart contract deployment

When you want to deploy a new smart contract to an Activeledger network you need to first make sure you have an identity  registered on the network and you have reserved a namespace for that identity.

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$i":{
      "[identity stream]":{
        "version":"0.0.1",
        "namespace":"[your namespace]",
        "name":"[contract name]",
        "contract":"[base64 string of typescript contract]"
      }
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```
## Contract Label Links

By creating a contract label instead of having to reference the contract with its stream id you can use the label. Not only does this make it easier to manage when developing your application consuming the contract, it also allows for different contracts to run across different networks.

### Creating Link

To create a new label link to an existing contract the transaction you send to Activeledger looks like :

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$entry":"link",
    "$i":{
      "[identity stream]":{
        "namespace":"[your namespace]",
        "contract":"[contract stream]",
        "link":"[label name]"
      }
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```

### Removing Link

If you want to remove an existing label link the transaction you send to Activeledger is simialir to the above just with a different $entry value.

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$entry":"unlink",
    "$i":{
      "[identity stream]":{
        "namespace":"[your namespace]",
        "contract":"[contract stream]",
        "link":"[existing label name]"
      }
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```