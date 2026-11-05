import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveClone } from "@activeledger/activeutilities";
import { Home } from "../packages/network/src/network/home";
import { Host } from "../packages/network/src/network/host";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";

/**
 * A broadcast sends the same entry to every peer. It used to msgpack the
 * entry once per peer; it must do it once and hand every peer the same
 * bytes, with the frame on the wire unchanged.
 */
describe("Host broadcast serialises once", () => {
  const SELF = "self-ref";
  const saved: any = {};
  const key = new ActiveCrypto.KeyPair("rsa");
  const keys = key.generate();
  let realSerialize: any;
  let serializeCalls: any[];

  before(() => {
    saved.reference = Home.reference;
    saved.identity = Home.identity;
    saved.pairNow = Maintain.pairNow;
    saved.p2pStream = ActiveOptions.get("p2pStream", undefined);
    saved.security = ActiveOptions.get("security", undefined);
    Home.reference = SELF;
    Home.identity = key;
    Maintain.pairNow = () => undefined;
    ActiveOptions.set("security", {});
  });

  after(() => {
    Home.reference = saved.reference;
    Home.identity = saved.identity;
    Maintain.pairNow = saved.pairNow;
    ActiveOptions.set("p2pStream", saved.p2pStream);
    ActiveOptions.set("security", saved.security);
  });

  beforeEach(() => {
    serializeCalls = [];
    realSerialize = ActiveClone.serialize;
    (ActiveClone as any).serialize = (...args: any[]) => {
      serializeCalls.push(args);
      return realSerialize.apply(ActiveClone, args);
    };
  });

  afterEach(() => {
    (ActiveClone as any).serialize = realSerialize;
  });

  interface Sent {
    data: Buffer;
    ref: string;
  }

  // A peer on the P2P path, recording what it is asked to send
  const p2pPeer = (port: number): { peer: Neighbour; sent: Sent[] } => {
    const sent: Sent[] = [];
    ActiveOptions.set("p2pStream", false); // no real socket
    const peer = new Neighbour(
      "127.0.0.1",
      port,
      true,
      new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
    );
    ActiveOptions.set("p2pStream", true);
    (peer as any).p2pClient = {
      ready: true,
      send: (data: Buffer, ref: string) => sent.push({ data, ref }),
    };
    return { peer, sent };
  };

  // Just enough Host for broadcast(): one pending entry and a neighbourhood
  const fakeHost = (peers: Neighbour[], entry: any) => {
    const hood: { [ref: string]: Neighbour } = {};
    peers.forEach((p) => (hood[p.reference] = p));
    return {
      reference: SELF,
      processPending: { u1: { entry } },
      neighbourhood: {
        get: () => hood,
        keys: () => Object.keys(hood),
      },
      broadcastResolver: () => undefined,
    };
  };

  const entryOf = (extra: any = {}) => ({
    $umid: "u1",
    $broadcast: true,
    $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
    $nodes: { [SELF]: { vote: true, commit: false } },
    ...extra,
  });

  const run = async (host: any) => {
    (Host.prototype as any).broadcast.call(host, "u1");
    // The knocks are async; let them and their awaits settle
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  it("encodes once for any number of peers, and every peer gets the same bytes", async () => {
    const peers = [p2pPeer(7001), p2pPeer(7002), p2pPeer(7003), p2pPeer(7004)];
    await run(fakeHost(peers.map((p) => p.peer), entryOf()));

    expect(serializeCalls).to.have.length(1);
    for (const { sent } of peers) {
      expect(sent).to.have.length(1);
      expect(sent[0].ref).to.equal(SELF);
      expect(sent[0].data.equals(peers[0].sent[0].data)).to.equal(true);
    }
  });

  it("keeps the frame body byte-identical to serialising the entry directly", async () => {
    const entry = entryOf();
    const peers = [p2pPeer(7011), p2pPeer(7012)];
    await run(fakeHost(peers.map((p) => p.peer), entry));

    // What broadcast sent is the entry as it was handed to the peers
    const expected = await realSerialize.call(ActiveClone, entry, {
      enableCompression: true,
    });
    expect(entry).to.have.property("$$noreply", false);
    for (const { sent } of peers) {
      expect(sent[0].data.equals(expected)).to.equal(true);
    }
    // And it is still a decodable msgpack body of that entry
    const back: any = await ActiveClone.deserialize(peers[0].sent[0].data);
    expect(back.$umid).to.equal("u1");
    expect(back.$nodes).to.deep.equal({ [SELF]: { vote: true, commit: false } });
  });

  it("encodes once and shares the compressed body when the entry is big enough to gzip", async () => {
    const big = entryOf({ $tx: { $namespace: "ns", pad: "x".repeat(40000) } });
    const peers = [p2pPeer(7021), p2pPeer(7022), p2pPeer(7023)];
    await run(fakeHost(peers.map((p) => p.peer), big));

    expect(serializeCalls).to.have.length(1);
    expect(peers[0].sent[0].data[0]).to.equal(0x01); // gzip flag
    for (const { sent } of peers) {
      expect(sent[0].data.equals(peers[0].sent[0].data)).to.equal(true);
    }
  });

  it("snapshots the entry at broadcast time: mutating it afterwards changes nothing already sent", async () => {
    const entry: any = entryOf();
    const peers = [p2pPeer(7061), p2pPeer(7062)];
    const before = await realSerialize.call(ActiveClone, JSON.parse(JSON.stringify({ ...entry, $$noreply: false })), {
      enableCompression: true,
    });
    (Host.prototype as any).broadcast.call(
      fakeHost(peers.map((p) => p.peer), entry),
      "u1"
    );
    // The encode has already happened, synchronously, inside broadcast()
    expect(serializeCalls).to.have.length(1);
    entry.$$noreply = true;
    entry.$tx.$namespace = "mutated";
    entry.$nodes.other = { vote: false };
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const { sent } of peers) {
      expect(sent).to.have.length(1);
      expect(sent[0].data.equals(before)).to.equal(true);
    }
  });

  it("gives a gzipped entry the same bytes the per-peer path produced", async () => {
    const entry = entryOf({ $tx: { $namespace: "ns", pad: "y".repeat(40000) } });
    const peers = [p2pPeer(7071), p2pPeer(7072)];
    const old = await realSerialize.call(ActiveClone, JSON.parse(JSON.stringify({ ...entry, $$noreply: false })), {
      enableCompression: true,
    });
    await run(fakeHost(peers.map((p) => p.peer), entry));
    expect(old[0]).to.equal(0x01);
    for (const { sent } of peers) {
      expect(sent[0].data.equals(old)).to.equal(true);
    }
  });

  it("does not let the frame writer change the shared buffer", async () => {
    const peers = [p2pPeer(7081), p2pPeer(7082)];
    const realSend = (peers[0].peer as any).p2pClient.send;
    // Use the real P2PClient framing against a fake socket for the first peer
    const { P2PClient } = await import("../packages/network/src/network/p2pClient");
    const written: Buffer[] = [];
    const client: any = new P2PClient("127.0.0.1", 1);
    client.socket = { writable: true, cork: () => undefined, uncork: () => undefined, write: (b: Buffer) => written.push(b) };
    client.isConnected = true;
    (peers[0].peer as any).p2pClient = client;
    await run(fakeHost(peers.map((p) => p.peer), entryOf()));
    expect(realSend).to.be.a("function");
    expect(written).to.have.length(1);
    // Frame body is a copy of the very bytes the other peer was handed
    expect(written[0].subarray(44).equals(peers[1].sent[0].data)).to.equal(true);
    expect(written[0].readUInt32BE(40)).to.equal(peers[1].sent[0].data.length);
  });

  it("with signedConsensus on, no peer takes the P2P path and nobody gets the shared buffer", async () => {
    const a = p2pPeer(7091);
    ActiveOptions.set("security", { signedConsensus: true });
    // Signed HTTP needs somewhere to go
    try {
      await new Promise<void>((resolve) => {
        const srv = http.createServer((req, res) => {
          req.resume();
          req.on("end", () => res.end("{}"));
        });
        srv.listen(0, "127.0.0.1", async () => {
          const hp = (srv.address() as AddressInfo).port;
          ActiveOptions.set("p2pStream", false);
          const h = new Neighbour(
            "127.0.0.1",
            hp,
            true,
            new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
          );
          ActiveOptions.set("p2pStream", true);
          await run(fakeHost([a.peer, h], entryOf()));
          srv.close(() => resolve());
        });
      });
    } finally {
      ActiveOptions.set("security", {});
    }
    expect(a.sent).to.have.length(0);
    expect(serializeCalls).to.have.length(0);
  });

  it("does not send to itself or to a peer that is down", async () => {
    const a = p2pPeer(7031);
    const down = p2pPeer(7032);
    down.peer.isHome = false;
    await run(fakeHost([a.peer, down.peer], entryOf()));
    expect(a.sent).to.have.length(1);
    expect(down.sent).to.have.length(0);
    expect(serializeCalls).to.have.length(1);
  });

  it("still serialises per knock when a peer is knocked without a shared body", async () => {
    const a = p2pPeer(7041);
    await a.peer.knock("init", { $umid: "solo" }, false, 0, true);
    expect(serializeCalls).to.have.length(1);
    expect(a.sent).to.have.length(1);
  });

  describe("peers on the HTTP fallback", () => {
    let server: http.Server;
    let port: number;
    let bodies: string[];

    before((done) => {
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          bodies.push(Buffer.concat(chunks).toString());
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: 1 }));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        done();
      });
    });

    after((done) => {
      server.close(() => done());
    });

    it("sends HTTP peers the signed envelope as before and never serialises for them", async () => {
      bodies = [];
      ActiveOptions.set("p2pStream", false);
      const http1 = new Neighbour(
        "127.0.0.1",
        port,
        true,
        new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
      );
      const p2p = p2pPeer(7051);
      await run(fakeHost([http1, p2p.peer], entryOf()));

      expect(bodies.length).to.be.greaterThan(0);
      const sent = bodies.map((b) => { const p = JSON.parse(b); return p?.type === "Buffer" ? JSON.parse(Buffer.from(p.data).toString()) : p; });
      expect(sent[0].$neighbour.reference).to.equal(SELF);
      expect(p2p.sent).to.have.length(1);
      // Only the P2P peer needed an encode
      expect(serializeCalls).to.have.length(1);
    });

    it("does not serialise at all when no peer takes the P2P path", async () => {
      bodies = [];
      ActiveOptions.set("p2pStream", false);
      const only = new Neighbour(
        "127.0.0.1",
        port,
        true,
        new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
      );
      await run(fakeHost([only], entryOf()));
      expect(bodies.length).to.be.greaterThan(0);
      expect(serializeCalls).to.have.length(0);
    });
  });
});
