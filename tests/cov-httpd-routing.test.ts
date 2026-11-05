import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as zlib from "zlib";
import { us_socket_local_port } from "uWebSockets.js";
import { ActiveHttpd } from "../packages/httpd/src/httpd";

interface Res { status: number; headers: http.IncomingHttpHeaders; raw: Buffer; body: string }

function request(
  port: number, method: string, path: string, body?: Buffer | string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode || 0, headers: res.headers, raw, body: raw.toString() });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("ActiveHttpd routing and bodies", () => {
  let httpd: ActiveHttpd;
  let port: number;
  let last: any;
  let lastReq: any;

  before(async () => {
    httpd = new ActiveHttpd();
    const tag = (name: string) => async (incoming: any, req: any) => {
      last = incoming; lastReq = req;
      return { route: name };
    };
    httpd.use("/", "GET", tag("root"));
    httpd.use("/a/b", "GET", tag("a/b"));
    httpd.use("/a/*", "GET", tag("a/*"));
    httpd.use("/a/*/c", "GET", tag("a/*/c"));
    httpd.use("/deep/**", "GET", tag("deep/**"));
    httpd.use("/echo", "POST", async (incoming: any, req: any) => { last = incoming; lastReq = req; return { got: incoming.body }; });
    httpd.use("/echo", "PUT", async (incoming: any) => ({ put: incoming.body }));
    httpd.use("/mime", "GET", async () => ({ mime: "text/plain", data: "plain text" }));
    httpd.use("/buf", "GET", async () => ({ mime: "application/octet-stream", data: Buffer.from([1, 2, 3]) }));
    httpd.use("/str", "GET", async () => "just a string");
    httpd.use("/handled", "GET", async (_i: any, _r: any, res: any) => {
      res.cork(() => { res.writeStatus("202"); res.end("manual"); });
      return "handled";
    });
    httpd.use("/none", "GET", async () => undefined);
    httpd.use("/err-status", "GET", async () => { throw { status: 418, msg: "teapot" }; });
    httpd.use("/err-statusCode", "GET", async () => { throw { statusCode: 409, msg: "conflict" }; });
    httpd.use("/err-default", "GET", async () => { throw { msg: "kaboom" }; });
    httpd.listen(0);
    await new Promise((r) => setTimeout(r, 200));
    port = us_socket_local_port((httpd as any).listenSocket);
  });

  after(() => httpd.shutdown(false));

  it("binds a real random port", () => {
    expect(port).to.be.greaterThan(0);
  });

  it("root path routes to the '/' handler with url ['/']", async () => {
    const r = await request(port, "GET", "/");
    expect(r.status).to.equal(200);
    expect(JSON.parse(r.body)).to.deep.equal({ route: "root" });
    expect(last.url).to.deep.equal(["/"]);
    expect(last.body).to.equal("");
  });

  it("exact route beats wildcard", async () => {
    expect(JSON.parse((await request(port, "GET", "/a/b")).body).route).to.equal("a/b");
    expect(JSON.parse((await request(port, "GET", "/a/zzz")).body).route).to.equal("a/*");
    expect(JSON.parse((await request(port, "GET", "/a/zzz/c")).body).route).to.equal("a/*/c");
  });

  it("** matches arbitrarily deep paths", async () => {
    expect(JSON.parse((await request(port, "GET", "/deep/x")).body).route).to.equal("deep/**");
    expect(JSON.parse((await request(port, "GET", "/deep/x/y/z")).body).route).to.equal("deep/**");
  });

  it("specific method routes do not answer other methods", async () => {
    expect(await statusOf("GET", ["echo"])).to.equal("404");
    expect(await statusOf("POST", ["a", "b"])).to.equal("404");
    expect(await statusOf("DELETE", ["a", "b"])).to.equal("404");
  });

  // NOTE: 404 responses are driven through processListen with a fake response,
  // because writeResponse never calls res.end() for empty content, so a real
  // client would hang (see report: httpd.ts writeResponse empty-content path).
  const statusOf = async (method: string, url: string[]): Promise<string | undefined> => {
    const log: any[] = [];
    const res: any = {
      writable: true,
      cork: (fn: () => void) => fn(),
      writeStatus: (st: string) => log.push(st),
      writeHeader: () => {},
      end: () => {},
    };
    await (httpd as any).processListen({ url, ip: { remote: "x" } }, { headers: {}, method, url: "/" + url.join("/"), connection: { remoteAddress: "x" } }, res);
    return log[0];
  };

  it("unknown paths and over-long paths are 404", async () => {
    for (const p of [["nothing"], ["a", "b", "c", "d"], ["a"]]) {
      expect(await statusOf("GET", p), p.join("/")).to.equal("404");
    }
  });

  it("POST bodies are parsed as JSON; PUT too", async () => {
    const r = await request(port, "POST", "/echo", JSON.stringify({ a: [1, 2], b: "x" }));
    expect(r.status).to.equal(200);
    expect(JSON.parse(r.body)).to.deep.equal({ got: { a: [1, 2], b: "x" } });
    const p = await request(port, "PUT", "/echo", JSON.stringify({ z: 1 }));
    expect(JSON.parse(p.body)).to.deep.equal({ put: { z: 1 } });
  });

  it("large multi-chunk bodies are reassembled", async () => {
    const big = { data: "x".repeat(300000) };
    const r = await request(port, "POST", "/echo", JSON.stringify(big));
    expect(JSON.parse(r.body).got.data.length).to.equal(300000);
  });

  it("gzip bodies are decompressed via content-encoding header", async () => {
    const r = await request(port, "POST", "/echo", zlib.gzipSync(JSON.stringify({ g: 1 })), { "content-encoding": "gzip" });
    expect(JSON.parse(r.body)).to.deep.equal({ got: { g: 1 } });
  });

  it("gzip bodies are decompressed by magic number without the header", async () => {
    const r = await request(port, "POST", "/echo", zlib.gzipSync(JSON.stringify({ m: 1 })));
    expect(JSON.parse(r.body)).to.deep.equal({ got: { m: 1 } });
  });

  it("a gzip header on a non-gzip body falls back to the raw JSON", async () => {
    const r = await request(port, "POST", "/echo", JSON.stringify({ plain: 1 }), { "content-encoding": "gzip" });
    expect(JSON.parse(r.body)).to.deep.equal({ got: { plain: 1 } });
  });

  it("query string and url segments reach the handler; GET body is empty string", async () => {
    await request(port, "GET", "/a/q?x=1&y=two");
    expect(last.url).to.deep.equal(["a", "q"]);
    expect(last.query).to.deep.equal({ x: "1", y: "two" });
    expect(last.body).to.equal("");
  });

  it("request details: method, url, headers and remote address", async () => {
    await request(port, "GET", "/a/q?x=1", undefined, {
      "x-activeledger": "ledger", "x-bundle": "bun", "last-event-id": "77",
      "accept-encoding": "gzip", "x-activeledger-encrypt": "enc",
    });
    expect(lastReq.method).to.equal("GET");
    expect(lastReq.url).to.equal("/a/q");
    expect(lastReq.headers["X-Activeledger"]).to.equal("ledger");
    expect(lastReq.headers["X-Bundle"]).to.equal("bun");
    expect(lastReq.headers["Last-Event-ID"]).to.equal("77");
    expect(lastReq.headers["Accept-Encoding"]).to.equal("gzip");
    expect(lastReq.headers["x-activeledger-encrypt"]).to.equal("enc");
    expect(lastReq.connection.remoteAddress).to.be.a("string").and.not.equal("");
    expect(last.ip.remote).to.equal(lastReq.connection.remoteAddress);
    expect(lastReq.connection.remoteAddress).to.match(/127\.0\.0\.1$|7f00:0001$|0000:0001$/);
  });

  it("POST carries content-length and content-encoding headers through", async () => {
    const body = JSON.stringify({ k: 1 });
    await request(port, "POST", "/echo", body, { "Content-Length": String(body.length) });
    expect(lastReq.method).to.equal("POST");
    expect(lastReq.headers["Content-Length"]).to.equal(String(body.length));
    expect(last.ip.remote).to.equal(lastReq.connection.remoteAddress);
  });

  it("mime results set Content-Type and send data raw", async () => {
    const r = await request(port, "GET", "/mime");
    expect(r.status).to.equal(200);
    expect(r.headers["content-type"]).to.equal("text/plain");
    expect(r.body).to.equal("plain text");
    const b = await request(port, "GET", "/buf");
    expect(b.headers["content-type"]).to.equal("application/octet-stream");
    expect([...b.raw]).to.deep.equal([1, 2, 3]);
  });

  it("plain results default to application/json with CORS headers", async () => {
    const r = await request(port, "GET", "/a/b");
    expect(r.headers["content-type"]).to.equal("application/json");
    expect(r.headers["access-control-allow-origin"]).to.equal("*");
    const s = await request(port, "GET", "/str");
    expect(s.body).to.equal("just a string");
  });

  it("'handled' leaves the response to the handler", async () => {
    const r = await request(port, "GET", "/handled");
    expect(r.status).to.equal(202);
    expect(r.body).to.equal("manual");
  });

  it("falsy handler result is a 404", async () => {
    expect(await statusOf("GET", ["none"])).to.equal("404");
  });

  it("thrown errors use status, then statusCode, else 500, and are sent as JSON", async () => {
    const a = await request(port, "GET", "/err-status");
    expect(a.status).to.equal(418);
    expect(JSON.parse(a.body)).to.deep.equal({ status: 418, msg: "teapot" });
    const b = await request(port, "GET", "/err-statusCode");
    expect(b.status).to.equal(409);
    expect(JSON.parse(b.body).msg).to.equal("conflict");
    const c = await request(port, "GET", "/err-default");
    expect(c.status).to.equal(500);
    expect(JSON.parse(c.body)).to.deep.equal({ msg: "kaboom" });
  });

  describe("internals", () => {
    const fakeRes = () => {
      const log: any[] = [];
      const res: any = {
        writable: true,
        cork: (fn: () => void) => fn(),
        writeStatus: (s: string) => log.push(["status", s]),
        writeHeader: (k: string, v: string) => log.push(["header", k, v]),
        end: (c: any) => log.push(["end", c]),
      };
      return { res, log };
    };

    it("writeResponse does nothing when the client has gone", async () => {
      const { res, log } = fakeRes();
      res.writable = false;
      await (httpd as any).writeResponse(res, 200, {}, "x");
      expect(log).to.deep.equal([]);
    });

    it("writeResponse gzips content and sets Content-Encoding", async () => {
      const { res, log } = fakeRes();
      await (httpd as any).writeResponse(res, 201, {}, "hello gzip", "gzip");
      expect(log[0]).to.deep.equal(["status", "201"]);
      expect(log).to.deep.include(["header", "Content-Encoding", "gzip"]);
      const end = log.find((l) => l[0] === "end");
      expect(zlib.gunzipSync(end[1]).toString()).to.equal("hello gzip");
      expect(res.writable).to.equal(false);
    });

    it("writeResponse with empty content writes a status only and stays writable", async () => {
      const { res, log } = fakeRes();
      await (httpd as any).writeResponse(res, 404, {}, "");
      expect(log.find((l) => l[0] === "end")).to.equal(undefined);
      expect(res.writable).to.equal(true);
      expect(log[0]).to.deep.equal(["status", "404"]);
    });

    it("writeResponse honours a supplied Content-Type and skips the default", async () => {
      const { res, log } = fakeRes();
      await (httpd as any).writeResponse(res, 200, { "Content-Type": "text/x" }, "abc");
      const cts = log.filter((l) => l[0] === "header" && l[1] === "Content-Type");
      expect(cts).to.deep.equal([["header", "Content-Type", "text/x"]]);
    });

    it("readBuffer rejects if the request was aborted", async () => {
      let cb: any;
      const res: any = { aborted: true, onData: (f: any) => { cb = f; } };
      const p = (httpd as any).readBuffer(res);
      cb(new ArrayBuffer(2), true);
      let err: any;
      try { await p; } catch (e) { err = e; }
      expect(err.message).to.equal("Request aborted");
    });

    it("readBuffer concatenates chunks, ignoring empty ones", async () => {
      let cb: any;
      const res: any = { onData: (f: any) => { cb = f; } };
      const p = (httpd as any).readBuffer(res);
      cb(new Uint8Array([1, 2]).buffer, false);
      cb(new ArrayBuffer(0), false);
      cb(new Uint8Array([3]).buffer, true);
      expect([...(await p)]).to.deep.equal([1, 2, 3]);
    });

    it("ipv46 strips only the ::ffff: prefix", () => {
      expect((httpd as any).ipv46("::ffff:10.0.0.1")).to.equal("10.0.0.1");
      expect((httpd as any).ipv46("::1")).to.equal("::1");
      expect((httpd as any).ipv46("1.2.3.4")).to.equal("1.2.3.4");
    });

    it("pathAstriskCount weights * as 1 and ** as 2", () => {
      const c = (p: string[]) => (httpd as any).pathAstriskCount(p);
      expect(c(["a", "b"])).to.equal(0);
      expect(c(["*", "a", "*"])).to.equal(2);
      expect(c(["a", "**"])).to.equal(2);
      expect(c(["*", "**"])).to.equal(3);
    });
  });
});

describe("ActiveHttpd listen/shutdown", () => {
  it("listen(port, log, host) binds only the given interface", async () => {
    const h = new ActiveHttpd();
    h.use("/x", "GET", async () => ({ ok: true }));
    h.listen(0, false, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 200));
    const port = us_socket_local_port((h as any).listenSocket);
    const r = await request(port, "GET", "/x");
    expect(JSON.parse(r.body)).to.deep.equal({ ok: true });
    h.shutdown(false);
  });

  describe("shutdown", () => {
    const realST = global.setTimeout;
    const realExit = process.exit;
    afterEach(() => { global.setTimeout = realST; process.exit = realExit; });

    const setup = () => {
      const h: any = new ActiveHttpd();
      let closedSock = 0, closedApp = 0;
      h.listenSocket = null;
      h.server = { close: () => { closedApp++; } };
      return { h, closed: () => [closedSock, closedApp] };
    };

    it("is a no-op without a listen socket", () => {
      const timers: any[] = [];
      (global as any).setTimeout = (...a: any[]) => { timers.push(a); return {}; };
      const { h } = setup();
      h.shutdown();
      expect(timers).to.have.length(0);
    });

    it("closes the socket, nulls it, and after 1300ms closes the app and exits", async () => {
      const h2 = new ActiveHttpd();
      h2.listen(0);
      await new Promise((r) => realST(r, 200));
      const h: any = h2;
      let closedApp = 0, exits: any[] = [];
      h.server = { close: () => { closedApp++; } };
      const timers: Array<{ fn: () => void; ms: number }> = [];
      (global as any).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return {}; };
      (process as any).exit = (c: number) => { exits.push(c); };
      h.shutdown();
      expect(h.listenSocket).to.equal(null);
      expect(timers).to.have.length(1);
      expect(timers[0].ms).to.equal(1300);
      expect(closedApp).to.equal(0);
      timers[0].fn();
      expect(closedApp).to.equal(1);
      expect(exits).to.deep.equal([0]);
    });

    it("exitProcess=false never exits and unrefs the timer", async () => {
      const h: any = new ActiveHttpd();
      h.listen(0);
      await new Promise((r) => realST(r, 200));
      let closedApp = 0, exits = 0, unrefs = 0;
      h.server = { close: () => { closedApp++; } };
      const timers: Array<() => void> = [];
      (global as any).setTimeout = (fn: () => void) => { timers.push(fn); return { unref: () => { unrefs++; } }; };
      (process as any).exit = () => { exits++; };
      h.shutdown(false);
      expect(unrefs).to.equal(1);
      timers[0]();
      expect(closedApp).to.equal(1);
      expect(exits).to.equal(0);
      // second call is a no-op (socket already closed)
      h.shutdown(false);
      expect(timers).to.have.length(1);
    });
  });
});
