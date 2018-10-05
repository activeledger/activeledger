# 智能合约的版本更新

Activeledger支持智能合约的版本选择，用户可以选择特定版本的智能合约或者一直使用最新版本的合约。

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
