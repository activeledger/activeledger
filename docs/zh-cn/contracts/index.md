# 智能合约

Activeledger的智能合约应用了Typescript语言，合约在特定的虚拟机中被运行以保证他们具有相关的权限。合约需要在Activeledger上注册并赋予独特的命名，独特的命名可以确保相同的合约不会同时运行并且可以记录创造合约的用户，合约一旦加载就成为链的一部分并且参与共识机制和签名核实的过程。

* [如何注册命名空间](deployment/namespace.md)
* [加载新的智能合约](deployment/deploy.md)
* [更新智能合约版本](deployment/upgrade.md)
* [如何运行智能合约](deployment/run.md)

### 合约工作机制

合约是独立的TypeScript类文件，在写入信息记录的同时加载在链上。在加载之后以加密Typescript文件格式储存在链上。

Activeledger提供多继承的类来帮助你开发智能合约，你可以把他们单独使用或组合为复杂合约：

* [基础合约](./standard.md) - 提供基础方程
* [额外合约](./postprocess.md) - 提供在合约外的数据传输
* [搜索合约](./query.md) - 提供搜索类的合约 ⚠️Deprecated⚠️
* [事件合约](./event.md) - 提供基于事件的合约

智能合约基于承诺实现机制，允许用户长期运行未完成承诺的合约而不会影响其他链上进程的速度，这是基于Activeledger独有的数据管理方式和砂盒模式。

## 开始使用智能合约

开发团队在开发一键式安装和布置Activeledger的程序，在此之前，用户需要自行搭建运行环境。

任何IDE都可以进行环境搭建，但是我们建议使用支持TypeScipt语言的IDE，请导入相关包来更好的使用我们的产品。

智能合约支持包：

```typescript
import { Standard, Activity } from "@activeledger/activecontracts";
```

日志记录包：

```typescript
import { ActiveLogger } from "@activeledger/activelogger";
```

这些包也会发布在npm官网上或者你可以选择自己构建这个包。

更多内容请阅读基础合约部分[基础合约](./standard.md)并了解如何加载智能合约[加载新的智能合约](deployment/deploy.md)。

## 合约有效时间

一个智能合约达成一次成功的记录有3个阶段（核实，投票，共识）和完成记录返回的一个额外阶段（写入），在这4个阶段中Activeledger都采用了promise机制。为了防止整个过程中某个阶段没有返回成功或者失败的promise，Activeledger提供了合约失效时间的选项。合约有效时间并不是默认选项，但是我们提供了两个相关选项来管理节点。

合约有效时间 - 虚拟机维持合约运行时间（默认为10秒）

合约最大有效时间 - 允许合约有效期延长的最大期限（默认为20分钟）

作为合约开发者，您需要自行决定是否设置合约有效时间的选项，以下为设置合约有效时间的代码：

```typescript
// Don't Timeout for another 15 seconds.
this.setTimeout(15000)
```

开发者可以重复使用以上代码来延长合约的有效期，但是这个时间段不能超出合约的最大有效时间。
