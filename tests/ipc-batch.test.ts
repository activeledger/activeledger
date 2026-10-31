import * as assert from "assert";
import {
  IpcBatcher,
  IpcChannel,
  ipcSend,
  unbatch,
} from "../packages/network/src/network/ipcbatch";

class FakeChannel implements IpcChannel {
  public sent: any[] = [];
  public connected = true;
  public fail = false;
  send(message: any, callback?: (error: Error | null) => void): boolean {
    if (this.fail) throw new Error("ERR_IPC_CHANNEL_CLOSED");
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("IpcBatcher", () => {
  it("sends a lone message unchanged", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    const m = { type: "tx", entry: { $umid: "a" } };
    b.send(m);
    assert.strictEqual(ch.sent.length, 0, "nothing sent synchronously");
    await tick();
    assert.strictEqual(ch.sent.length, 1);
    const got: any[] = [];
    unbatch(ch.sent[0], (x) => got.push(x));
    assert.deepStrictEqual(got, [m]);
  });

  it("coalesces one tick into one send, in order", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    for (let i = 0; i < 5; i++) b.send({ type: "broadcast", i });
    await tick();
    assert.strictEqual(ch.sent.length, 1);
    const got: number[] = [];
    unbatch(ch.sent[0], (m) => got.push(m.i));
    assert.deepStrictEqual(got, [0, 1, 2, 3, 4]);
  });

  it("separate ticks are separate sends and order holds across them", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    b.send({ i: 0 });
    b.send({ i: 1 });
    await tick();
    b.send({ i: 2 });
    await tick();
    const got: number[] = [];
    ch.sent.forEach((s) => unbatch(s, (m) => got.push(m.i)));
    assert.deepStrictEqual(got, [0, 1, 2]);
    assert.strictEqual(ch.sent.length, 2);
  });

  it("flushes early at the size threshold without losing or repeating", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch, 3);
    for (let i = 0; i < 7; i++) b.send({ i });
    // two full batches already out, one message still queued
    assert.strictEqual(ch.sent.length, 2);
    assert.strictEqual(b.pending, 1);
    await tick();
    const got: number[] = [];
    ch.sent.forEach((s) => unbatch(s, (m) => got.push(m.i)));
    assert.deepStrictEqual(got, [0, 1, 2, 3, 4, 5, 6]);
    // the timer left over from the first queued message must not resend
    await tick();
    assert.strictEqual(ch.sent.length, 3);
  });

  it("runs every callback once after the send", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    const calls: Array<[number, Error | null]> = [];
    b.send({ i: 0 }, (e) => calls.push([0, e]));
    b.send({ i: 1 }, (e) => calls.push([1, e]));
    await tick();
    assert.deepStrictEqual(calls, [
      [0, null],
      [1, null],
    ]);
  });

  it("rejects queued messages when the channel throws", async () => {
    const ch = new FakeChannel();
    ch.fail = true;
    const b = new IpcBatcher(ch);
    const errs: Array<Error | null> = [];
    b.send({ i: 0 }, (e) => errs.push(e));
    b.send({ i: 1 }, (e) => errs.push(e));
    await tick();
    assert.strictEqual(errs.length, 2);
    assert.ok(errs.every((e) => e instanceof Error));
    assert.strictEqual(b.pending, 0);
  });

  it("rejects queued messages when the worker has exited", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    const errs: Array<Error | null> = [];
    b.send({ i: 0 }, (e) => errs.push(e));
    ch.connected = false;
    b.close();
    assert.strictEqual(ch.sent.length, 0);
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0] instanceof Error);
    // later sends are refused immediately, never queued
    b.send({ i: 1 }, (e) => errs.push(e));
    assert.strictEqual(errs.length, 2);
    await tick();
    assert.strictEqual(ch.sent.length, 0);
  });

  it("close flushes the queue while still connected", () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    b.send({ i: 0 });
    b.send({ i: 1 });
    b.close();
    assert.strictEqual(ch.sent.length, 1);
    const got: number[] = [];
    unbatch(ch.sent[0], (m) => got.push(m.i));
    assert.deepStrictEqual(got, [0, 1]);
  });
});

describe("unbatch / ipcSend", () => {
  it("passes a plain message straight to the handler", () => {
    const seen: any[] = [];
    const m = { type: "tx" };
    unbatch(m, (x) => seen.push(x));
    assert.deepStrictEqual(seen, [m]);
  });

  it("unwraps a batch string in order", () => {
    const seen: number[] = [];
    unbatch(JSON.stringify([{ i: 1 }, { i: 2 }, { i: 3 }]), (m) =>
      seen.push(m.i)
    );
    assert.deepStrictEqual(seen, [1, 2, 3]);
  });

  it("serialises when queued, so later mutation does not leak into the send", async () => {
    const ch = new FakeChannel();
    const b = new IpcBatcher(ch);
    const entry: any = { $nodes: { a: { vote: true } } };
    b.send({ type: "tx", entry });
    entry.$nodes = {};
    entry.extra = 1;
    await tick();
    const got: any[] = [];
    unbatch(ch.sent[0], (m) => got.push(m));
    assert.deepStrictEqual(got[0].entry, { $nodes: { a: { vote: true } } });
  });

  it("a throwing handler does not stop later messages", async () => {
    const seen: number[] = [];
    const rethrown: Error[] = [];
    const onErr = (e: Error) => rethrown.push(e);
    // mocha owns uncaughtException: swap its listeners out for this test
    const saved = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", onErr);
    unbatch(JSON.stringify([{ i: 1 }, { i: 2 }]), (m) => {
      seen.push(m.i);
      if (m.i === 1) throw new Error("boom");
    });
    await tick();
    process.removeListener("uncaughtException", onErr);
    saved.forEach((l) => process.on("uncaughtException", l));
    assert.deepStrictEqual(seen, [1, 2]);
    assert.strictEqual(rethrown.length, 1);
  });

  it("ipcSend uses the batcher when present, else sends directly", async () => {
    const plain = new FakeChannel();
    ipcSend(plain, { i: 1 });
    assert.strictEqual(plain.sent.length, 1);

    const ch: any = new FakeChannel();
    ch.batcher = new IpcBatcher(ch);
    ipcSend(ch, { i: 1 });
    ipcSend(ch, { i: 2 });
    assert.strictEqual(ch.sent.length, 0);
    await tick();
    assert.strictEqual(ch.sent.length, 1);
  });
});
