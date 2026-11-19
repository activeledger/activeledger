import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";
import * as zlib from "zlib";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Home } from "../packages/network/src/network/home";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";

/**
 * Edges a mutation pass over the network package found nothing checking:
 * when the unauthenticated P2P path must not be used, recovery of a
 * neighbour, the order every node sorts the neighbourhood into, and the guard
 * that stops two health checks overlapping.
 */
describe("Network - neighbour, maintain and home edges (Activeprotocol)", () => {
  describe("Neighbour", () => {
    const remote = new ActiveCrypto.KeyPair("rsa");
    const remoteKeys = remote.generate();
    const saved: any = {};
    let server: http.Server;
    let port: number;
    let seen: { headers: http.IncomingHttpHeaders; body: Buffer }[];
    let answerBody: any;

    before((done) => {
      saved.reference = Home.reference;
      saved.identity = Home.identity;
      Home.identity = new ActiveCrypto.KeyPair("rsa");
      Home.identity.generate();
      saved.pairNow = Maintain.pairNow;
      Home.reference = "home-ref";
      Maintain.pairNow = () => undefined;
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(answerBody));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        done();
      });
    });

    after((done) => {
      Home.reference = saved.reference;
      Home.identity = saved.identity;
      Maintain.pairNow = saved.pairNow;
      server.close(() => done());
    });

    beforeEach(() => {
      seen = [];
      answerBody = { ok: 1 };
      for (const k of ["security", "p2pStream", "gzip", "network"]) saved[k] = ActiveOptions.get(k, undefined);
      ActiveOptions.set("security", {});
      ActiveOptions.set("network", "");
      ActiveOptions.set("p2pStream", undefined);
      ActiveOptions.set("gzip", undefined);
    });

    afterEach(() => {
      for (const k of ["security", "p2pStream", "gzip", "network"]) ActiveOptions.set(k, saved[k]);
    });

    const make = (isHome = false) =>
      new Neighbour("127.0.0.1", port, isHome, new ActiveCrypto.KeyPair("rsa", remoteKeys.pub.pkcs8pem));

    /** A neighbour whose P2P socket is up, counting what goes down it */
    const withP2P = (n: Neighbour) => {
      const sent: any[] = [];
      (n as any).p2pClient = { ready: true, send: (...a: any[]) => (sent.push(a), true) };
      return sent;
    };

    describe("the P2P path carries no signature or encryption", () => {
      it("is used for a plain consensus message once switched on", async () => {
        const n = make();
        ActiveOptions.set("p2pStream", true); // after construction, so no real socket is opened
        const sent = withP2P(n);
        await n.knock("init", { $umid: "p1" });
        expect(sent).to.have.length(1);
        expect(seen).to.have.length(0);
      });

      it("is not used unless switched on", async () => {
        const n = make();
        const sent = withP2P(n);
        await n.knock("init", { $umid: "p2" });
        expect(sent).to.have.length(0);
        expect(seen).to.have.length(1);
      });

      const secured: [string, () => any, any][] = [
        ["a message that asks to be signed", () => undefined, { $umid: "s1", $signed: true }],
        ["a message that asks to be encrypted", () => undefined, { $umid: "s2", $encrypt: true }],
        ["a network that requires signed consensus", () => ActiveOptions.set("security", { signedConsensus: true }), { $umid: "s3" }],
        ["a network that requires encrypted consensus", () => ActiveOptions.set("security", { encryptedConsensus: true }), { $umid: "s4" }],
      ];
      for (const [name, configure, params] of secured) {
        it(`is bypassed for ${name}, which goes over HTTP instead`, async () => {
          const n = make();
          ActiveOptions.set("p2pStream", true);
          configure();
          const sent = withP2P(n);
          await n.knock("init", params);
          expect(sent, "sent over P2P").to.have.length(0);
          expect(seen, "sent over HTTP").to.have.length(1);
        });
      }
    });

    it("compresses what it sends unless told not to", async () => {
      await make().knock("init", { $umid: "g1", filler: "x".repeat(20000) });
      expect(seen[0].headers["content-encoding"]).to.equal("gzip");
      expect(JSON.parse(zlib.gunzipSync(seen[0].body).toString())).to.be.an("object");
    });

    it("only decrypts a reply that says it is encrypted and carries a packet", async () => {
      answerBody = { $packet: "not-encrypted" };
      const res = await make().knock("init", { $umid: "e1" });
      expect(res.data).to.deep.equal({ $packet: "not-encrypted" });
      answerBody = { $enc: true };
      const res2 = await make().knock("init", { $umid: "e2" });
      expect(res2.data).to.deep.equal({ $enc: true });
    });

    it("starts out not home", () => {
      expect(new Neighbour("10.0.0.9", 1).isHome).to.equal(false);
    });

    describe("recovery of a neighbour that was down", () => {
      const realSetTimeout = global.setTimeout;
      let timers: Function[];
      beforeEach(() => {
        timers = [];
        (global as any).setTimeout = (fn: Function, ms?: number, ...a: any[]) => {
          if (!new Error().stack?.includes("neighbour.ts")) return (realSetTimeout as any)(fn, ms, ...a);
          timers.push(fn);
          return 0 as any;
        };
      });
      afterEach(() => {
        (global as any).setTimeout = realSetTimeout;
      });

      it("is home again, no longer recovering, and re-paired once it answers", async () => {
        let paired = 0;
        Maintain.pairNow = () => void paired++;
        const n: any = make(false);
        n.recovering = true;
        n.recoveryCheck();
        expect(timers).to.have.length(1);
        timers[0]();
        await new Promise((r) => setTimeout(r, 100));
        expect(n.isHome).to.equal(true);
        expect(n.recovering).to.equal(false);
        expect(paired).to.equal(1);
      });

      it("stops checking, without knocking, once the neighbour is being stopped", async () => {
        const n: any = make(false);
        n.recovering = true;
        n.graceStop = true;
        n.recoveryCheck();
        timers[0]();
        await new Promise((r) => setTimeout(r, 50));
        expect(n.recovering).to.equal(false);
        expect(n.isHome).to.equal(false);
        expect(seen).to.have.length(0);
      });
    });
  });

  describe("Maintain", () => {
    const M = Maintain as any;
    const realSetTimeout = global.setTimeout;
    const savedRef = Home.reference;

    const fake = (reference: string, knock: () => Promise<any> = async () => ({})): any => ({
      reference,
      host: "h-" + reference,
      port: 5260,
      isHome: true,
      graceStop: false,
      knock,
      setState(this: any, state: string) {
        this.isHome = state === "home";
        return true;
      },
    });
    const makeHome = (self: string, neighbours: any[]): any => {
      const map: any = {};
      neighbours.forEach((n) => (map[n.reference] = n));
      return {
        reference: self,
        neighbourhood: { get: () => map, keys: () => Object.keys(map) },
        getStatus: () => 0,
        setNeighbours: () => undefined,
      };
    };

    beforeEach(() => {
      (global as any).setTimeout = () => 0 as any;
      M.checking = false;
      M.rebasing = false;
      M.neighbourOrder = undefined;
      M.lastPairedLeft = null;
      M.lastPairedRight = null;
    });
    afterEach(() => {
      (global as any).setTimeout = realSetTimeout;
      Home.reference = savedRef;
      M.checking = false;
    });

    it("sorts a longer, reversed neighbourhood into ascending order", () => {
      const refs = ["h", "g", "f", "e", "d", "c", "b", "a"];
      M.home = makeHome("a", refs.map((r) => fake(r)));
      M.createNetworkOrder();
      expect(M.neighbourOrder.map((n: any) => n.reference)).to.deep.equal([...refs].reverse());
    });

    it("does not start a second health check while one is running", async () => {
      Home.reference = "a";
      let knocks = 0;
      const stuck = fake("b", () => {
        knocks++;
        return new Promise(() => undefined);
      });
      // Not yet found, so it is the one a check asks
      stuck.isHome = false;
      M.home = makeHome("a", [fake("a"), stuck]);
      M.createNetworkOrder();
      void M.checkNeighbourhood();
      await new Promise((r) => setImmediate(r));
      expect(M.checking).to.equal(true);
      await M.checkNeighbourhood();
      expect(knocks).to.equal(1);
    });
  });

  describe("Home", () => {
    it("sorts the territoriality map of a reversed neighbourhood into ascending order", () => {
      const refs = ["h", "g", "f", "e", "d", "c", "b", "a"];
      const map: any = {};
      refs.forEach((r) => (map[r] = { reference: r, graceStop: false }));
      const home: any = Object.create(Home.prototype);
      home.neighbourhood = { get: () => map };
      home.terriBuildMap();
      expect(home.tMap).to.deep.equal([...refs].reverse());
    });
  });
});
