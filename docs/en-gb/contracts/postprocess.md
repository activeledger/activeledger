# Post Process Support

Post process is designed for when you want to run additional logic after the transaction to the ledger has been confirmed. This is useful for when you want to run a long running task which doesn't need to have its output state stored on the ledger. 

```typescript
public abstract postProcess(territoriality: boolean, who: string): Promise<any>;
```

##### Getting Started

You need to extend your class as :

```typescript
export default class [name] extends PostProcess { }
```

Then to have your code run after the commit phase inside this class you need to declare the function postProcess :

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



