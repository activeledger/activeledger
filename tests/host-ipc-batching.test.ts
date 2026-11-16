import { expect } from "chai";
import "mocha";
import { ActiveOptions } from "@activeledger/activeoptions";
import { Host } from "../packages/network/src/network/host";

/**
 * Runs of peer broadcasts for one worker go as one IPC message, with the order
 * the worker sees unchanged.
 */
describe("Host IPC batching (Activenetwork)", () => {
  const H: any = Host.prototype;
  const tick = () => new Promise((r) => setImmediate(r));
  let sent: any[];
  const child = (over: any = {}): any => {
    const c: any = { send: (...a: any[]) => (sent.push(a.length === 1 ? a[0] : a), true), ...over };
    H.batchBroadcasts.call({}, c);
    return c;
  };
  const bc = (n: number) => ({ type: "broadcast", data: { umid: "u", nodes: { n } } });

  let had = false;
  let old: any;
  beforeEach(() => {
    sent = [];
    const held: any = ActiveOptions.fetch(false);
    had = "ipcBatching" in held;
    old = held.ipcBatching;
    delete held.ipcBatching;
  });
  afterEach(() => {
    const held: any = ActiveOptions.fetch(false);
    if (had) held.ipcBatching = old;
    else delete held.ipcBatching;
  });

  it("sends a single broadcast as itself, at the end of the turn", async () => {
    const c = child();
    expect(c.send(bc(1))).to.equal(true);
    expect(sent).to.deep.equal([]);
    await tick();
    expect(sent).to.deep.equal([bc(1)]);
  });

  it("sends broadcasts of one turn as one batch, in order", async () => {
    const c = child();
    c.send(bc(1));
    c.send(bc(2));
    c.send(bc(3));
    await tick();
    expect(sent).to.deep.equal([{ type: "batch", data: { messages: [bc(1), bc(2), bc(3)] } }]);
  });

  it("sends what is waiting before any other message, so the worker sees the order it was sent", async () => {
    const c = child();
    c.send(bc(1));
    c.send(bc(2));
    c.send({ type: "destory", data: { umid: "u" } });
    c.send(bc(3));
    await tick();
    expect(sent).to.deep.equal([
      { type: "batch", data: { messages: [bc(1), bc(2)] } },
      { type: "destory", data: { umid: "u" } },
      bc(3),
    ]);
  });

  it("passes every other message through at once, with its extra arguments", () => {
    const c = child();
    c.send({ type: "tx" }, "handle");
    expect(sent).to.deep.equal([[{ type: "tx" }, "handle"]]);
  });

  it("does nothing to a child when turned off", () => {
    ActiveOptions.set("ipcBatching", false);
    const own = (...a: any[]) => (sent.push(a[0]), true);
    const c: any = { send: own };
    H.batchBroadcasts.call({}, c);
    expect(c.send).to.equal(own);
  });

  it("does not throw out of the turn when the worker has gone", async () => {
    const c = child({ send: () => { throw new Error("channel closed"); } });
    c.send(bc(1));
    await tick();
    expect(sent).to.deep.equal([]);
  });
});

describe("Host IPC serialization (Activenetwork)", () => {
  const H: any = Host;
  const held = () => ActiveOptions.fetch(false) as any;
  let had = false;
  let old: any;
  beforeEach(() => {
    had = "ipcSerialization" in held();
    old = held().ipcSerialization;
    delete held().ipcSerialization;
  });
  afterEach(() => {
    if (had) held().ipcSerialization = old;
    else delete held().ipcSerialization;
  });

  it("is JSON unless asked for advanced, and anything else is JSON", () => {
    expect(H.ipcSerialization()).to.equal("json");
    ActiveOptions.set("ipcSerialization", "advanced");
    expect(H.ipcSerialization()).to.equal("advanced");
    for (const other of ["json", "ADVANCED", "binary", true, 1]) {
      ActiveOptions.set("ipcSerialization", other);
      expect(H.ipcSerialization(), String(other)).to.equal("json");
    }
  });
});
