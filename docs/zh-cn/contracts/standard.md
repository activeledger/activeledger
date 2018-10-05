# 基础合约

基础合约具有3个内置方程以方便开发者使用。

#### 基础方程

```typescript
public abstract verify(selfsigned: boolean): Promise<boolean>;
```

这个方程用来验证智能合约是否匹配与其相关的信息交流，如果验证没有通过那么此智能合约在链上的行为会被拒绝，自签名的智能合约会被系统标记。

```typescript
public abstract vote(): Promise<boolean>;
```
投票是共识机制的一部分，投票通过表明对当前信息交换的认可，这也可以用来验证交易发起者是否可以发出当前交易；投票未通过不会干扰链的运行，未通过投票的原因也可能是系统管理者更改了部分数据。

```typescript
public abstract commit(possibleTerritoriality?: boolean): Promise<any>;
```

数据写入发生在共识机制完成后，此时得到共识的数据会逐步成为永久的记录写入当前链。

##### Getting Started

You need to extend  & define your class as :

```typescript
export default class [name] extends Standard {
	public verify(selfsigned: boolean): Promise<boolean> {
    	return new Promise<boolean>((resolve, reject) => {
        	resolve(true);
    	}
    }

    public vote(): Promise<boolean> { 	   
        return new Promise<boolean>((resolve, reject) => {
        	resolve(true);
    	}
    }

 	public commit(): Promise<any> {
 	    return new Promise<boolean>((resolve, reject) => {
        	resolve(true);
    	}
    }
}
```

这是智能合约的基础框架，我们提供的模板不会改变任何链上的数据和内容。

#### 智能合约实际案例

以下提供了可以从一个人账户转到另外一个人账户的智能合约案例，我们假定转出此笔交易的账户具有足够的资金，尽管我们会使用验证是否有足够资金的方程。

##### 创建验证方程

这个例子使用了已存在的身份信息所以自验证是不被允许的，数据交换的信息储存在如下地址：

```typescript
this.transactions...
```

作为智能合约开发者你拥有对数据记录的完全控制权，在需要的信息中我们定义了一些项比如$ prefix，但是开发者可以选择使用自定义的其他项。[详细内容](../transactions.md)

```typescript
 public verify(selfsigned: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!selfsigned && Object.values(this.transactions.$i)[0].transfer ) {     	
        resolve(true);
      } else {
        reject("Signatures Needed");
      }
    });
  }
```

我们已经提到了例子中的智能合约不支持自签名，并且合约已经包含了传输的金额。

##### 创建投票方程

现在需要确认相关金额可以进行交易。

```typescript
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // Get the input to verify
      let iStreams = Object.keys(this.transactions.$i);

      // Fetch first input
      this.iActivity = this.getActivityStreams(iStreams[0]);

      // Get Input State
      let state = this.iActivity.getState();

      // Input Balance Transaction Values
      this.txValue = this.transactions.$i[iStreams[0]];

      // Are they trying to transfer more than they have
      if(this.txValue.transfer > state.amount) {
		reject("Not enough funds");
      }else{
		resolve(true);
      }      
    });
  }
```

如果承诺通过则交易成功，否则显示金额不足。

##### 创建写入方程

写入方程控制相关金额被转入（转出）。

```typescript
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      	// Get the output stream from transaction
      	let oStreams = Object.keys(this.transactions.$o);

      	// Fetch first output
      	let oActivity = this.getActivityStreams(oStreams[0]);

      	// Input State
      	let iState = this.iActivity.getState();

        // Output State
        let oState = oActivityStream.getState();        

        // Increase output state balance by the transfer amount
      	oState.amount += this.txValue.transfer;        

      	// Decrease input state balance by the transfer amount
      	iState.amount -= this.txValue.transfer;

        // Update States
      	oActivity.setState(oState);
      	iActivity.setState(iState);       

        // Return
        resolve(true);
    });
  }
```

写入阶段会更新对象状态并通知Activeledger智能合约已经通过，作为智能合约开发者你只需要确保一切信息正确，其他的工作Activeledger会自动处理。

#### 活动和数据流

Activeledger重新定义了数据的处理和储存方式，活动代表了链上信息的变化而数据流是链上信息的具象化。一个信息写入的过程包含了活动和数据流，还包括其他过程和数据的更新。

智能合约是活动的主要发起者，它基于基本的框架并包含帮助方程，这为自定义的合约开发带来方便。

#### 内置帮助方程

帮助方程可以协助智能合约的开发。

````typescript
public newActivityStream(name: string): Activity;
````

创建新的数据流

````typescript
public getActivityStreams(): { [reference: string]: Activity };
public getActivityStreams(stream: any): Activity;
````

返回所有或者特定的与数据写入(\$i和\$0)相关的活动。

```typescript
public getMofSignatures(m: number): boolean;
```

Activeledger会自动处理签名验证相关的问题，你可以使用多重签名来验证一个智能合约。例如一共需要3个签名：

* 1个签名 - 交易失败
* 2个签名 - 开始交易
* 3个签名 - 开始交易并且更新金额

```typescript
public getReadOnlyStream(name: string): any;
```

\$r项允许用户在只读模式下访问数据流的信息，此时不需要签名和信息验证就可以访问这些信息。

```typescript
this.setTimeout(15000)
```

增加15秒智能合约的有效期

##### 节点之间信息交换(INC)

INC可以用来在节点之间传递信息。

```typescript
protected getInterNodeComms(): ActiveDefinitions.ICommunications
```

获取任何链上其他节点间的信息。

```typescript
protected setThisInterNodeComms(data: object): void
```

设置此节点将要传输的数据。

```typescript
public getThisInterNodeComms(secret: number): object
```

获取当前节点的数据记录的信息。

#### 活动帮助

智能合约以活动（数据流）的形式记录在链上， 以下是返回值的帮助方程。

```typescript
public hasSignature(): boolean
```

返回是否当前活动附加签名。

```typescript
public getAuthority(type: boolean = false): string
```

返回具有签名权限的身份id，包含签名的加密方式。

```typescript
public setAuthority(pubkey: string, type: string = "rsa"): void
```

设置当前活动的签名的权限，目前你需要提供PEM格式的公钥和此公钥的加密方程。如果是已经注册的活动，用户可以采用如下方式设置权限：

```typescript
newActivityStream().setAuthority(
    getActivityStreams([stream]).getAuthority(),
    getActivityStreams([stream]).getAuthority(true)
);
```

---

```typescript
public setContractLock(script: string | Array<string>): boolean
```

智能合约会创造一个新的数据流，你可以选择单个合约或者多个合约将数据流锁住。

```typescript
public getId(): string
public getName(): string
```

获取活动数据流id

```typescript
public getState(): ActiveDefinitions.IState
```

获取活动数据

```typescript
public setState(state: ActiveDefinitions.IState): void
```

设置活动的数据

```typescript
public getVolatile(): ActiveDefinitions.IVolatile
```

获取活动数据的未存储流量

```typescript
public setVolatile(volatile: ActiveDefinitions.IVolatile): void
```

设置活动数据的未存储流量

**未存储流量是未被写入链的数据，虽然它们保存在链中，但是一旦这些数据丢失就无法从其他节点恢复。**

```typescript
public getCng(buffer?: string): number
```

CNG是共识数字生成器的缩写，它不能作为随机数字生成器的替代品但是你可以把它当作一个随机数据生成器，如果你只是需要一个未知但是可以被预测的数字用来计算。这个方程会在所有节点返回针对特定合约的惟一的值，这就是为什么它会感觉像一个随机数字生成器，我们提供了一个缓冲选项以确保没有近似值会出现。

##### 权限控制层

我们提供了一些基础的方程来处理活动的权限控制，但是除了禁止某些用户写入数据对象，其他功能还没有整合在Activeledger中。合约开发者可以根据个人情况选择实现相关方程的功能。

```typescript
public setACL(name: string, stream: string)
```

为相关活动创建一个权限控制用户。

```typescript
public hasACL(name: string): boolean
```

判断当前活动是否拥有权限控制。

#### 多活动控制

用相同的智能合约来控制多个活动是被允许的，在数据记录中有一项叫做$entry可以用来定义多个活动。我们可以用switch来定义不同条件下运行的逻辑。

```typescript
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      switch (this.transactions.$entry) {
        case "add":
          // add funds logic
          break;
        default:
          // transfer funds logic
          break;
      }
    });
  }
```
