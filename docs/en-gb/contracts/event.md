# Event Support

Expose an Event emitter to the developer to consume. This works in 2 parts: first the smart contract emits the event, and second an application running on the node's host listens for it.

Each node records the events raised by the transactions it commits in its events database, and its storage service streams them as server-sent events:

```
http://localhost:<storage port>/activeledgerevents/events
```

The storage port is one below the node's by default (5259 for 5260). This service must never be exposed beyond the node's host; relay what your application needs through your own backend. Each event is an SSE frame whose `id` is `<milliseconds>-<counter>,<umid>` and whose `data` is `{"name", "data", "phase", "contract"}`. A listener that reconnects with a `Last-Event-ID` header receives every event recorded after that id, then the live feed.

ActiveCore, which previously served events, was removed in 5.0.0.

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



