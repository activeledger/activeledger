# Dynamic Node Management 动态节点管理

您需要先配置好你的网络来开启动态节点管理功能，详情见：[更改基于文件的配置为基于链的配置](README.md#更改基于文件的配置为基于链的配置)。在增加或者移除节点时，用户会发起一个多节点签名的数据信息。签名由各个节点自动生成，用户不需要获取所有节点的签名来完成此项操作，部分节点的签名即可完成。

节点身份信息和常规数据传输所需要的身份信息不同， 这项操作归属于自签名的数据信息。智能合约会在此情况下验证储存在(./.identity)目录下的节点身份。

下面的例子提供了关于**network configuration stream**的信息，详细信息请见配置文件**network**部分。

### Adding Node 增加节点

在增加节点时，在获得足够签名之前系统不会执行此功能，如果签名信息不足，智能合约会返回错误信息。

在提交新节点命令前，用户需要提供自签名对象的信息，新节点的身份信息及节点host位置。

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "setup",
        "$entry": "add",
        "$i": {
            "suggester": {
                "type": "[rsa | secp256k1]",
                "publicKey": "[PEM Public Key]",
                "identity": {
                    "type": "rsa",
                    "public": "[new-node-pem]"
                },
                "host": "[new-node-ip]",
                "port": 5260
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

### Node Removal 移除节点

在移除节点时，在获得足够签名之前系统不会执行此功能，如果签名信息不足，智能合约会返回错误信息。

在移除指定节点前，用户需要提供自签名对象的信息以及被移除节点的信息。

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "setup",
        "$entry": "remove",
        "$i": {
            "suggester": {
                "type": "[rsa | secp256k1]",
                "publicKey": "[PEM Public Key]",
                "identity": {
                    "type": "rsa",
                    "public": "[node-3-pem]"
                },
                "host": "[node-3-ip]",
                "port": 5260
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
        "[node-2-ip]:5260": "[signature]",
        "[node-4-ip]:5260": "[signature]"
    }
}
```

类似的设置允许智能合约在特定命名空间上使用其他的原生NodeJS组件[在命名空间使用NodeJS组件](contracts/deployment/namespace.md)。
