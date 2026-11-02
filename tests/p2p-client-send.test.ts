import { expect } from "chai";
import "mocha";
import * as net from "net";
import { P2PClient } from "../packages/network/src/network/p2pClient";

/**
 * P2PClient.send() builds each frame in one allocation and coalesces the
 * writes of one event loop turn into a single flush (cork / setImmediate
 * uncork). Frames must still arrive whole, in call order, in the unchanged
 * format [senderRef padded to 40][uint32 BE length][payload].
 */
describe("P2PClient send", () => {
  let server: net.Server;
  let port: number;
  let accepted: net.Socket[];
  let received: Buffer;
  let client: P2PClient | undefined;

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const until = async (check: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  // The format the client has always written
  const frameOf = (data: Buffer, ref: string): Buffer => {
    const refBuf = Buffer.alloc(40);
    refBuf.write(ref.padEnd(40, " "), 0, "utf8");
    const frame = Buffer.alloc(4 + data.length);
    frame.writeUInt32BE(data.length, 0);
    data.copy(frame, 4);
    return Buffer.concat([refBuf, frame]);
  };

  const parse = (buf: Buffer) => {
    const frames: { ref: string; payload: Buffer }[] = [];
    let at = 0;
    while (at + 44 <= buf.length) {
      const len = buf.readUInt32BE(at + 40);
      frames.push({
        ref: buf.subarray(at, at + 40).toString(),
        payload: buf.subarray(at + 44, at + 44 + len),
      });
      at += 44 + len;
    }
    return { frames, rest: buf.length - at };
  };

  const connected = async (): Promise<P2PClient> => {
    const c = new P2PClient("127.0.0.1", port);
    c.connect();
    await until(() => c.ready && accepted.length > 0);
    return c;
  };

  beforeEach((done) => {
    accepted = [];
    received = Buffer.alloc(0);
    server = net.createServer((socket) => {
      accepted.push(socket);
      socket.on("data", (d) => (received = Buffer.concat([received, d])));
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as net.AddressInfo).port;
      done();
    });
  });

  afterEach((done) => {
    client?.stop();
    client = undefined;
    accepted.forEach((s) => s.destroy());
    server.close(() => done());
  });

  it("writes the frame in the unchanged format", async () => {
    client = await connected();
    const payload = Buffer.from("hello frame");
    client.send(payload, "abc");
    await until(() => received.length >= 44 + payload.length);
    expect(received.equals(frameOf(payload, "abc"))).to.equal(true);
  });

  it("never writes into the payload it is given, so one buffer can be sent to many peers", async () => {
    client = await connected();
    const payload = Buffer.from("shared payload bytes");
    const copy = Buffer.from(payload);
    client.send(payload, "peer-a");
    client.send(payload, "peer-b");
    await until(() => received.length >= 2 * (44 + payload.length));
    expect(payload.equals(copy)).to.equal(true);
    const { frames } = parse(received);
    expect(frames.map((f) => f.payload.toString())).to.deep.equal([
      "shared payload bytes",
      "shared payload bytes",
    ]);
  });

  it("cuts a sender reference longer than 40 bytes, as before", async () => {
    client = await connected();
    const ref = "r".repeat(60);
    const payload = Buffer.from([1, 2, 3]);
    client.send(payload, ref);
    await until(() => received.length >= 47);
    expect(received.equals(frameOf(payload, ref))).to.equal(true);
    expect(received.subarray(0, 40).toString()).to.equal("r".repeat(40));
  });

  it("delivers every frame sent in one tick, whole and in order", async () => {
    client = await connected();
    const payloads: Buffer[] = [];
    for (let i = 0; i < 50; i++) {
      payloads.push(Buffer.alloc(1 + ((i * 37) % 300), i));
    }
    payloads.forEach((p, i) => client!.send(p, `ref-${i}`));

    const expected = Buffer.concat(payloads.map((p, i) => frameOf(p, `ref-${i}`)));
    await until(() => received.length >= expected.length);
    expect(received.equals(expected)).to.equal(true);
    const { frames, rest } = parse(received);
    expect(rest).to.equal(0);
    expect(frames.map((f) => f.ref.trim())).to.deep.equal(
      payloads.map((_, i) => `ref-${i}`)
    );
  });

  it("keeps order across ticks, and across a coalesced flush followed by direct sends", async () => {
    client = await connected();
    const sent: Buffer[] = [];
    const go = (n: number) => {
      const p = Buffer.from(`msg-${n}`);
      sent.push(p);
      client!.send(p, "o");
    };
    go(0);
    go(1);
    await tick();
    go(2);
    await tick();
    await tick();
    go(3);
    go(4);
    go(5);
    const expected = Buffer.concat(sent.map((p) => frameOf(p, "o")));
    await until(() => received.length >= expected.length);
    expect(received.equals(expected)).to.equal(true);
  });

  it("holds the writes of one tick together and flushes them the next turn", async () => {
    client = await connected();
    const socket: any = (client as any).socket;
    const writevs: number[] = [];
    const realWritev = socket._writev;
    socket._writev = function (chunks: any[], cb: any) {
      writevs.push(chunks.length);
      return realWritev.call(this, chunks, cb);
    };
    client.send(Buffer.from("a"), "c");
    client.send(Buffer.from("b"), "c");
    client.send(Buffer.from("c"), "c");
    expect(socket.writableCorked).to.be.greaterThan(0);
    await until(() => received.length >= 3 * 45);
    expect(socket.writableCorked).to.equal(0);
    // One flush for the three frames, not one per frame
    expect(writevs).to.deep.equal([3]);
  });

  it("corks again for the next turn after a flush", async () => {
    client = await connected();
    const socket: any = (client as any).socket;
    client.send(Buffer.from("one"), "c");
    await tick();
    await tick();
    expect(socket.writableCorked).to.equal(0);
    client.send(Buffer.from("two"), "c");
    expect(socket.writableCorked).to.be.greaterThan(0);
    await until(() => received.length >= 2 * 47);
    const { frames } = parse(received);
    expect(frames.map((f) => f.payload.toString())).to.deep.equal(["one", "two"]);
  });

  it("does not throw when the socket is closed, before or after sending", async () => {
    client = await connected();
    client.stop();
    await tick();
    expect(() => client!.send(Buffer.from("late"), "c")).to.not.throw();
    await tick();
    await tick();
  });

  it("does not throw when the socket dies between the cork and the uncork", async () => {
    client = await connected();
    const socket: any = (client as any).socket;
    client.send(Buffer.from("doomed"), "c");
    client.send(Buffer.from("doomed too"), "c");
    socket.destroy();
    expect(() => client!.send(Buffer.from("after destroy"), "c")).to.not.throw();
    // Let the uncork run; an exception here would be uncaught and fail the run
    await tick();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("does not throw before it has ever connected", () => {
    const idle = new P2PClient("127.0.0.1", 1);
    expect(() => idle.send(Buffer.from("x"), "c")).to.not.throw();
  });
});
