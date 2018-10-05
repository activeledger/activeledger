# 加载智能合约

在开始加载智能合约到链上前，请确保你已经设置了命名空间和链上的身份信息。

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
