import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { P2PClient } from "../packages/network/src/network/p2pClient";

// The mutable CommonJS net module (not an import namespace) is patched, which
// is what the client under test reads from.
const net: any = require("net");

// P2PClient is exercised with an in-process fake socket swapped in for
// net.createConnection, so no port is opened and nothing waits on a real
// connection or reconnect timer.
class FakeSocket extends EventEmitter {
  writable = true;
  noDelay: boolean | undefined;
  destroyed = false;
  written: Buffer[] = [];
  setNoDelay(v: boolean) {
    this.noDelay = v;
  }
  write(b: Buffer) {
    this.written.push(b);
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
}

const frame = (payload: Buffer): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
};

describe("P2PClient", () => {
  const realCreate = net.createConnection;
  const realNow = Date.now;
  const realSetTimeout = global.setTimeout;
  let sockets: FakeSocket[];
  let dialled: [number, string][];
  let timers: { fn: () => void; ms: number; unref: boolean }[];

  beforeEach(() => {
    sockets = [];
    dialled = [];
    timers = [];
    (net as any).createConnection = (port: number, host: string) => {
      dialled.push([port, host]);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    (global as any).setTimeout = (fn: () => void, ms: number) => {
      const t = { fn, ms, unref: false };
      timers.push(t);
      return {
        unref: () => {
          t.unref = true;
        },
      } as any;
    };
  });

  afterEach(() => {
    (net as any).createConnection = realCreate;
    Date.now = realNow;
    (global as any).setTimeout = realSetTimeout;
  });

  it("is not ready until the socket connects", () => {
    const c = new P2PClient("peer", 5261);
    expect(c.ready).to.equal(false);
    c.connect();
    expect(dialled).to.deep.equal([[5261, "peer"]]);
    expect(sockets[0].noDelay).to.equal(true);
    expect(c.ready).to.equal(false);
    sockets[0].emit("connect");
    expect(c.ready).to.equal(true);
  });

  it("does not dial again while already connected", () => {
    const c = new P2PClient("peer", 5261);
    c.connect();
    sockets[0].emit("connect");
    c.connect();
    expect(sockets).to.have.length(1);
  });

  it("emits one message per complete frame, in order", () => {
    const c = new P2PClient("peer", 5261);
    const got: string[] = [];
    c.on("message", (b: Buffer) => got.push(b.toString()));
    c.connect();
    sockets[0].emit(
      "data",
      Buffer.concat([frame(Buffer.from("one")), frame(Buffer.from("two"))])
    );
    expect(got).to.deep.equal(["one", "two"]);
  });

  it("reassembles a frame split across data events", () => {
    const c = new P2PClient("peer", 5261);
    const got: string[] = [];
    c.on("message", (b: Buffer) => got.push(b.toString()));
    c.connect();
    const whole = frame(Buffer.from("hello world"));
    sockets[0].emit("data", whole.slice(0, 2));
    sockets[0].emit("data", whole.slice(2, 8));
    expect(got).to.deep.equal([]);
    sockets[0].emit("data", whole.slice(8));
    expect(got).to.deep.equal(["hello world"]);
  });

  it("keeps the start of the next frame that arrives with the end of one", () => {
    const c = new P2PClient("peer", 5261);
    const got: string[] = [];
    c.on("message", (b: Buffer) => got.push(b.toString()));
    c.connect();
    const a = frame(Buffer.from("aaaa"));
    const b = frame(Buffer.from("bbbb"));
    sockets[0].emit("data", Buffer.concat([a, b.slice(0, 3)]));
    expect(got).to.deep.equal(["aaaa"]);
    sockets[0].emit("data", b.slice(3));
    expect(got).to.deep.equal(["aaaa", "bbbb"]);
  });

  it("send() writes [sender ref padded to 40][length][payload]", () => {
    const c = new P2PClient("peer", 5261);
    c.connect();
    c.send(Buffer.from("payload"), "ref1");
    const out = sockets[0].written[0];
    expect(out.length).to.equal(40 + 4 + 7);
    expect(out.slice(0, 40).toString()).to.equal("ref1".padEnd(40, " "));
    expect(out.readUInt32BE(40)).to.equal(7);
    expect(out.slice(44).toString()).to.equal("payload");
  });

  it("send() writes nothing before connect() or on an unwritable socket", () => {
    const c = new P2PClient("peer", 5261);
    expect(() => c.send(Buffer.from("x"), "r")).to.not.throw();
    c.connect();
    sockets[0].writable = false;
    c.send(Buffer.from("x"), "r");
    expect(sockets[0].written).to.have.length(0);
  });

  it("schedules an unref'd 2s reconnect after a lost connection", () => {
    const c = new P2PClient("peer", 5261);
    c.connect();
    sockets[0].emit("connect");
    sockets[0].emit("close");
    expect(c.ready).to.equal(false);
    expect(timers).to.have.length(1);
    expect(timers[0].ms).to.equal(2000);
    expect(timers[0].unref).to.equal(true);
    timers[0].fn();
    expect(sockets).to.have.length(2);
  });

  it("keeps retrying a peer that was never reached inside the 10 minute window", () => {
    const c = new P2PClient("peer", 5261);
    c.connect();
    sockets[0].emit("close");
    expect(timers).to.have.length(1);
  });

  it("gives up on a peer never reached once the 10 minute window has passed", () => {
    const start = realNow();
    const c = new P2PClient("peer", 5261);
    c.connect();
    Date.now = () => start + 10 * 60 * 1000 + 1;
    sockets[0].emit("close");
    expect(timers).to.have.length(0);
    c.connect();
    expect(sockets).to.have.length(1);
  });

  it("keeps reconnecting a peer that connected once, even after the window", () => {
    const start = realNow();
    const c = new P2PClient("peer", 5261);
    c.connect();
    sockets[0].emit("connect");
    Date.now = () => start + 60 * 60 * 1000;
    sockets[0].emit("close");
    expect(timers).to.have.length(1);
    timers[0].fn();
    expect(sockets).to.have.length(2);
  });

  it("a socket error is logged and does not throw or disconnect", () => {
    const c = new P2PClient("peer", 5261);
    c.connect();
    sockets[0].emit("connect");
    expect(() => sockets[0].emit("error", new Error("reset"))).to.not.throw();
    expect(c.ready).to.equal(true);
  });

  it("stop() cancels a pending reconnect and destroys the socket", () => {
    const c = new P2PClient("peer", 5261);
    c.connect();
    sockets[0].emit("close");
    const cleared: any[] = [];
    const realClear = global.clearTimeout;
    (global as any).clearTimeout = (h: any) => cleared.push(h);
    try {
      c.stop();
    } finally {
      (global as any).clearTimeout = realClear;
    }
    expect(cleared).to.have.length(1);
    expect(sockets[0].destroyed).to.equal(true);
  });

  it("stop() before connect() is harmless", () => {
    expect(() => new P2PClient("peer", 5261).stop()).to.not.throw();
  });
});
