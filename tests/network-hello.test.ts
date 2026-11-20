import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { Home } from "../packages/network/src/network/home";
import { Maintain } from "../packages/network/src/network/maintain";
import { Neighbour } from "../packages/network/src/network/neighbour";
import { Endpoints } from "../packages/network/src/network/endpoints";

/**
 * The signed hello: a neighbour answers who it is, signed with its identity key,
 * and the asker checks the signature, the nonce, the chain, that it is known
 * there and that it is ready. Real RSA keys; the neighbour is a loopback server.
 */
describe("Neighbour hello", () => {
  const own = new ActiveCrypto.KeyPair("rsa");
  own.generate();
  const remote = new ActiveCrypto.KeyPair("rsa");
  const remoteKeys = remote.generate();
  const stranger = new ActiveCrypto.KeyPair("rsa");
  stranger.generate();

  const saved: any = {};
  let server: http.Server;
  let port: number;
  let seen: { url?: string; headers: http.IncomingHttpHeaders }[];
  /** What the fake neighbour does with a request */
  let answer: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  /** A signed hello body from the fake neighbour, with fields overridable */
  const signedHello = (
    req: http.IncomingMessage,
    over: any = {},
    key: ActiveCrypto.KeyPair = remote,
    sigOver?: string
  ) => {
    const body = {
      hello: 1,
      nonce: req.headers["x-activeledger-nonce"],
      reference: "remote-ref",
      chain: null,
      ready: true,
      knows: true,
      version: "5.9.0",
      build: 50700,
      features: ["p2pStream"],
      ...over,
    };
    return { hello: body, signature: key.sign(sigOver ?? JSON.stringify(body)) };
  };
  const json = (res: http.ServerResponse, body: any, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  before((done) => {
    saved.reference = Home.reference;
    saved.identity = Home.identity;
    saved.pairNow = Maintain.pairNow;
    Home.reference = "home-ref";
    Home.identity = own;
    Maintain.pairNow = () => undefined;
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      answer(req, res);
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
    delete process.env.AL_NO_HELLO;
    saved.chain = ActiveOptions.get("chain", undefined);
    ActiveOptions.set("chain", { id: 1 });
    answer = (req, res) => json(res, signedHello(req));
  });
  afterEach(() => ActiveOptions.set("chain", saved.chain));

  const peer = (p = port) => {
    const n = new Neighbour("127.0.0.1", p, false, new ActiveCrypto.KeyPair("rsa", remoteKeys.pub.pkcs8pem));
    n.reference = "remote-ref";
    return n;
  };
  const refused = async (n: Neighbour) => {
    let error: any;
    try {
      await n.knock("status");
    } catch (e) {
      error = e;
    }
    expect(error, "the knock should have been refused").to.be.instanceOf(Error);
    return error;
  };

  describe("asking", () => {
    it("asks /a/hello with a fresh nonce and its chain, and takes a good answer", async () => {
      const n = peer();
      const res = await n.knock("status");
      expect(res.data.reference).to.equal("remote-ref");
      expect(seen).to.have.length(1);
      expect(seen[0].url).to.equal("/a/hello");
      expect(seen[0].headers["x-activeledger"]).to.equal("home-ref");
      expect(seen[0].headers["x-activeledger-chain"]).to.equal("1");
      expect(seen[0].headers["x-activeledger-nonce"]).to.match(/^[0-9a-f]{16}$/);
      expect(n.helloSupport).to.equal(true);
      expect(n.peer).to.deep.equal({ version: "5.9.0", build: 50700, features: ["p2pStream"] });
    });

    it("uses a new nonce each time", async () => {
      const n = peer();
      await n.knock("status");
      await n.knock("status");
      expect(seen[0].headers["x-activeledger-nonce"]).to.not.equal(seen[1].headers["x-activeledger-nonce"]);
    });

    it("refuses an answer signed by some other key", async () => {
      answer = (req, res) => json(res, signedHello(req, {}, stranger));
      const n = peer();
      await refused(n);
      expect(n.state).to.equal("mismatch");
      expect(n.reason).to.equal("answer not signed by its key");
      expect(n.isHome).to.equal(false);
    });

    it("refuses an answer whose body was changed after signing", async () => {
      answer = (req, res) => {
        const r = signedHello(req);
        r.hello.ready = false; // changed on the way
        r.hello.knows = true;
        r.hello.build = 1;
        json(res, r);
      };
      await refused(peer());
    });

    it("refuses a recorded answer replayed against a new question", async () => {
      let recorded: any;
      answer = (req, res) => {
        recorded = recorded || signedHello(req);
        json(res, recorded);
      };
      const n = peer();
      await n.knock("status"); // the first is fine
      await refused(n); // the same answer again carries the old nonce
      expect(n.state).to.equal("mismatch");
    });

    it("refuses a signed answer from another node", async () => {
      answer = (req, res) => json(res, signedHello(req, { reference: "someone-else" }));
      await refused(peer());
    });

    it("refuses a neighbour on another chain, with the chain it is on", async () => {
      answer = (req, res) => json(res, signedHello(req, { chain: 5 }));
      const n = peer();
      await refused(n);
      expect(n.state).to.equal("mismatch");
      expect(n.reason).to.equal("chain 5");
    });

    it("lets through a neighbour that reports no chain", async () => {
      answer = (req, res) => json(res, signedHello(req, { chain: null }));
      expect((await peer().knock("status")).data.ready).to.equal(true);
    });

    it("says refused when the neighbour does not know this node", async () => {
      answer = (req, res) => json(res, signedHello(req, { knows: false }));
      const n = peer();
      await refused(n);
      expect(n.state).to.equal("refused");
      expect(n.reason).to.equal("not in its neighbourhood");
    });

    it("says booting when the neighbour has not loaded its neighbourhood", async () => {
      answer = (req, res) => json(res, signedHello(req, { ready: false }));
      const n = peer();
      await refused(n);
      expect(n.state).to.equal("booting");
      expect(n.isHome).to.equal(false);
    });

    it("a booting neighbour that then goes away is unreachable, and one that is ready is usable", async () => {
      answer = (req, res) => json(res, signedHello(req, { ready: false }));
      const n = peer();
      await refused(n);
      answer = (req, res) => json(res, signedHello(req));
      expect((await n.knock("status")).data.ready).to.equal(true);
      const m = peer();
      answer = (req, res) => json(res, signedHello(req, { knows: false }));
      await refused(m);
      const closed = peer(1);
      closed.setState("booting", "x");
      await refused(closed);
      expect(closed.state).to.equal("unreachable");
    });

    it("ignores fields it does not know", async () => {
      answer = (req, res) => json(res, signedHello(req, { future: { a: 1 } }));
      expect((await peer().knock("status")).data.future).to.deep.equal({ a: 1 });
    });

    it("is not reachable when the connection fails, and is not marked as lacking the hello", async () => {
      const n = peer(1);
      await refused(n);
      expect(n.helloSupport).to.equal(undefined);
    });
  });

  describe("a neighbour from before the hello", () => {
    const oldNode = (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.url === "/a/hello") {
        res.statusCode = 404;
        res.end("Not Found"); // not JSON
        return;
      }
      json(res, { statusCode: 200 });
    };

    it("is asked the old way after one hello, and remembered", async () => {
      answer = oldNode;
      const n = peer();
      await n.knock("status");
      expect(seen.map((s) => s.url)).to.deep.equal(["/a/hello", "/a/status"]);
      expect(n.helloSupport).to.equal(false);
      expect(n.peer).to.equal(undefined);
      await n.knock("status");
      await n.knock("status");
      expect(seen.map((s) => s.url)).to.deep.equal(["/a/hello", "/a/status", "/a/status", "/a/status"]);
    });

    it("also falls back from a 403 and from JSON that is not a hello", async () => {
      answer = (req, res) =>
        req.url === "/a/hello" ? json(res, { nothing: true }) : json(res, { statusCode: 200 });
      const n = peer();
      await n.knock("status");
      expect(n.helloSupport).to.equal(false);
    });

    it("tries the hello again after ten minutes, in case it was upgraded", async () => {
      answer = oldNode;
      const n = peer();
      await n.knock("status");
      (n as any).helloFallbackAt = Date.now() - 11 * 60 * 1000;
      answer = (req, res) => json(res, signedHello(req));
      await n.knock("status");
      expect(seen[seen.length - 1].url).to.equal("/a/hello");
      expect(n.helloSupport).to.equal(true);
    });

    it("still refuses an old node on another chain through the status answer", async () => {
      answer = (req, res) =>
        req.url === "/a/hello" ? (res.statusCode = 404, res.end("x")) : json(res, { chainMismatch: 9 });
      const n = peer();
      await refused(n);
      expect(n.state).to.equal("mismatch");
    });

    it("is asked by status knock only, when told not to say hello", async () => {
      process.env.AL_NO_HELLO = "1";
      answer = oldNode;
      await peer().knock("status");
      expect(seen.map((s) => s.url)).to.deep.equal(["/a/status"]);
    });

    it("is asked by status knock when there is no key to check a hello with", async () => {
      answer = oldNode;
      const n = new Neighbour("127.0.0.1", port, false);
      await n.knock("status");
      expect(seen.map((s) => s.url)).to.deep.equal(["/a/status"]);
    });
  });

  describe("answering", () => {
    let checked: string[];
    let realCheck: any;
    let rebased: number;
    let realRebase: any;
    before(() => {
      realCheck = Maintain.checkNeighbour;
      realRebase = Maintain.rebaseNeighbourhood;
    });
    after(() => {
      Maintain.checkNeighbour = realCheck;
      Maintain.rebaseNeighbourhood = realRebase;
    });
    beforeEach(() => {
      checked = [];
      rebased = 0;
      Maintain.checkNeighbour = ((n: any) => void checked.push(n.reference)) as any;
      Maintain.rebaseNeighbourhood = (() => void rebased++) as any;
      Endpoints.rebaseThrottle = 0;
    });

    const hostWith = (neighbours: { [ref: string]: any }) =>
      ({
        reference: "home-ref",
        neighbourhood: {
          get: (ref?: string) => (ref ? neighbours[ref] : neighbours),
          keys: () => Object.keys(neighbours),
        },
      }) as any;
    const verified = (content: any) => own.verify(JSON.stringify(content.hello), content.signature);

    it("signs who it is with its own key, echoing the nonce", async () => {
      const res = await Endpoints.hello(hostWith({ peer: { graceStop: false, isHome: true } }), "peer", "1", "abc123", "10.0.0.2");
      expect(res.statusCode).to.equal(200);
      expect(res.content.hello).to.include({ hello: 1, nonce: "abc123", reference: "home-ref", chain: 1, ready: true, knows: true });
      expect(verified(res.content)).to.equal(true);
      expect(res.content.hello.build).to.be.a("number");
      expect(res.content.hello.features).to.be.an("array");
    });

    it("a signature does not verify once the body is altered", async () => {
      const res = await Endpoints.hello(hostWith({ peer: { graceStop: false, isHome: true } }), "peer", "1", "n", "10.0.0.2");
      res.content.hello.knows = false;
      expect(verified(res.content)).to.equal(false);
    });

    it("tells a stranger only the minimum", async () => {
      const res = await Endpoints.hello(hostWith({ peer: { graceStop: false } }), "NA", undefined, "n");
      expect(res.content.hello.knows).to.equal(false);
      expect(res.content.hello).to.not.have.any.keys("version", "build", "features");
      const other = await Endpoints.hello(hostWith({ peer: { graceStop: false } }), "not-a-neighbour", "1", "n");
      expect(other.content.hello.knows).to.equal(false);
      expect(other.content.hello).to.not.have.any.keys("version", "build");
    });

    it("does not know a neighbour that is leaving", async () => {
      const res = await Endpoints.hello(hostWith({ peer: { graceStop: true } }), "peer", "1", "n");
      expect(res.content.hello.knows).to.equal(false);
    });

    it("says it is not ready before its neighbourhood is loaded", async () => {
      const res = await Endpoints.hello(hostWith({}), "peer", "1", "n");
      expect(res.content.hello.ready).to.equal(false);
    });

    it("asks a neighbour that is not home back at once", async () => {
      await Endpoints.hello(hostWith({ peer: { reference: "peer", graceStop: false, isHome: false } }), "peer", "1", "n");
      expect(checked).to.deep.equal(["peer"]);
      checked.length = 0;
      await Endpoints.hello(hostWith({ peer: { reference: "peer", graceStop: false, isHome: true } }), "peer", "1", "n");
      expect(checked).to.deep.equal([]);
    });

    it("does not ask back a neighbour on another chain, and says its own chain", async () => {
      const res = await Endpoints.hello(hostWith({ peer: { reference: "peer", graceStop: false, isHome: false } }), "peer", "5", "n", "10.0.0.9");
      expect(checked).to.deep.equal([]);
      expect(res.content.hello.chain).to.equal(1);
    });

    it("rebases like a status knock after enough knocks", async () => {
      const host = hostWith({ peer: { reference: "peer", graceStop: false, isHome: true } });
      for (let i = 0; i < 10; i++) await Endpoints.hello(host, "peer", "1", "n");
      expect(rebased).to.equal(1);
    });

    it("limits the nonce it echoes", async () => {
      const res = await Endpoints.hello(hostWith({}), "NA", undefined, "x".repeat(500));
      expect(res.content.hello.nonce).to.have.length(64);
    });
  });
});
