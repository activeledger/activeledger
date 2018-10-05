# Run your Smart Contract

When it comes to running your smart contract it is just about issuing a transaction to Activeledger. As the contract developer you have full control of all the inputs and outputs that activity streams will be processed on. This is the meaning of \$i and \$o in the transactions you have run until this point. The activity stream id contains an object this object properties are fully defined by you and your contract is what acts upon them.

```json
{
  "$tx":{
    "$namespace":"[your namespace]",
    "$contract":"[your contract stream]@[version] OR [your contract stream]",
    "$i":{
        "[input stream]":{
            /* properties consumed by your contract */
        }
    },
    "$o": {
        "[output stream]": {
            /* properties consumed & updated by your contract */
        }
    }
  },
  "$sigs":{"[input stream]":"[signature of $tx object]"}
}
```

