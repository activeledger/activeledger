import { expect } from "chai";
import "mocha";
import * as net from "net";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Home } from "../packages/network/src/network/home";
import { Host } from "../packages/network/src/network/host";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";
import { P2PClient } from "../packages/network/src/network/p2pClient";

/**
 * A P2P frame that is not handed to a writable socket used to vanish:
 * P2PClient.send() returned void, Neighbour.knock() answered { ok: 1 }
 * regardless, so Host.broadcast() never ran its 250ms rebroadcast (which it
 * does for any HTTP failure). A failed send must now be visible all the way
 * up: send() says so, knock() rejects, broadcast() schedules the rebroadcast.
 */
describe("P2P send failure is reported", () => {
  const realSetTimeout = setTimeout;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => realSetTimeout(resolve, ms));
  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await wait(5);
    }
  };

  let server: net.Server;
  let port: number;
  let accepted: net.Socket[];
  let received: Buffer;
  let clients: P2PClient[];

  const connected = async (): Promise<P2PClient> => {
    const before = accepted.length;
    const c = new P2PClient("127.0.0.1", port);
    clients.push(c);
    c.connect();
    await until(() => c.ready && accepted.length > before);
    return c;
  };

  beforeEach((done) => {
    accepted = [];
    clients = [];
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
    clients.forEach((c) => c.stop());
    accepted.forEach((s) => s.destroy());
    server.close(() => done());
  });

  describe("P2PClient.send", () => {
    it("reports true when the frame went to a writable socket", async () => {
      const client = await connected();
      expect(client.send(Buffer.from("ok"), "ref")).to.equal(true);
      await until(() => received.length >= 46);
    });

    it("reports false before it has ever connected", () => {
      const idle = new P2PClient("127.0.0.1", 1);
      expect(idle.send(Buffer.from("x"), "ref")).to.equal(false);
    });

    it("reports false on a destroyed socket, while ready is still true", async () => {
      const client = await connected();
      (client as any).socket.destroy();
      // The close event has not been delivered yet, so ready is still true:
      // this is the window in which knock() takes the P2P path
      expect(client.ready).to.equal(true);
      expect(client.send(Buffer.from("x"), "ref")).to.equal(false);
    });

    it("reports false on a socket that has ended its writable side", async () => {
      const client = await connected();
      (client as any).socket.end();
      expect(client.ready).to.equal(true);
      expect(client.send(Buffer.from("x"), "ref")).to.equal(false);
    });

    it("reports false after stop()", async () => {
      const client = await connected();
      client.stop();
      expect(client.send(Buffer.from("x"), "ref")).to.equal(false);
    });

    it("reports false once the connection is lost, and true again when it is back", async () => {
      const client = await connected();
      (client as any).socket.destroy();
      await until(() => !client.ready);
      expect(client.send(Buffer.from("x"), "ref")).to.equal(false);
      client.connect();
      await until(() => client.ready);
      expect(client.send(Buffer.from("y"), "ref")).to.equal(true);
      await until(() => received.length >= 45);
    });

    it("reports a frame accepted into the cork that the socket then fails to write", async () => {
      const client = await connected();
      const dropped: number[] = [];
      client.on("dropped", (n: number) => dropped.push(n));
      const socket: any = (client as any).socket;
      // Accepted: the socket is writable and corked
      expect(client.send(Buffer.from("doomed"), "ref")).to.equal(true);
      expect(client.send(Buffer.from("doomed too"), "ref")).to.equal(true);
      // ... then it dies before the uncork flushes them
      socket.destroy();
      await until(() => dropped.length > 0);
      expect(dropped.reduce((a, b) => a + b, 0)).to.equal(2);
    });

    it("does not report a dropped frame for frames that were written", async () => {
      const client = await connected();
      const dropped: number[] = [];
      client.on("dropped", (n: number) => dropped.push(n));
      client.send(Buffer.from("fine"), "ref");
      await until(() => received.length >= 48);
      client.stop();
      await wait(20);
      expect(dropped).to.deep.equal([]);
    });
  });

  describe("Neighbour.knock on the P2P path", () => {
    const key = new ActiveCrypto.KeyPair("rsa");
    const keys = key.generate();
    const saved: any = {};

    before(() => {
      saved.reference = Home.reference;
      saved.p2pStream = ActiveOptions.get("p2pStream", undefined);
      saved.security = ActiveOptions.get("security", undefined);
      Home.reference = "self-ref";
      ActiveOptions.set("security", {});
    });

    after(() => {
      Home.reference = saved.reference;
      ActiveOptions.set("p2pStream", saved.p2pStream);
      ActiveOptions.set("security", saved.security);
    });

    const peerWith = (send: () => any, p = 7101): Neighbour => {
      ActiveOptions.set("p2pStream", false);
      const peer = new Neighbour(
        "127.0.0.1",
        p,
        true,
        new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
      );
      ActiveOptions.set("p2pStream", true);
      (peer as any).p2pClient = { ready: true, send };
      return peer;
    };

    it("resolves { ok: 1 } when the frame was sent", async () => {
      const peer = peerWith(() => true);
      expect(await peer.knock("init", { $umid: "u" })).to.deep.equal({ ok: 1 });
    });

    it("rejects when the frame was not sent", async () => {
      const peer = peerWith(() => false);
      let error: any;
      try {
        await peer.knock("init", { $umid: "u" }, false, 0, true);
      } catch (e) {
        error = e;
      }
      expect(error).to.be.an("error");
      expect(error.message).to.match(/P2P/);
    });

    it("rejects through a shared pre-serialised body too", async () => {
      const peer = peerWith(() => false);
      let rejected = false;
      await peer
        .knock("init", { $umid: "u" }, false, 0, true, async () =>
          Buffer.from("body")
        )
        .catch(() => (rejected = true));
      expect(rejected).to.equal(true);
    });

    it("does not mark the neighbour unavailable: its P2P socket reconnects on its own", async () => {
      const peer = peerWith(() => false);
      await peer.knock("init", { $umid: "u" }).catch(() => undefined);
      expect(peer.isHome).to.equal(true);
    });
  });

  describe("Host.broadcast after a P2P send failure", () => {
    const SELF = "self-ref";
    const key = new ActiveCrypto.KeyPair("rsa");
    const keys = key.generate();
    const saved: any = {};
    let unhandled: any[];
    const onUnhandled = (e: any) => unhandled.push(e);
    let scheduled: { fn: () => void; ms: number }[];
    let timerStub: any;

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
      unhandled = [];
      scheduled = [];
      process.on("unhandledRejection", onUnhandled);
      // Capture the rebroadcast timer instead of waiting for it
      timerStub = (fn: any, ms?: number, ...rest: any[]) => {
        if (ms === 250) {
          scheduled.push({ fn, ms });
          return 0 as any;
        }
        return realSetTimeout(fn, ms, ...rest);
      };
      (global as any).setTimeout = timerStub;
    });

    afterEach(() => {
      (global as any).setTimeout = realSetTimeout;
      process.removeListener("unhandledRejection", onUnhandled);
    });

    const peerOn = (client: any, p: number): Neighbour => {
      ActiveOptions.set("p2pStream", false);
      const peer = new Neighbour(
        "127.0.0.1",
        p,
        true,
        new ActiveCrypto.KeyPair("rsa", keys.pub.pkcs8pem)
      );
      ActiveOptions.set("p2pStream", true);
      (peer as any).p2pClient = client;
      return peer;
    };

    const hostOf = (peers: Neighbour[]) => {
      const hood: { [ref: string]: Neighbour } = {};
      peers.forEach((p) => (hood[p.reference] = p));
      const host: any = {
        reference: SELF,
        processPending: {
          u1: {
            entry: {
              $umid: "u1",
              $broadcast: true,
              $tx: { $namespace: "ns", $contract: "c", $i: {}, $o: {} },
              $nodes: { [SELF]: { vote: true, commit: false } },
            },
          },
        },
        neighbourhood: { get: () => hood, keys: () => Object.keys(hood) },
      };
      host.broadcast = (Host.prototype as any).broadcast.bind(host);
      host.broadcastResolver = (Host.prototype as any).broadcastResolver.bind(
        host
      );
      return host;
    };

    it("schedules the 250ms rebroadcast when a peer's send fails", async () => {
      const ok: Buffer[] = [];
      const good = peerOn({ ready: true, send: (d: Buffer) => ok.push(d) > 0 }, 7201);
      const bad = peerOn({ ready: true, send: () => false }, 7202);
      const host = hostOf([good, bad]);
      host.broadcast("u1");
      await wait(50);
      expect(scheduled).to.have.length(1);
      expect(host.processPending.u1.broadcasting).to.equal(false);
      expect(unhandled).to.deep.equal([]);
    });

    it("does not schedule a rebroadcast when every send succeeded", async () => {
      const a = peerOn({ ready: true, send: () => true }, 7211);
      const b = peerOn({ ready: true, send: () => true }, 7212);
      const host = hostOf([a, b]);
      host.broadcast("u1");
      await wait(50);
      expect(scheduled).to.have.length(0);
    });

    it("survives several peers failing at once without an unhandled rejection", async () => {
      const peers = [7221, 7222, 7223].map((p) =>
        peerOn({ ready: true, send: () => false }, p)
      );
      const host = hostOf(peers);
      host.broadcast("u1");
      await wait(50);
      expect(scheduled).to.have.length(1);
      expect(unhandled).to.deep.equal([]);
    });

    it("the rebroadcast reaches the peer once its socket is back", async () => {
      const client = await connected();
      const peer = peerOn(client, 7231);
      const host = hostOf([peer]);

      // The socket dies; ready is still true until the close is delivered
      (client as any).socket.destroy();
      expect(client.ready).to.equal(true);
      host.broadcast("u1");
      await wait(30);
      expect(scheduled).to.have.length(1);
      expect(received.length).to.equal(0);

      // The connection comes back
      await until(() => !client.ready);
      client.connect();
      await until(() => client.ready);

      // The rebroadcast timer fires
      scheduled[0].fn();
      await until(() => received.length > 44);
      expect(received.subarray(0, 8).toString()).to.equal(SELF.padEnd(8, " "));
      expect(host.processPending.u1.broadcasting).to.equal(false);
    });
  });
});
