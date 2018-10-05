# 事件支持

提供开发者可使用的事件触发和管理机制，由智能合约事件触发器和事件监控器两个部分组成。

#### 触发事件

```typescript
this.event.emit("name", {});
```

##### 开始使用事件系统

自定义类基于Event：

```typescript
export default class [name] extends Event { }
```

通过方程触发事件系统：

```typescript
export default class [name] extends Event {
    ...
    private myFunc(): void {
        this.event.emit("myFunc", {data: "Hello World"});
    }
}
```
