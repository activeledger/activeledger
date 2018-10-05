# Version Upgrade of a Smart Contract  

Activeledger supports versioning of smart contracts. When running a contract you can choose either a specific version or always run the latest.

```json
{
  "$tx":{
    "$namespace":"default",
    "$contract":"contract",
    "$entry":"update",
    "$i":{
      "[identity stream]":{
        "version":"0.0.2",
        "namespace":"[your namespace]",
        "name":"[contract name]",
        "contract":"[base64 string of typescript contract]"
      }
    },
    "$o":{
      "[contract stream]": {
      }
    }
  },
  "$sigs":{"[identity stream]":"[signature of $tx object]"}
}
```

