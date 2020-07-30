# Query Support ⚠️Deprecated⚠️

Query allows you to run almost SQL style lookups against the data sitting on the ledger. These query only support the SELECT lookup. 

```typescript
this.query
        .sql(`SELECT * FROM X WHERE [property] = ${stringVar}`)
        .then(doc => {
          if (doc.length > 0) {
            return reject("No States Found");
          }
          return resolve(true);
        })
        .catch(() => {
          reject("Query Error");
        });
```

##### Getting Started

You need to extend your class as :

```typescript
export default class [name] extends Query { }
```

Then to query the ledger you can run the above code anywhere inside the contract 

```typescript
export default class [name] extends Query { 
	...
    private myFunc(): void {
        this.query.sql("statement").then().catch();
    }
}
```

