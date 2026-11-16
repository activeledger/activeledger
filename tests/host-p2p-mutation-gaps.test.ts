import { expect } from "chai";
import "mocha";
import { EventEmitter } from "events";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveClone } from "@activeledger/activeutilities";
import { ActiveLogger } from "@activeledger/activelogger";
import { Host } from "../packages/network/src/network/host";

/**
 * The P2P TCP server of a node: when it runs at all, how a connection is set
 * up, and how frames of [sender (40)][length (4)][payload] are cut from what
 * arrives however it is split up. Found untested by a mutation pass over host.ts.
 */
describe("Host P2P connections (Activenetwork)", () => {
  const H: any = Host;

  describe("whether the server runs", () => {
    it("is off unless p2pStreamServer is set", () => {
      const held: any = ActiveOptions.fetch(false);
      const had = "p2pStreamServer" in held;
      const old = held.p2pStreamServer;
      try {
        delete held.p2pStreamServer;
        expect(H.p2pServerWanted()).to.equal(false);
        ActiveOptions.set("p2pStreamServer", true);
        expect(H.p2pServerWanted()).to.equal(true);
      } finally {
        if (had) held.p2pStreamServer = old;
        else delete held.p2pStreamServer;
      }
    });
  });

  describe("one connection", () => {
    const realWarn = ActiveLogger.warn;
    const realInfo = ActiveLogger.info;
    let warns: string[];
    let handled: { headers: any; remote: string; tx: any; sender: string; internal: boolean }[];
    let noDelay: any[];

    beforeEach(() => {
      warns = [];
      handled = [];
      noDelay = [];
      (ActiveLogger as any).warn = (...a: any[]) => warns.push(String(a[a.length - 1]));
      (ActiveLogger as any).info = () => undefined;
    });
    afterEach(() => {
      (ActiveLogger as any).warn = realWarn;
      (ActiveLogger as any).info = realInfo;
    });

    const connect = (remoteAddress: string | null = "10.0.0.5") => {
      const host: any = Object.assign(Object.create(Host.prototype), {
        processEndpoints: (req: any, _res: any, tx: any, sender: string, internal: boolean) =>
          handled.push({ headers: req.headers, remote: req.connection.remoteAddress, tx, sender, internal }),
      });
      const socket: any = new EventEmitter();
      socket.remoteAddress = remoteAddress;
      socket.setNoDelay = (v: boolean) => noDelay.push(v);
      host.p2pConnection(socket);
      return { socket };
    };
    const frame = async (sender: string, payload: any): Promise<Buffer> => {
      const body = Buffer.from(await ActiveClone.serialize(payload));
      const header = Buffer.alloc(44);
      header.write(sender.padEnd(40), 0);
      header.writeUInt32BE(body.length, 40);
      return Buffer.concat([header, body]);
    };
    const settle = () => new Promise((r) => setTimeout(r, 30));

    it("turns Nagle's algorithm off", () => {
      connect();
      expect(noDelay).to.deep.equal([true]);
    });

    it("hands a whole frame to the endpoints as an internal transaction from its sender", async () => {
      const { socket } = connect("10.0.0.5");
      socket.emit("data", await frame("senderref", { $umid: "u1" }));
      await settle();
      expect(handled).to.have.length(1);
      expect(handled[0].tx).to.deep.equal({ $umid: "u1" });
      expect(handled[0].sender).to.equal("senderref");
      expect(handled[0].internal).to.equal(true);
      expect(handled[0].headers).to.deep.equal({ "X-Activeledger": "senderref" });
      expect(handled[0].remote).to.equal("10.0.0.5");
    });

    it("treats an address it cannot read as this machine", async () => {
      const { socket } = connect(null);
      socket.emit("data", await frame("s", { $umid: "u" }));
      await settle();
      expect(handled[0].remote).to.equal("127.0.0.1");
    });

    it("waits for the rest of a frame that arrives in pieces, down to the last byte", async () => {
      const { socket } = connect();
      const whole = await frame("s", { $umid: "pieces", pad: "x".repeat(500) });
      socket.emit("data", whole.subarray(0, 20));
      socket.emit("data", whole.subarray(20, 44));
      socket.emit("data", whole.subarray(44, whole.length - 1));
      await settle();
      expect(handled).to.have.length(0);
      socket.emit("data", whole.subarray(whole.length - 1));
      await settle();
      expect(handled.map((h) => h.tx.$umid)).to.deep.equal(["pieces"]);
    });

    it("cuts several frames from one chunk, and keeps what follows a frame for the next", async () => {
      const { socket } = connect();
      const a = await frame("a", { $umid: "one" });
      const b = await frame("b", { $umid: "two" });
      const c = await frame("c", { $umid: "three" });
      socket.emit("data", Buffer.concat([a, b, c.subarray(0, 50)]));
      await settle();
      expect(handled.map((h) => h.tx.$umid)).to.deep.equal(["one", "two"]);
      socket.emit("data", c.subarray(50));
      await settle();
      expect(handled.map((h) => h.tx.$umid)).to.deep.equal(["one", "two", "three"]);
    });

    it("drops a frame it cannot decode, says so, and carries on with the next", async () => {
      const { socket } = connect();
      const bad = Buffer.alloc(44 + 4);
      bad.write("badsender".padEnd(40), 0);
      bad.writeUInt32BE(4, 40);
      bad.write("\u0001\u0002\u0003\u0004", 44, "latin1");
      socket.emit("data", Buffer.concat([bad, await frame("good", { $umid: "after" })]));
      await settle();
      expect(handled.map((h) => h.tx.$umid)).to.deep.equal(["after"]);
      expect(warns).to.have.length(1);
      expect(warns[0]).to.contain("P2P dropped malformed frame").and.contain("badsender");
    });

    it("treats a frame of just its 44 byte header as a frame with nothing in it, and drops it", async () => {
      const { socket } = connect();
      const empty = Buffer.alloc(44);
      empty.write("empty".padEnd(40), 0);
      socket.emit("data", empty);
      await settle();
      expect(handled).to.have.length(0);
      expect(warns).to.have.length(1);
      expect(warns[0]).to.contain("P2P dropped malformed frame").and.contain("empty");
    });
  });
});
