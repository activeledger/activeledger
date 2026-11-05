import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";
import { ActiveCrypto } from "../packages/crypto/src";
import { HttpUpstream, UpstreamError, identityFrom } from "../packages/hybrid/src/http-upstream";

const g = new ActiveCrypto.KeyPair("rsa").generate();
const identity = identityFrom({ prv: { pkcs8pem: g.prv.pkcs8pem }, pub: { pkcs8pem: g.pub.pkcs8pem } });

describe("HttpUpstream, hostile or broken responses (cov)", () => {
  let server: http.Server;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let sockets: Set<import("net").Socket>;
  let port: number;

  beforeEach(async () => {
    sockets = new Set();
    server = http.createServer((req, res) => handler(req, res));
    server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });

  const up = (over: any = {}) => new HttpUpstream({ host: "127.0.0.1", port, identity, ...over });
  const reject = async (p: Promise<any>): Promise<UpstreamError> => {
    try {
      await p;
    } catch (e) {
      return e as UpstreamError;
    }
    throw new Error("expected a rejection");
  };
  const reply = (status: number, body: string, headers: Record<string, string> = {}) => {
    handler = (_req, res) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body);
    };
  };

  describe("size limits", () => {
    it("refuses a response that declares more than the limit, without reading it", async () => {
      const big = JSON.stringify({ cursor: "c", time: 1, pad: "x".repeat(200) });
      let sent = 0;
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) });
        sent++;
        res.end(big);
      };
      const e = await reject(up({ maxResponseBytes: 50 }).head());
      expect(sent).to.equal(1);
      expect(e).to.be.instanceOf(UpstreamError);
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.contain("response too large");
    });
    it("refuses a response that outgrows the limit while streaming", async () => {
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"cursor":"c","time":1,"pad":"' + "x".repeat(40));
        setTimeout(() => res.end("x".repeat(400) + '"}'), 20);
      };
      const e = await reject(up({ maxResponseBytes: 100 }).head());
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.contain("response too large");
    });
    it("accepts a response exactly at the limit", async () => {
      const body = JSON.stringify({ cursor: "c", time: 1 });
      reply(200, body);
      expect((await up({ maxResponseBytes: Buffer.byteLength(body) }).head()).cursor).to.equal("c");
    });
    it("a response one byte over the limit is refused", async () => {
      const body = JSON.stringify({ cursor: "c", time: 1 });
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(body.slice(0, 5));
        setTimeout(() => res.end(body.slice(5)), 10);
      };
      const e = await reject(up({ maxResponseBytes: Buffer.byteLength(body) - 1 }).head());
      expect(e.message).to.contain("response too large");
    });
  });

  describe("malformed answers", () => {
    it("head without a cursor or time", async () => {
      for (const body of ['{}', '{"cursor":1,"time":1}', '{"cursor":"c","time":"1"}', "[]", "null"]) {
        reply(200, body);
        const e = await reject(up().head());
        expect(e.kind, body).to.equal("protocol");
        expect(e.message).to.contain("GET /h/head: malformed response");
      }
    });
    it("head carries minVersion only when it is a string", async () => {
      reply(200, '{"cursor":"c","time":2,"minVersion":"5.1.0"}');
      expect(await up().head()).to.deep.equal({ cursor: "c", time: 2, minVersion: "5.1.0" });
      reply(200, '{"cursor":"c","time":2,"minVersion":5}');
      expect((await up().head()).minVersion).to.equal(undefined);
    });
    it("streams without docs or missing arrays", async () => {
      for (const body of ['{"docs":1,"missing":[]}', '{"docs":[]}', '{"missing":[]}', "[]"]) {
        reply(200, body);
        const e = await reject(up().streams([{ id: "a" }]));
        expect(e.kind, body).to.equal("protocol");
        expect(e.message).to.contain("POST /h/streams: malformed response");
      }
    });
    it("streams passes a well-formed answer through", async () => {
      reply(200, '{"docs":[{"_id":"a"}],"missing":[{"id":"b"}]}');
      expect(await up().streams([{ id: "a" }, { id: "b" }])).to.deep.equal({ docs: [{ _id: "a" }], missing: [{ id: "b" }] });
    });
  });

  describe("feed", () => {
    const sse = (text: string) => {
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(text);
        setTimeout(() => res.end(), 30);
      };
    };
    const run = (signal = new AbortController().signal) => up().feed("", async () => undefined, signal);

    it("fails on a heartbeat that is not JSON", async () => {
      sse("event: heartbeat\ndata: nope\n\n");
      const e = await reject(run());
      expect(e.kind).to.equal("protocol");
      expect(e.message).to.contain("heartbeat is not JSON");
    });
    it("fails on a heartbeat of the wrong shape", async () => {
      for (const data of ['{"head":1,"time":1}', '{"head":"h","time":"1"}', "[]"]) {
        sse(`event: heartbeat\ndata: ${data}\n\n`);
        const e = await reject(run());
        expect(e.message, data).to.contain("malformed heartbeat");
      }
    });
    it("reports a heartbeat's head, time and minVersion", async () => {
      sse('event: heartbeat\ndata: {"head":"h1","time":5,"minVersion":"5.1.1"}\n\nevent: heartbeat\ndata: {"head":"h2","time":6,"minVersion":7}\n\n');
      const beats: any[] = [];
      await up().feed("", async () => undefined, new AbortController().signal, (h, t, v) => beats.push([h, t, v]));
      expect(beats).to.deep.equal([["h1", 5, "5.1.1"], ["h2", 6, undefined]]);
    });
    it("fails with a network error when nothing is listening", async () => {
      const closed = http.createServer();
      await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
      const deadPort = (closed.address() as AddressInfo).port;
      await new Promise((r) => closed.close(r));
      const e = await reject(new HttpUpstream({ host: "127.0.0.1", port: deadPort, identity }).feed("", async () => undefined, new AbortController().signal));
      expect(e).to.be.instanceOf(UpstreamError);
      expect(e.kind).to.equal("network");
      expect(e.message).to.contain("GET /h/feed");
    });
    it("returns quietly when told to stop while still connecting", async () => {
      handler = () => {
        /* never answers */
      };
      const ctl = new AbortController();
      const done = run(ctl.signal);
      setTimeout(() => ctl.abort(), 50);
      let err: any;
      await done.catch((e) => (err = e));
      expect(err).to.equal(undefined);
    });
  });
});
