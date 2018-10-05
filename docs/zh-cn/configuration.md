# 配置文件

Activeledger拥有一个被三个不同应用组建共享的配置文件 ([activeledger](ledger.md), [activecore](core.md) & [activerestore](restore.md))，这允许每个Activeledger节点拥有个性化设置并且自行决定参与者是否可以加入网络。

```json
{  
  "debug": true,
  "security": {
    "signedConsensus": true,
    "encryptedConsensus": true,
    "hardenedKeys": false
  },
  "host": "external-ip:5260",
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

## debug

Debug模式允许控制台输出更详细的信息，当debug模式没有开启时合约的相关错误信息不会被显示，只会返回简单的错误信息。

## security 安全性

网络拥有多种安全选项供,这些选项允许有选择的设置，这在提供更安全的信息的情况下改善了信息处理的方式。

### signedConsensus 签名下的共识机制

签名下的共识机制允许接收数据的节点可以验证数据的来源方的可靠性。

### encryptedConsensus 加密下的共识机制

允许加密下的共识机制比签名下共识机制更安全，开启时节点之间的数据传输会被完全加密

### hardenedKeys 单次密钥

这个选项提供了最好的信息加密模式，它强制当前节点所有的 \$i 中都会包含个新的 \$nhpk 项（New Hardened Public Key）。节点每次都会生成与目前身份信息对应的PEM格式的新公钥，这让每笔信息交流都存在惟一的公钥签名。

## host 地址

外界ip地址和端口

## db 数据库

目前Activeledger支持两种数据处理引擎，一种是由Activeledger提供的原生内置引擎，另一种是外接数据引擎CouchDB（2.1.1及以上版本）。在未来的版本我们会开放多数据处理引擎的功能，但是目前整个网络的节点只支持使用同一种数据处理引擎。

### url 链接

指向CouchDB的url链接和端口信息，可以包含用户登录信息。

### database 数据库

Activeledger的主要信息都储存在这里，这里储存着合约导致的信息流的变化和状态。

### error 错误

所有的信息传输错误都被记录在链上面，这有助于帮助链找到未被识别的错误数据。

### event 事件

这里储存由合约而触发的事件。

## consensus 共识机制

支持自定义设置达成共识机制所需要的节点比例。

## autostart 自动启动

允许Activeledger自动启动额外功能。

## rate 通讯频率

Activecore通讯频率设置。

## CORS

要设置CORS以允许发布直接网络交易到网络节点，请访问[CORS Middleware](https://github.com/Tabcorp/restify-cors-middleware/blob/master/README.md#allowed-origins)。 它接受一个被允许的网络地址的数组值。

## neighbourhood 参与节点

由加入许可网络的节点身份信息组成的数组，当前节点信息必须储存在这个数组中。

### identity 身份信息

每个独立的节点都需要它的身份信息来加入整个网络，Activeledger会在初次运行的时候为你自动生成身份信息。这个身份信息会以“文件名.身份信息”的格式储存在当前工作文件夹目录中。

### host 独立节点的地址

独立节点的外部链接。

### port 端口

独立节点的外部端口。

## Optional Configuration 可选配置

### contractCheckTimeout 智能合约失效时间

设置智能合约在虚拟机上的失效时间，默认时间是10000毫秒。

### contractMaxTimeout 智能合约最长失效时间

设置智能合约在虚拟机上的最大失效时间，默认值是20分钟，此智能合约的工作时间只能延长到设置值。
