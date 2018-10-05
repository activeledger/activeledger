# 运行智能合约

记录数据交换需要运行智能合约，作为智能合约开发者你可以自定义合约的一切内容包括数据的写入和写出（\$i和\$o）。

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
