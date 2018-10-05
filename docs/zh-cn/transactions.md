# Activeledger上面记录了什么样的信息?

信息记录是Activeledger运行智能合约的依据，信息记录本质上是由JSON格式的文件组成，这些信息通过HTTP协议发送到相对应的Activeledger节点，以下是信息记录的基本结构：


```json
{
    "$tx": {
        "$namespace": "[contract namespace location]",
        "$contract": "[contract id to run]{@version}",
        "$entry": "[contract entry point]",
        "$i": {},
        "$o": {},
        "$r": {},
        },
    },
    "$selfsign": false,
    "$sigs": {}
}
```

### $tx

tx部分包含了这条信息记录所有参与者的id\$i。

#### $namespace

开发者可以在每个Activeledger节点上设置命名空间，这可以让开发者拥有对相关智能合约的控制和所有权。

Activeledger包含一个默认的命名空间。

#### $contract

设置了处理信息记录的数据id

#### $entry

[标准合约](contracts/standard.md) 需要3个拥有权限的主要接入点\$entry来运行合约

```typescript
this.transactions.entry
```

#### $i

定义了哪些数据id会参与数据的记录，这需要交易的双方需要提供相关匹配的信息签名来证明身份和权限，比如在用户开始数据记录时他需要证明他具有相关的权限。

其中包含两条信息：

##### Key - Stream id 数据id

这是链上身份的证明，作为公钥证明

##### Key - Self signature 个人签名

个人签名是一条独特的信息储存在\$sigs中

##### Value

合约开发者可以自由定义这些值，并且可以通过以下方式访问：

```typescript
this.transactions.$i["[key]"].
```

然而在使用个人签名时，你需要定义如下性质：

```json
{
    "type":"[secp256k1 OR rsa]",
    "publicKey": "[Public PEM Format]"
}
```

这允许Activeledger来处理签名核实，它还允许合约开发者创建新的进程并且赋予相关权限。

#### $o

和$i类似但是不需要提供签名来验证权限，个人签名不会被采用。

#### $r

$r包含了一对“键-值”的对象，用来读取数据流的情况，其中键的值是定义的名，其中的值是数据id，在只读模式模式访问其中内容可以用：

```typescript
let state = this.getReadOnlyStream(this.transactions.$r["reference"])
```

状态包括了现在执行时间。

### $selfsign

这个方程用来表明是否为个人登录，表示目前不存在数据id但是节点想写入信息，在其他链接中[更多](README.md) 解释了开始节点的方法。这个方程在合同核实阶段是可用的。

### $sigs

包含了一对“键-值”的对象，“键”包含了所有\$i中的值，“值”是\$tx中的私钥。

## 提交加密记录

默认情况下网络内部信息的交流是自动加密的但是从外部提交到网络的记录并没有自动加密。用户可以自行设置SSL链接并将Activeledger架构在proxy层下面来达成加密过程，或者用户可以使用接收信息节点的公钥来加密输入的信息。

在这个阶段，Activeledger并不会自动检测写入记录是否加密，用户需要增加如下信息来告诉Activeledger信息是加密的：

```http
X-Activeledger-Encrypt:yes
```

如果用户使用正确的公钥来加密信息，这个过程不会报错，但是如果输入节点出于任何原因没有成功解密信息，Activeledger会返回错误信息500和"Decryption Error"。

## 强制密钥使用案例

当用户使用了强制密钥选项时，Activeledger会默认需要额外的(**\$nhpk**)信息包含在每次的数据传输中。这个信息需要包含在数据记录(**\$i**)对象中，数据记录的大概格式为：

```json
    "$tx": {
        "$namespace": "[contract namespace location]",
        "$contract": "[contract id to run]{@version}",
        "$entry": "[contract entry point]",
        "$i": {
            "[stream id]":{
                "$nhpk": "[PEM Public Key]"
            }
        },
        "$o": {},
        "$r": {},
        },
    },
    "$selfsign": false,
    "$sigs": {}
}
```
