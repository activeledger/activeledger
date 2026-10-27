import { expect } from "chai";
import "mocha";
import { ActiveCrypto } from "../packages/crypto/src";
import {
  P2PServer,
  P2PServerOptions,
  addressGroup,
  P2PClient,
  P2PConnection,
  P2PIdentity,
} from "../packages/activep2p/src";

const identity = (): P2PIdentity => {
  const keys = new ActiveCrypto.KeyPair("secp256k1").generate();
  return { type: "secp256k1", publicKey: keys.pub.pkcs8pem, privateKey: keys.prv.pkcs8pem };
};

const REFUSED = /closed during handshake|ECONNRESET|EPIPE/;

const once = <T = any>(emitter: any, event: string): Promise<T[]> =>
  new Promise((resolve) => emitter.once(event, (...args: T[]) => resolve(args)));

describe("Peer to peer transport (Activep2p)", function () {
  this.timeout(10000);

  const serverId = identity();
  const clientId = identity();
  let server: P2PServer;

  const start = async (options: Partial<P2PServerOptions> = {}) => {
    server = await P2PServer.listen({
      port: 0,
      host: "127.0.0.1",
      identity: serverId,
      isKnownPeer: (key) => key === clientId.publicKey,
      ...options,
    });
    server.handle("echo", (payload) => payload);
    return server;
  };

  const connect = (options: Partial<Parameters<typeof P2PClient.connect>[0]> = {}) =>
    P2PClient.connect({
      host: "127.0.0.1",
      port: server.port,
      identity: clientId,
      expectedPeerKey: serverId.publicKey,
      ...options,
    });

  // Accept a client and return both ends.
  const pair = async (): Promise<[P2PConnection, P2PConnection]> => {
    const accepted = once<P2PConnection>(server, "connection");
    const client = await connect();
    const [remote] = await accepted;
    return [client, remote];
  };

  // Rewrite the next frame the connection writes.
  const tamperNextWrite = (connection: P2PConnection, change: (frame: Buffer) => Buffer) => {
    const socket = (connection as any).socket;
    const write = socket.write;
    socket.write = (data: Buffer, ...rest: any[]) => {
      socket.write = write;
      return write.call(socket, change(Buffer.from(data)), ...rest);
    };
  };

  afterEach(async () => {
    if (server) await server.close();
  });

  it("should handshake, expose verified keys and echo a request", async () => {
    await start();
    const [client, remote] = await pair();
    expect(client.peerKey).to.equal(serverId.publicKey);
    expect(client.peerKeyType).to.equal("secp256k1");
    expect(remote.peerKey).to.equal(clientId.publicKey);

    const payload = { umid: "abc", n: 42, list: [1, 2, 3], nested: { ok: true } };
    expect(await client.request("echo", payload, 2000)).to.deep.equal(payload);
    client.close();
  });

  it("should accept other identity key types", async () => {
    const keys = new ActiveCrypto.KeyPair("rsa").generate();
    const rsa = { type: "rsa", publicKey: keys.pub.pkcs8pem, privateKey: keys.prv.pkcs8pem };
    await start({ isKnownPeer: (key, type) => key === rsa.publicKey && type === "rsa" });
    const client = await connect({ identity: rsa });
    expect(await client.request("echo", "rsa", 2000)).to.equal("rsa");
    client.close();
  });

  it("should push both ways and answer requests from the server side", async () => {
    await start();
    const [client, remote] = await pair();

    const atServer = new Promise((resolve) => server.handle("feed", resolve));
    const atClient = new Promise((resolve) => client.handle("feed", resolve));
    client.handle("peers", () => ["a", "b"]);

    await client.push("feed", { from: "client" });
    await remote.push("feed", { from: "server" });
    expect(await atServer).to.deep.equal({ from: "client" });
    expect(await atClient).to.deep.equal({ from: "server" });
    expect(await remote.request("peers", null, 2000)).to.deep.equal(["a", "b"]);
    client.close();
  });

  it("should reject a request to a channel with no handler, and time out", async () => {
    await start();
    const [client] = await pair();
    server.handle("slow", () => new Promise(() => {}));
    await expectReject(client.request("nothing", {}, 2000), /no handler for channel nothing/);
    await expectReject(client.request("slow", {}, 100), /timed out/);
    client.close();
  });

  it("should reject an unknown peer", async () => {
    await start({ isKnownPeer: () => false });
    const rejected = once<string>(server, "reject");
    await expectReject(connect(), REFUSED);
    expect((await rejected)[0]).to.equal("unknown peer");
    expect(server.connections.size).to.equal(0);
  });

  it("should reject a server that is not the expected peer", async () => {
    await start();
    await expectReject(
      connect({ expectedPeerKey: identity().publicKey }),
      /does not match expected key/
    );
  });

  it("should reject a client handshake with an invalid signature", async () => {
    await start();
    const rejected = once<string>(server, "reject");
    // Claims clientId's public key but signs with another key.
    const forged = { ...clientId, privateKey: identity().privateKey };
    await expectReject(connect({ identity: forged }), REFUSED);
    expect((await rejected)[0]).to.equal("invalid peer signature");
  });

  it("should reject a server handshake with an invalid signature", async () => {
    await start({ identity: { ...serverId, privateKey: identity().privateKey } });
    await expectReject(connect(), /invalid peer signature/);
  });

  it("should drop the connection on a tampered frame", async () => {
    await start();
    const [client, remote] = await pair();
    const closed = once<string>(remote, "close");
    tamperNextWrite(client, (frame) => {
      frame[frame.length - 1] ^= 0x01;
      return frame;
    });
    await client.push("feed", { tampered: true });
    expect((await closed)[0]).to.equal("invalid frame");
    await once(client, "close");
  });

  it("should drop the connection on a replayed frame", async () => {
    await start();
    const [client, remote] = await pair();
    let captured: Buffer | undefined;
    tamperNextWrite(client, (frame) => (captured = frame));
    expect(await client.request("echo", "first", 2000)).to.equal("first");

    const closed = once<string>(remote, "close");
    (client as any).socket.write(captured);
    expect((await closed)[0]).to.equal("invalid frame");
  });

  it("should drop the connection on an oversize frame", async () => {
    await start({ maxFrameBytes: 1024 });
    const [client, remote] = await pair();
    const closed = once<string>(remote, "close");
    await client.push("feed", "x".repeat(4096));
    expect((await closed)[0]).to.match(/exceeds 1024/);
  });

  it("should refuse to send a frame over its own limit", async () => {
    await start();
    const client = await connect({ maxFrameBytes: 1024 });
    await expectReject(client.push("feed", "x".repeat(4096)), /exceeds 1024/);
    expect(await client.request("echo", "still open", 2000)).to.equal("still open");
    client.close();
  });

  it("should cap inbound connections", async () => {
    await start({ maxConnections: 1 });
    const [first] = await pair();
    const rejected = once<string>(server, "reject");
    await expectReject(connect(), REFUSED);
    expect((await rejected)[0]).to.equal("connection limit reached");
    expect(await first.request("echo", "ok", 2000)).to.equal("ok");
    first.close();
  });

  it("should refuse a client that does not say who the server must be", async () => {
    await start();
    await expectReject(
      P2PClient.connect({ host: "127.0.0.1", port: server.port, identity: clientId }),
      /expectedPeerKey or isKnownPeer/
    );
  });

  it("should cap unauthenticated sockets per address and evict the oldest when full", async () => {
    await start({ maxHandshaking: 2, maxHandshakingPerAddress: 2, handshakeTimeoutMs: 5000 });
    const net = await import("net");
    const idle = [1, 2].map(() => net.connect({ host: "127.0.0.1", port: server.port }));
    await new Promise((r) => setTimeout(r, 50));
    // Same address already holds its two: refused
    const rejected = once<string>(server, "reject");
    const third = net.connect({ host: "127.0.0.1", port: server.port });
    expect((await rejected)[0]).to.equal("too many unauthenticated connections");
    third.destroy();
    idle.forEach((s) => s.destroy());
  });

  it("should let a real peer in when half-open sockets from other addresses fill the cap", async () => {
    await start({ maxHandshaking: 1, maxHandshakingPerAddress: 4, handshakeTimeoutMs: 5000 });
    const net = await import("net");
    const idle = net.connect({ host: "127.0.0.1", port: server.port });
    await new Promise((r) => setTimeout(r, 50));
    const [client] = await pair();
    expect(await client.request("echo", "in", 2000)).to.equal("in");
    client.close();
    idle.destroy();
  });

  it("should group addresses so IPv4-mapped and IPv6 /64 count together", () => {
    expect(addressGroup("::ffff:10.1.2.3")).to.equal("10.1.2.3");
    expect(addressGroup("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).to.equal("2001:db8:1:2");
    expect(addressGroup("2001:db8:1:2:1:1:1:1")).to.equal(addressGroup("2001:db8:1:2:9:9:9:9"));
    expect(addressGroup("10.0.0.1")).to.equal("10.0.0.1");
    expect(addressGroup(undefined)).to.equal("unknown");
  });

  it("should time out a handshake that never completes", async () => {
    await start({ handshakeTimeoutMs: 100 });
    const rejected = once<string>(server, "reject");
    const net = await import("net");
    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    expect((await rejected)[0]).to.equal("handshake timed out");
    socket.destroy();
  });
});

async function expectReject(promise: Promise<any>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}
