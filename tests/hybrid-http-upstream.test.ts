import { expect } from "chai";
import "mocha";
import * as http from "http";
import { AddressInfo } from "net";
import { ActiveCrypto } from "../packages/crypto/src";
import { HybridApi, HybridDb, RegisteredHybrid } from "../packages/network/src/network/hybridApi";
import {
  HttpUpstream,
  SseParser,
  UpstreamError,
  identityFrom,
} from "../packages/hybrid/src/http-upstream";

// An in-memory store with the allDocs range rules of LevelMe (as in hybrid-api.test.ts)
class MemDb implements HybridDb {
  docs = new Map<string, any>();
  put(doc: any) {
    this.docs.set(doc._id, doc);
    return this;
  }
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? { ...d } : { notFound: true };
  }
  async allDocs(o: any) {
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()]
      .sort()
      .filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    const rows = keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k, ...(o.include_docs ? { doc: this.docs.get(k) } : {}) }));
    return { rows };
  }
}

const generated = new ActiveCrypto.KeyPair("rsa").generate();
const identity = identityFrom({ prv: { pkcs8pem: generated.prv.pkcs8pem }, pub: { pkcs8pem: generated.pub.pkcs8pem } });
const stranger = (() => {
  const g = new ActiveCrypto.KeyPair("rsa").generate();
  return identityFrom({ prv: { pkcs8pem: g.prv.pkcs8pem }, pub: { pkcs8pem: g.pub.pkcs8pem } });
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const seed = (events: MemDb, db: MemDb, list: [number, string][] = [[1000, "u1"], [3000, "u3"]]) => {
  for (const [ms, umid] of list) {
    events.put({ _id: `umid:${ms},${umid}` });
    events.put({ _id: `attest:${umid}`, node: "n1", umid, outcome: "committed", revsOut: { s: { rev: "1-a", sha256: "h" } }, umidDocHash: "d", sig: "sg", nodes: { n1: { vote: true, sig: "v" } } });
    db.put({ _id: `${umid}:umid`, umid: { $revs: { $i: {}, $o: { s: "1-a" } } }, streams: { new: [], updated: [] } });
  }
};

interface ServerOpts {
  registered?: boolean;
  retired?: boolean;
  banned?: boolean;
  heartbeatMs?: number;
  /** Replace the handling of a path entirely */
  override?: (path: string, req: http.IncomingMessage, res: http.ServerResponse) => boolean;
}

/**
 * The supernode side of the HTTP contract, over the real HybridApi
 */
const startServer = async (opts: ServerOpts = {}) => {
  const db = new MemDb();
  const events = new MemDb();
  const registered: RegisteredHybrid | undefined =
    opts.registered === false ? undefined : { key: identity.publicPem, type: "rsa", endpoints: [], label: "me", retired: opts.retired };
  const api = new HybridApi({
    db,
    events,
    registry: {
      lookup: async (h) => (h === identity.keyHash ? registered : undefined),
      list: async () => (registered ? [{ ...registered, keyHash: identity.keyHash }] : []),
    },
    ledgerConfig: () => ({ required: ["req1"], window: { days: 30 }, minVersion: "5.1.0" }),
    setupStreamId: () => "setup",
    banned: () => new Set(opts.banned ? [identity.keyHash] : []),
  });
  const seen: { method: string; path: string; headers: http.IncomingHttpHeaders; body?: string }[] = [];
  const open = new Set<http.ServerResponse>();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url as string, "http://x");
    const body = req.method === "POST" ? await readBody(req) : undefined;
    seen.push({ method: req.method as string, path: url.pathname + url.search, headers: req.headers, body });
    if (opts.override?.(url.pathname, req, res)) return;

    const auth = await api.authenticate({
      key: req.headers["x-hybrid-key"] as string,
      timestamp: req.headers["x-hybrid-timestamp"] as string,
      signature: req.headers["x-hybrid-signature"] as string,
    });
    if (!auth.ok) return json(res, auth.status, { reason: auth.reason });

    const p = url.pathname;
    if (req.method === "GET" && p === "/h/bootstrap") return json(res, 200, await api.bootstrap());
    if (req.method === "GET" && p === "/h/head") return json(res, 200, { cursor: await api.head(), time: Date.now() });
    if (req.method === "POST" && p === "/h/streams") return json(res, 200, await api.streams(JSON.parse(body as string)));
    if (req.method === "GET" && p.startsWith("/h/umid/")) {
      const d = await api.umid(decodeURIComponent(p.slice(8)));
      return d ? json(res, 200, d) : json(res, 404, { reason: "not found" });
    }
    if (req.method === "GET" && p.startsWith("/h/attest/")) {
      const d = await api.attest(decodeURIComponent(p.slice(10)));
      return d ? json(res, 200, d) : json(res, 404, { reason: "not found" });
    }
    if (req.method === "GET" && p === "/h/peers") return json(res, 200, await api.peers());
    if (req.method === "POST" && p === "/") return json(res, 200, { $umid: "x", echo: JSON.parse(body as string) });
    if (req.method === "GET" && p === "/h/feed") {
      let cursor = (req.headers["last-event-id"] as string) || url.searchParams.get("from") || "";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      open.add(res);
      let closed = false;
      res.on("close", () => {
        closed = true;
        open.delete(res);
      });
      const heartbeat = async () => {
        if (!closed) res.write(`event: heartbeat\ndata: ${JSON.stringify({ head: await api.head(), time: Date.now() })}\n\n`);
      };
      await heartbeat();
      const timer = setInterval(heartbeat, opts.heartbeatMs ?? 10000);
      res.on("close", () => clearInterval(timer));
      while (!closed) {
        for (const { cursor: c, item } of await api.feedSince(cursor)) {
          if (closed) break;
          res.write(`id: ${c}\ndata: ${JSON.stringify(item)}\n\n`);
          cursor = c;
        }
        await sleep(10);
      }
      return;
    }
    json(res, 404, { reason: "no route" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    api,
    db,
    events,
    seen,
    open,
    port,
    upstream: (over: any = {}) => new HttpUpstream({ host: "127.0.0.1", port, identity, ...over }),
    close: async () => {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
};

type Srv = Awaited<ReturnType<typeof startServer>>;

const expectReject = async (p: Promise<unknown>): Promise<any> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("SseParser", () => {
  const all = (chunks: string[]) => {
    const p = new SseParser();
    const out = chunks.flatMap((c) => p.push(c));
    return [...out, ...p.end()];
  };
  const stream = 'id: umid:1,a\ndata: {"x":1}\n\nevent: heartbeat\ndata: {"head":"h","time":1}\n\n';
  const expected = [
    { event: "message", data: '{"x":1}', id: "umid:1,a" },
    { event: "heartbeat", data: '{"head":"h","time":1}' },
  ];

  it("parses whole and character-by-character input the same", () => {
    expect(all([stream])).to.deep.equal(expected);
    expect(all(stream.split(""))).to.deep.equal(expected);
  });

  it("handles CRLF, including a CR and LF split across chunks, and bare CR", () => {
    const crlf = stream.replace(/\n/g, "\r\n");
    expect(all([crlf])).to.deep.equal(expected);
    expect(all(crlf.split(""))).to.deep.equal(expected);
    expect(all([stream.replace(/\n/g, "\r")])).to.deep.equal(expected);
    // A CR that is the last thing in the stream still ends its line
    expect(all(["data: a\r\r"])).to.deep.equal([{ event: "message", data: "a" }]);
  });

  it("joins multi-line data, skips comments, and strips only one space", () => {
    expect(all([": comment\ndata:  two\ndata:line\ndata\n\n"])).to.deep.equal([{ event: "message", data: " two\nline\n" }]);
  });

  it("strips a leading BOM once", () => {
    expect(all(["﻿data: x\n\n"])).to.deep.equal([{ event: "message", data: "x" }]);
  });

  it("does not dispatch an event without data, nor one left incomplete", () => {
    expect(all(["event: heartbeat\n\nid: 5\n\n", "data: tail"])).to.deep.equal([]);
  });

  it("keeps the id with its own event only", () => {
    expect(all(["id: 1\ndata: a\n\ndata: b\n\n"])).to.deep.equal([
      { event: "message", data: "a", id: "1" },
      { event: "message", data: "b" },
    ]);
  });

  it("refuses a runaway line", () => {
    const p = new SseParser(10);
    expect(() => p.push("data: 12345678901234567890")).to.throw(UpstreamError, /too long/);
  });
});

describe("HttpUpstream", function () {
  this.timeout(10000);
  let srv: Srv;
  afterEach(async () => {
    await srv?.close();
  });

  describe("auth", () => {
    it("signs every request with the hybrid's key", async () => {
      srv = await startServer();
      const up = srv.upstream();
      await up.head();
      await up.peers();
      await up.submit({ $tx: {} });
      expect(srv.seen).to.have.length(3);
      for (const s of srv.seen) {
        expect(s.headers["x-hybrid-key"]).to.equal(identity.keyHash);
        const ts = Number(s.headers["x-hybrid-timestamp"]);
        expect(Math.abs(Date.now() - ts)).to.be.below(5000);
        expect(
          ActiveCrypto.verifyRequest(identity.publicPem, "rsa", { key: identity.keyHash, timestamp: ts, signature: s.headers["x-hybrid-signature"] as string }, 60)
        ).to.equal(true);
      }
    });

    it("maps not registered, banned and retired to a refused 403", async () => {
      for (const opts of [{ registered: false }, { banned: true }, { retired: true }]) {
        srv = await startServer(opts);
        const e = await expectReject(srv.upstream().bootstrap());
        expect(e).to.be.instanceOf(UpstreamError);
        expect(e).to.include({ kind: "refused", status: 403, refused: true });
        await srv.close();
      }
      srv = undefined as any;
    });

    it("maps a refused signature to a refused 401", async () => {
      srv = await startServer();
      // Claims the registered key hash but signs with another key
      const forged = { ...stranger, keyHash: identity.keyHash };
      const e = await expectReject(srv.upstream({ identity: forged }).head());
      expect(e).to.include({ kind: "refused", status: 401 });
      expect(e.message).to.match(/bad signature or timestamp/);
    });

    it("tells a network failure apart from a refusal", async () => {
      srv = await startServer();
      const port = srv.port;
      await srv.close();
      srv = undefined as any;
      const e = await expectReject(new HttpUpstream({ host: "127.0.0.1", port, identity }).head());
      expect(e).to.be.instanceOf(UpstreamError);
      expect(e.kind).to.equal("network");
      expect(e.refused).to.equal(false);
      expect(e.status).to.equal(undefined);
    });
  });

  describe("unary calls", () => {
    it("bootstraps", async () => {
      srv = await startServer();
      srv.db.put({ _id: "setup", neighbourhood: [] });
      srv.db.put({ _id: "c1", namespace: "ns", contract: {}, compiled: {} });
      seed(srv.events, srv.db);
      const b = await srv.upstream().bootstrap();
      expect(b.setup._id).to.equal("setup");
      expect(b.required).to.deep.equal(["req1"]);
      expect(b.window).to.deep.equal({ days: 30 });
      expect(b.minVersion).to.equal("5.1.0");
      expect(b.contracts).to.deep.equal(["c1"]);
      expect(b.cursor).to.equal("umid:3000,u3");
    });

    it("reads the head", async () => {
      srv = await startServer();
      seed(srv.events, srv.db);
      const h = await srv.upstream().head();
      expect(h.cursor).to.equal("umid:3000,u3");
      expect(h.time).to.be.a("number");
    });

    it("fetches streams and reports missing ones", async () => {
      srv = await startServer();
      srv.db.put({ _id: "a", _rev: "2-x" }).put({ _id: "a:stream", _rev: "1-y" });
      const r = await srv.upstream().streams([{ id: "a", rev: "2-x" }, { id: "b" }]);
      expect(r.docs.map((d) => d._id)).to.deep.equal(["a", "a:stream"]);
      expect(r.missing).to.deep.equal([{ id: "b" }]);
      expect(JSON.parse(srv.seen[0].body as string)).to.deep.equal([{ id: "a", rev: "2-x" }, { id: "b" }]);
      expect(srv.seen[0].headers["content-type"]).to.equal("application/json");
    });

    it("returns undefined for a 404 umid or attestation", async () => {
      srv = await startServer();
      seed(srv.events, srv.db);
      const up = srv.upstream();
      expect((await up.umid("u1"))._id).to.equal("u1:umid");
      expect(await up.umid("nope")).to.equal(undefined);
      expect(await up.attest("u1")).to.deep.include({ node: "n1", umid: "u1", sig: "sg" });
      expect(await up.attest("nope")).to.equal(undefined);
      expect(srv.seen.map((s) => s.path)).to.include("/h/umid/nope");
    });

    it("encodes a umid into the path", async () => {
      srv = await startServer();
      await srv.upstream().umid("a/b c");
      expect(srv.seen[0].path).to.equal("/h/umid/a%2Fb%20c");
    });

    it("lists peers and submits a transaction", async () => {
      srv = await startServer();
      const up = srv.upstream();
      expect((await up.peers())[0]).to.include({ keyHash: identity.keyHash, label: "me" });
      expect(await up.submit({ $tx: { a: 1 } })).to.deep.equal({ $umid: "x", echo: { $tx: { a: 1 } } });
      expect(srv.seen[1]).to.include({ method: "POST", path: "/" });
    });
  });

  describe("errors", () => {
    it("maps other statuses to http with the status and body", async () => {
      srv = await startServer({
        override: (p, _req, res) => {
          if (p !== "/h/head") return false;
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return true;
        },
      });
      const e = await expectReject(srv.upstream().head());
      expect(e).to.include({ kind: "http", status: 500, refused: false });
      expect(e.body).to.deep.equal({ error: "boom" });
      expect(e.message).to.match(/500 boom/);
    });

    it("maps a 404 on a non-optional route to http", async () => {
      srv = await startServer({
        override: (p, _req, res) => (p === "/h/peers" ? (res.writeHead(404), res.end(), true) : false),
      });
      expect(await expectReject(srv.upstream().peers())).to.include({ kind: "http", status: 404 });
    });

    it("maps non-JSON and malformed bodies to protocol", async () => {
      srv = await startServer({
        override: (p, _req, res) => {
          if (p === "/h/head") return res.end("not json"), true;
          if (p === "/h/bootstrap") return res.end("{}"), true;
          if (p === "/h/peers") return res.end("{}"), true;
          return false;
        },
      });
      const up = srv.upstream();
      expect(await expectReject(up.head())).to.include({ kind: "protocol" });
      expect(await expectReject(up.bootstrap())).to.include({ kind: "protocol" });
      expect(await expectReject(up.peers())).to.include({ kind: "protocol" });
    });

    it("times out a request that never answers", async () => {
      srv = await startServer({ override: (p) => p === "/h/head" });
      const t = Date.now();
      const e = await expectReject(srv.upstream({ timeoutMs: 150 }).head());
      expect(e).to.include({ kind: "timeout" });
      expect(Date.now() - t).to.be.below(2000);
    });
  });

  describe("feed", () => {
    const collect = (srv: Srv, cursor: string, n: number, over: any = {}) => {
      const ctl = new AbortController();
      const got: { cursor: string; umid: string; outcome: string }[] = [];
      const beats: string[] = [];
      const done = srv.upstream(over).feed(
        cursor,
        async (c, item) => {
          got.push({ cursor: c, umid: item.umid, outcome: item.outcome });
          if (got.length >= n) ctl.abort();
        },
        ctl.signal,
        (head) => beats.push(head)
      );
      return { ctl, got, beats, done };
    };

    it("delivers committed and failed items in cursor order", async () => {
      srv = await startServer();
      seed(srv.events, srv.db);
      srv.events.put({ _id: "fail:2000,u2" }).put({ _id: "failed:u2", tx: { $tx: 1 }, $revs: { $i: {}, $o: {} }, nodes: { n1: { vote: true } } });
      const f = collect(srv, "", 3);
      await f.done;
      expect(f.got).to.deep.equal([
        { cursor: "umid:1000,u1", umid: "u1", outcome: "committed" },
        { cursor: "fail:2000,u2", umid: "u2", outcome: "failed" },
        { cursor: "umid:3000,u3", umid: "u3", outcome: "committed" },
      ]);
      expect(srv.seen[0].path).to.equal("/h/feed?from=");
      expect(srv.seen[0].headers["last-event-id"]).to.equal(undefined);
      expect(srv.seen[0].headers.accept).to.equal("text/event-stream");
    });

    it("delivers items committed while connected", async () => {
      srv = await startServer();
      seed(srv.events, srv.db, [[1000, "u1"]]);
      const f = collect(srv, "", 2);
      await sleep(100);
      expect(f.got.map((g) => g.umid)).to.deep.equal(["u1"]);
      seed(srv.events, srv.db, [[5000, "u5"]]);
      await f.done;
      expect(f.got.map((g) => g.umid)).to.deep.equal(["u1", "u5"]);
    });

    it("resumes after a cursor, sending it as from and Last-Event-ID", async () => {
      srv = await startServer();
      seed(srv.events, srv.db);
      const f = collect(srv, "umid:1000,u1", 1);
      await f.done;
      expect(f.got.map((g) => g.umid)).to.deep.equal(["u3"]);
      expect(srv.seen[0].path).to.equal("/h/feed?from=umid%3A1000%2Cu1");
      expect(srv.seen[0].headers["last-event-id"]).to.equal("umid:1000,u1");
    });

    it("reports heartbeats on connect and on the interval", async () => {
      srv = await startServer({ heartbeatMs: 40 });
      seed(srv.events, srv.db);
      const ctl = new AbortController();
      const beats: [string, number][] = [];
      const done = srv.upstream().feed("umid:3000,u3", async () => undefined, ctl.signal, (h, t) => beats.push([h, t]));
      await sleep(200);
      ctl.abort();
      await done;
      expect(beats.length).to.be.at.least(3);
      expect(beats[0][0]).to.equal("umid:3000,u3");
      expect(beats[0][1]).to.be.a("number");
    });

    it("awaits each item before the next (backpressure)", async () => {
      srv = await startServer();
      seed(srv.events, srv.db, [[1000, "a"], [2000, "b"], [3000, "c"], [4000, "d"]]);
      const ctl = new AbortController();
      let active = 0;
      let max = 0;
      const order: string[] = [];
      await srv.upstream().feed(
        "",
        async (_c, item) => {
          active++;
          max = Math.max(max, active);
          await sleep(30);
          order.push(item.umid);
          active--;
          if (order.length === 4) ctl.abort();
        },
        ctl.signal
      );
      expect(max).to.equal(1);
      expect(order).to.deep.equal(["a", "b", "c", "d"]);
    });

    it("resolves on abort while idle, and at once when already aborted", async () => {
      srv = await startServer();
      const ctl = new AbortController();
      const done = srv.upstream().feed("", async () => undefined, ctl.signal);
      await sleep(50);
      ctl.abort();
      await done;
      const pre = new AbortController();
      pre.abort();
      await srv.upstream().feed("", async () => undefined, pre.signal);
      expect(srv.seen.filter((s) => s.path.startsWith("/h/feed"))).to.have.length(1);
    });

    it("stops delivering once aborted inside a callback", async () => {
      srv = await startServer();
      seed(srv.events, srv.db, [[1000, "a"], [2000, "b"], [3000, "c"]]);
      const f = collect(srv, "", 1);
      await f.done;
      expect(f.got.map((g) => g.umid)).to.deep.equal(["a"]);
    });

    it("rejects with the callback's error and closes the connection", async () => {
      srv = await startServer();
      seed(srv.events, srv.db);
      const ctl = new AbortController();
      const e = await expectReject(
        srv.upstream().feed("", async () => {
          throw new Error("store full");
        }, ctl.signal)
      );
      expect(e.message).to.equal("store full");
      await sleep(50);
      expect(srv.open.size).to.equal(0);
    });

    it("refuses a feed for an unregistered key", async () => {
      srv = await startServer({ registered: false });
      const e = await expectReject(srv.upstream().feed("", async () => undefined, new AbortController().signal));
      expect(e).to.include({ kind: "refused", status: 403 });
    });

    it("treats a silent feed as dead", async () => {
      srv = await startServer({
        override: (p, _req, res) => (p === "/h/feed" ? (res.writeHead(200, { "content-type": "text/event-stream" }), res.flushHeaders(), true) : false),
      });
      const e = await expectReject(srv.upstream({ idleTimeoutMs: 150 }).feed("", async () => undefined, new AbortController().signal));
      expect(e).to.include({ kind: "timeout" });
    });

    it("does not count processing time as silence", async () => {
      srv = await startServer({ heartbeatMs: 60000 });
      seed(srv.events, srv.db, [[1000, "a"], [2000, "b"]]);
      const ctl = new AbortController();
      const got: string[] = [];
      await srv.upstream({ idleTimeoutMs: 150 }).feed("", async (_c, item) => {
        await sleep(250);
        got.push(item.umid);
        if (got.length === 2) ctl.abort();
      }, ctl.signal);
      expect(got).to.deep.equal(["a", "b"]);
    });

    it("parses an awkwardly chunked CRLF stream over the wire, and resolves when it ends", async () => {
      const wire =
        ": hello\r\nevent: heartbeat\r\ndata: {\"head\":\"umid:2,b\",\"time\":7}\r\n\r\n" +
        'id: umid:1,a\r\ndata: {"umid":"a",\r\ndata: "outcome":"failed","$revs":{},"nodes":{}}\r\n\r\n' +
        'event: future\r\ndata: x\r\n\r\nid: umid:2,b\ndata: {"umid":"b","outcome":"committed","$revs":{},"nodes":{}}\n\n';
      srv = await startServer({
        override: (p, _req, res) => {
          if (p !== "/h/feed") return false;
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          (async () => {
            const bytes = Buffer.from(wire);
            for (let i = 0; i < bytes.length; i += 7) {
              res.write(bytes.subarray(i, i + 7));
              await sleep(1);
            }
            res.end();
          })();
          return true;
        },
      });
      const got: [string, any][] = [];
      const beats: [string, number][] = [];
      await srv.upstream().feed("", async (c, item) => void got.push([c, item]), new AbortController().signal, (h, t) => beats.push([h, t]));
      expect(beats).to.deep.equal([["umid:2,b", 7]]);
      expect(got.map(([c, i]) => [c, i.umid, i.outcome])).to.deep.equal([
        ["umid:1,a", "a", "failed"],
        ["umid:2,b", "b", "committed"],
      ]);
    });

    it("refuses an item without an id, bad JSON, or a non-SSE response", async () => {
      const bodies: { [k: string]: [string, string] } = {
        noid: ["text/event-stream", "data: {}\n\n"],
        badjson: ["text/event-stream", "id: 1\ndata: {nope\n\n"],
        badbeat: ["text/event-stream", "event: heartbeat\ndata: {}\n\n"],
        notsse: ["application/json", "[]"],
      };
      let which = "";
      srv = await startServer({
        override: (p, _req, res) => {
          if (p !== "/h/feed") return false;
          res.writeHead(200, { "content-type": bodies[which][0] });
          res.write(bodies[which][1]);
          return true;
        },
      });
      for (const [k, re] of [["noid", /without a cursor/], ["badjson", /not JSON/], ["badbeat", /malformed heartbeat/], ["notsse", /not an event stream/]] as const) {
        which = k;
        const e = await expectReject(srv.upstream().feed("", async () => undefined, new AbortController().signal));
        expect(e, k).to.include({ kind: "protocol" });
        expect(e.message).to.match(re);
      }
    });
  });

  it("names itself by endpoint, bracketing IPv6", () => {
    expect(new HttpUpstream({ host: "::1", port: 5260, identity }).id).to.equal("[::1]:5260:http");
    expect(new HttpUpstream({ host: "h", port: 1, identity }).id).to.equal("h:1:http");
  });

  it("reads the identity type from the file, rsa by default", () => {
    expect(identity.type).to.equal("rsa");
    expect(identity.keyHash).to.equal(ActiveCrypto.keyHash(generated.pub.pkcs8pem));
    expect(() => identityFrom({ prv: {} })).to.throw(/identity/);
  });
});
