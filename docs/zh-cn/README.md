# Activeledger 第二版 说明文档
<!---
updated on Thursday, 3 May 2018
updated on Thursday, 7 June 2018
-->

Activeledger 提供了一种基于分布式账本技术的区块链解决方案，提供简单维护和升级的模块化使用方法。

* [配置](configuration.md) - Activeledger配置文件
* [合约](./contracts/README.md) - 如何使用及创建智能合约
* [核心](core.md) - API接口，更改数据，事件和提醒的设置
* [加密](crypto.md) - 加密功能的集成包，支持多种加密方式
* 定义 - 与合约开发有关的TypeScript定义文件
* [账本](ledger.md) - Activeledger主程序
* 记录 - 信息记录和反馈的集成包
* 网络 - P2P网络构建
* 协议 - 共识机制协议及智能合约虚拟机
* 查询 - 链数据查询包
* [重建](restore.md) - 网络重建节点恢复及新节点搭建


\* 完整实现Activeledger的功能需要3个独立的程序共同运行，虽然Activeledger可以独立运行，但是我们推荐用户同时运行3个程序以确保最好的效果和功能的完整性。这些程序分开是处于对开发过程中运行效果和花销的考虑。

## 安装Activeledger

##### Linux下系统安装指南(Debian / Ubuntu)

请确保你的系统拥有当前最新的版本。

```bash
sudo apt-get update
sudo apt-get upgrade
sudo apt-get install git build-essential
```

Activeledger需要在Node.js环境下运行，以下信息将指导当前用户配置Node环境。(无需 su 命令)

````bash
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.11/install.sh | bash
````

更详细信息请访问 http://www.nvm.sh ，之前的命令也包含了对nvm(Node版本控制)的下载， nvm可以用来安装最新的node版本。


````bash
nvm i 10
````

这个命令用来安装最新的10.X版本的node，在node安装完成之后用户就可以开始安装Activeledger的产品了。

```bash
npm i -g @activeledger/activeledger @activeledger/activerestore @activeledger/activecore
```

以上命令安装了Activeledger的核心组件，在安装完成后用户可以使用以下命令来启动Activeledger：

```bash
activeledger
```

这个命令会为当前节点生成一个新的id，同时会生成默认的配置文件和搭建当前节点的数据储存目录，配置文件可用来配置从其他相邻节点发来的数据。

##### 创建本地测试Activeledger网络

Activeledger允许在同一个host地址运行不同节点，Activeldger Cli可以被用来搭建及运行这些节点，创建一个3个节点组成的网络你需要运行以下命令：

```bash
activeledger --testnet
```

如果你希望运行多于默认数量（3个）的节点网络， 以创建10个节点组成的网络为例：

```bash
activeledger --testnet 10
```

在同一个host上面运行多个节点时，除了运行在端口5260的第一个节点（节点-0），其他节点的API和Restore引擎会默认被关闭。唯一可访问的API地址为 http://localhost:5261 ，API工具地址为 http://localhost:5261/explorer 。

##### 更改基于文件的配置为基于链的配置

当您初步设置好区块链网络后，您应该把基于文件的配置更改为基于链的配置。这样可以允许Activeledger[动态增加或者移除](dynamic-nodes.md)网络中的节点。

在所有节点都连接的情况下运行以下命令来更改设置

```bash
activeledger --assert
```

此命令会移除大多数基于文件的设置并同时替换为新的数据流。配置文件不会被删除并指向新的数据流，同时它会提供本地设置选项例如自动启动。

[更多信息关于动态增加或者移除节点](dynamic-nodes.md)

###### 在合约锁下声明网络

在Activeledger CLI运行声明网络命令来管理网络配置时，默认情况下只有默认合约或者初始化合约才能更改网络配置。用户可以允许已经注册在链上的合约拥有同样的权限，用户只需要在声明命令中传递在安装此合约时使用的数据流的id。

```bash
activeledger --assert [contract stream id]
```

##### Windows下NVM和NodeJS安装指南

我们推荐使用NVM来帮助安装Activeledger https://github.com/coreybutler/nvm-windows，并且安装最新的9.X版本的node。

````powershell
nvm list available
nvm install 10.XX.X
````

Windows还需要通过npm下载额外的构建工具。

```powershell
npm i -g --production windows-build-tools
```

一些文件的写入需要用户拥有对git的访问权限，对于没有安装git的用户请访问以下网址来安装git，在git安装好之后，请重复以上步骤。

- https://desktop.github.com
- https://gitforwindows.org
- https://git-scm.com/downloads


##### 设置Activeledger为启动系统自动运行

[PM2](http://pm2.keymetrics.io/)可以用来进行系统进程管理，这包括设置系统启动自动运行的程序，在继续其他步骤前请先下载PM2。

```bash
npm i -g pm2
```

然后让PM2管理Activeldger进程的运行。

````bash
pm2 start activeledger
````

然后我们可以设置PM2的自动运行选项。

````bash
pm2 startup
````

在此命令后屏幕上会出现一些其他选项，在确认好这些选项后我们需要保存我们的设置。

````bash
pm2 save
````

Activeledger现在会在系统启动时自动运行。

###### 重要安装信息

Activeledger自行配置好了数据储存引擎，在刚刚设置好的情况整个网络需要使用同样的数据源（内置或者外部数据库接口），我们会在之后的版本开放允许混合的数据接口。

## 在Activeledger中创建身份信息

通过Activeledger内置的智能合约，用户可以在Activeledger中很容易的创建一个新的身份信息，这个内置的合约可以自动把你生成的公钥和签名注册在网络中，用户只需要自定义如下信息并启动onboard合约：

```json
{
    "$tx": {
        "$namespace": "default",
        "$contract": "onboard",
        "$i": {
            "identity": {
            	"type":"[secp256k1 OR rsa]",
                "publicKey": "[Public PEM Format]"
            }
        }
    },
    "$selfsign": true,
    "$sigs": {
        "identity": "[signature of $tx object]"
    }
}
```

这个信息会以纯文本方式发送POST请求给Activeledger节点地址，例如：

```
http://127.0.0.1:5260
```

在Activeledger收到这条请求后， 用户会被赋予一个新的数据id。

```json
{
    "$umid": "e0b99c48b1547389a8a71b0543a9b95dfd9c4991989419959242a67ca5e4d356",
    "$summary": {
        "total": 30,
        "vote": 30,
        "commit": 30
    },
    "$streams": {
        "new": [
            {
                "id": "aedc2f06256a284c9f0be7ba914bf8c80d7fb765d489c2387be1b1d674776180",
                "name": "activeledger.default.identity.name"
            }
        ],
        "updated": []
    }
}
```

这个数据id可用来进行数据的写入\$i和输出\$o还有对链上信息的更改\$r。[更多内容](./transactions.md)
