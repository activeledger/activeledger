# Event Support

Expose an Event emitter to the developer to consume. This works in 2 parts first the smart contract emits the event and the second part is to have a locally running application listen to activecore for that specific smart contracts events or specific event.

#### Emit Event

```typescript
this.event.emit("name", {});
```

##### Getting Started

You need to extend your class as :

```typescript
export default class [name] extends Event { }
```

Then to emit an event anywhere within a function of the class you can call the event emitter :

```typescript
export default class [name] extends Event {
    ...
    private myFunc(): void {
        this.event.emit("myFunc", {data: "Hello World"});
    }
}
```



