# 合约命名空间管理

命名空间可以分配智能合约在链上储存的位置，他们使用同样的登入密钥来认证合约发起者的身份并验证合约内容是否被篡改。

设置命名空间的开发者可以发起请求来获得更多资源来运行他的智能合约，这样他可以运行智能合约并同时使用其他额外组件。命名空间定义了智能合约的独立性所以其他链上的开发者不会干扰此合约的运行。

## 设置命名空间

设置命名空间允许你在链上划分出属于你的智能合约的空间，同时也是你具有加载智能合约权限的证明。

开始设置命名空间，请在进行数据交换时运行Activeledger内置的智能合约。

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
## 添加原生组件

如果开发者希望同时运行智能合约和其他标准NodeJS组件，他需要先在命名空间中定义此组件信息。在定义此信息之前，开发者需要获取网络中足够的签名来达成共识。例如你想当前命名空间拥有http的组件，以下是定义文件的例子：

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

你需要在$sigs对象中拥有足够的host节点签名来达成共识并完成定义，这项操作类似于[动态增加和移除节点](dynamic-nodes.md)。

**std** 对象中允许string以及string组成的数列，所以开发者可同时使用多种组件。

## 移除原生组件

在特定命名空间上开发者可以选择移除所有注册的组件，和添加组件类似，开发者需要获取足够数量的签名来达成共识，以下为移除原生组件的例子：

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
