# 额外合约支持

额外合约可以在数据写入链之后继续运行，这有利于设置需要等待条件但是长期运行的合约。

```typescript
public abstract postProcess(territoriality: boolean, who: string): Promise<any>;
```

##### Getting Started

自定义类基于PostProcess：

```typescript
export default class [name] extends PostProcess { }
```

基于Promise返回函数的方程：

```typescript
export default class [name] extends PostProcess {
    ...
    public postProcess(territoriality: boolean, who: string): Promise<any> {
        return new Promise<any>((resolve, reject) => {
        	resolve(true);
    	}
    }
}
```
