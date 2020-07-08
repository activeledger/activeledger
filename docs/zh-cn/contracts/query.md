# 搜索合约 ⚠️Deprecated⚠️

搜索合约允许你运行类似SQL的搜索语句，目前仅仅支持“SELECT”。

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

自定义类基于Query类：

```typescript
export default class [name] extends Query { }
```

基于SQL的搜索： 

```typescript
export default class [name] extends Query {
	...
    private myFunc(): void {
        this.query.sql("statement").then().catch();
    }
}
```
