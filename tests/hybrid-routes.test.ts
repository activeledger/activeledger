import { expect } from "chai";
import "mocha";
import * as http from "http";
import { App, TemplatedApp, us_listen_socket, us_listen_socket_close, us_socket_local_port } from "uWebSockets.js";
import { ActiveCrypto } from "../packages/crypto/src";
import { HybridApi, HybridDb } from "../packages/network/src/network/hybridApi";
import { FeedClient, registerHybridRoutes } from "../packages/network/src/network/hybridRoutes";

// The `/h/*` routes on a real uWebSockets app, over real HTTP. FeedSession and
// HybridApi have their own tests; these cover what the routes add: auth on
// every route, request validation, the feed's slot accounting and its
// failure paths.

class MemDb implements HybridDb {
  docs = new Map<string, any>();
  failAllDocs = false;
  put(doc: any) {
    this.docs.set(doc._id, doc);
    return this;
  }
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? { ...d } : { notFound: true };
  }
  async allDocs(o: any) {
    if (this.failAllDocs) throw new Error("db down");
    const end = o.endkey ? o.endkey.slice(0, -1) + "香" : undefined;
    const keys = [...this.docs.keys()]
      .sort()
      .filter((k) => (o.startkey === undefined || k >= o.startkey) && (end === undefined || k < end));
    return { rows: keys.slice(0, o.limit ?? keys.length).map((k) => ({ _id: k, id: k, ...(o.include_docs ? { doc: this.docs.get(k) } : {}) })) };
  }
}

const kp = new ActiveCrypto.KeyPair("rsa");
const pem = kp.generate().pub.pkcs8pem;
const keyHash = ActiveCrypto.keyHash(pem);
const otherKp = new ActiveCrypto.KeyPair("rsa");
const otherPem = otherKp.generate().pub.pkcs8pem;
const otherHash = ActiveCrypto.keyHash(otherPem);

let clock = Date.now();
const sign = (pair = kp, hash = keyHash) => {
  // Every request needs its own timestamp: a repeat is refused as a replay
  const r = ActiveCrypto.signRequest(pair, hash, ++clock);
  return { "x-hybrid-key": r.key, "x-hybrid-timestamp": String(r.timestamp), "x-hybrid-signature": r.signature };
};

interface Reply {
  status: number;
  body: string;
  json: () => any;
}

const collect = (res: http.IncomingMessage, resolve: (r: Reply) => void) => {
  let text = "";
  res.on("data", (c) => (text += c));
  res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, json: () => JSON.parse(text) }));
};

describe("Hybrid routes (/h/*)", () => {
  let app: TemplatedApp;
  let listen: us_listen_socket;
  let port: number;
  let db: MemDb;
  let events: MemDb;
  let state: { retired: boolean; banned: boolean; lookupDelayMs: number };
  let maxFeeds: number;
  let feeds: Set<FeedClient>;
  let feedChanges: number[];
  let open: http.ClientRequest[];

  const seedItem = (n: number) => {
    events.put({ _id: `umid:${1000 + n},u${n}` });
    events.put({ _id: `attest:u${n}`, node: "n1", outcome: "committed", revsOut: {}, umidDocHash: "h", sig: "s", nodes: { n1: { vote: true } } });
    db.put({ _id: `u${n}:umid`, umid: { $revs: {} }, streams: {} });
  };

  const request = (method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => collect(res, resolve));
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

  /** Open a feed and collect what it sends. */
  const openFeed = (headers: Record<string, string>, query = "") => {
    const chunks: string[] = [];
    let status = 0;
    let ended = false;
    const req = http.get({ host: "127.0.0.1", port, path: `/h/feed${query}`, headers, agent: false }, (res) => {
      status = res.statusCode ?? 0;
      res.setEncoding("utf8");
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => (ended = true));
      res.on("close", () => (ended = true));
    });
    req.on("error", () => {});
    open.push(req);
    return {
      req,
      until: (test: () => boolean, ms = 4000) => waitFor(test, ms, () => JSON.stringify(chunks.join(""))),
      text: () => chunks.join(""),
      status: () => status,
      ended: () => ended,
    };
  };

  const waitFor = async (test: () => boolean, ms = 4000, describeState: () => string = () => "") => {
    const deadline = Date.now() + ms;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`timed out ${describeState()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeEach(async () => {
    db = new MemDb();
    events = new MemDb();
    state = { retired: false, banned: false, lookupDelayMs: 0 };
    maxFeeds = 5;
    feedChanges = [];
    open = [];
    const api = new HybridApi({
      db,
      events,
      registry: {
        lookup: async (h) => {
          if (state.lookupDelayMs) await new Promise((r) => setTimeout(r, state.lookupDelayMs));
          return h === keyHash
            ? { key: pem, type: "rsa", endpoints: [], retired: state.retired }
            : h === otherHash
            ? { key: otherPem, type: "rsa", endpoints: [] }
            : undefined;
        },
        list: async () => [{ key: pem, type: "rsa", endpoints: [], keyHash, label: "mine" }],
      },
      ledgerConfig: () => ({ required: [], window: { days: 30 }, minVersion: "5.1.0" }),
      setupStreamId: () => "setup",
      banned: () => (state.banned ? new Set([keyHash]) : new Set()),
    });
    app = App();
    feeds = registerHybridRoutes(app, api, {
      maxFeeds: () => maxFeeds,
      maxBodyBytes: 64,
      onFeeds: (f) => feedChanges.push(f.size),
    });
    await new Promise<void>((resolve, reject) =>
      app.listen("127.0.0.1", 0, (token) => {
        if (!token) return reject(new Error("could not listen"));
        listen = token;
        port = us_socket_local_port(token);
        resolve();
      })
    );
  });

  afterEach(async () => {
    open.forEach((r) => r.destroy());
    await waitFor(() => feeds.size === 0);
    us_listen_socket_close(listen);
  });

  describe("authentication", () => {
    const routes: [string, string][] = [
      ["GET", "/h/bootstrap"],
      ["GET", "/h/head"],
      ["GET", "/h/peers"],
      ["GET", "/h/umid/u1"],
      ["GET", "/h/attest/u1"],
      ["POST", "/h/streams"],
      ["GET", "/h/feed"],
    ];

    for (const [method, path] of routes) {
      it(`${method} ${path} refuses a request with no auth headers`, async () => {
        const r = await request(method, path, {}, method === "POST" ? "[]" : undefined);
        expect(r.status).to.equal(401);
        expect(r.json().error).to.match(/missing auth headers/);
      });

      it(`${method} ${path} refuses an unregistered key`, async () => {
        const r = await request(method, path, sign(kp, "f".repeat(64)), method === "POST" ? "[]" : undefined);
        expect(r.status).to.equal(403);
        expect(r.json().error).to.match(/not registered/);
      });
    }

    it("refuses a registered key whose signature was made by another key", async () => {
      const r = await request("GET", "/h/head", sign(otherKp, keyHash));
      expect(r.status).to.equal(401);
      expect(r.json().error).to.match(/bad signature/);
    });

    it("refuses a retired key", async () => {
      state.retired = true;
      const r = await request("GET", "/h/head", sign());
      expect(r.status).to.equal(403);
      expect(r.json().error).to.match(/retired/);
    });

    it("refuses a banned key", async () => {
      state.banned = true;
      const r = await request("GET", "/h/head", sign());
      expect(r.status).to.equal(403);
      expect(r.json().error).to.match(/banned/);
    });

    it("refuses a replayed signature", async () => {
      const headers = sign();
      expect((await request("GET", "/h/head", headers)).status).to.equal(200);
      const again = await request("GET", "/h/head", headers);
      expect(again.status).to.equal(401);
      expect(again.json().error).to.match(/replayed/);
    });

    it("answers 500, not a hang, when authentication itself fails", async () => {
      const api = new HybridApi({
        db,
        events,
        registry: {
          lookup: async () => {
            throw new Error("registry down");
          },
          list: async () => [],
        },
        ledgerConfig: () => ({}),
        setupStreamId: () => "setup",
        banned: () => new Set(),
      });
      const local = App();
      registerHybridRoutes(local, api, { maxFeeds: () => 1 });
      const token: us_listen_socket = await new Promise((res) => local.listen("127.0.0.1", 0, res));
      try {
        const r: Reply = await new Promise((resolve, reject) => {
          http
            .get({ host: "127.0.0.1", port: us_socket_local_port(token), path: "/h/head", headers: sign(), agent: false }, (res) => collect(res, resolve))
            .on("error", reject);
        });
        expect(r.status).to.equal(500);
        expect(r.json()).to.deep.equal({ error: "internal error" });
      } finally {
        us_listen_socket_close(token);
      }
    });
  });

  describe("read routes", () => {
    it("GET /h/head returns the newest feed cursor, the time and the on-ledger minVersion", async () => {
      seedItem(1);
      seedItem(2);
      const r = await request("GET", "/h/head", sign());
      expect(r.status).to.equal(200);
      const body = r.json();
      expect(body.cursor).to.equal("umid:1002,u2");
      expect(body.minVersion).to.equal("5.1.0");
      expect(body.time).to.be.a("number");
    });

    it("GET /h/bootstrap returns the ledger rules and the current cursor", async () => {
      seedItem(1);
      db.put({ _id: "setup", setup: true });
      const body = (await request("GET", "/h/bootstrap", sign())).json();
      expect(body.setup._id).to.equal("setup");
      expect(body.window).to.deep.equal({ days: 30 });
      expect(body.cursor).to.equal("umid:1001,u1");
    });

    it("GET /h/peers lists the registered hybrids", async () => {
      const body = (await request("GET", "/h/peers", sign())).json();
      expect(body).to.have.length(1);
      expect(body[0].keyHash).to.equal(keyHash);
      expect(body[0].label).to.equal("mine");
    });

    it("GET /h/umid/:umid serves a stored doc and answers 404 for an unknown one", async () => {
      seedItem(1);
      const hit = await request("GET", "/h/umid/u1", sign());
      expect(hit.status).to.equal(200);
      expect(hit.json()._id).to.equal("u1:umid");
      const miss = await request("GET", "/h/umid/nope", sign());
      expect(miss.status).to.equal(404);
      expect(miss.json()).to.deep.equal({ error: "not found" });
    });

    it("GET /h/umid/:umid will not reach a database-internal document", async () => {
      db.put({ _id: "_design:umid", secret: true });
      const r = await request("GET", "/h/umid/_design", sign());
      expect(r.status).to.equal(404);
    });

    it("GET /h/attest/:umid serves the attestation without the node's own bookkeeping, and 404s when absent", async () => {
      seedItem(1);
      const hit = await request("GET", "/h/attest/u1", sign());
      expect(hit.status).to.equal(200);
      const body = hit.json();
      expect(body.umidDocHash).to.equal("h");
      expect(body).to.not.have.any.keys("_id", "_rev", "nodes");
      expect((await request("GET", "/h/attest/u9", sign())).status).to.equal(404);
    });

    it("answers 500 with no detail when a read fails inside the handler", async () => {
      events.failAllDocs = true;
      const r = await request("GET", "/h/head", sign());
      expect(r.status).to.equal(500);
      expect(r.json()).to.deep.equal({ error: "internal error" });
    });
  });

  describe("POST /h/streams", () => {
    it("returns the requested state and meta, listing what is missing", async () => {
      const id = "a".repeat(30);
      db.put({ _id: id, _rev: "1-x", v: 1 }).put({ _id: `${id}:stream`, _rev: "1-y" });
      const r = await request("POST", "/h/streams", sign(), JSON.stringify([{ id }, { id: "b" }]));
      expect(r.status).to.equal(200);
      const body = r.json();
      expect(body.docs.map((d: any) => d._id)).to.deep.equal([id, `${id}:stream`]);
      expect(body.missing).to.deep.equal([{ id: "b" }]);
    });

    it("does not serve volatile, however the id is spelled", async () => {
      db.put({ _id: "abc:volatile", secret: 1 });
      const r = await request("POST", "/h/streams", sign(), JSON.stringify([{ id: "abc:volatile" }]));
      expect(r.json().docs).to.deep.equal([]);
      expect(r.json().missing).to.have.length(1);
    });

    it("answers 400 to a body that is not JSON", async () => {
      const r = await request("POST", "/h/streams", sign(), "{not json");
      expect(r.status).to.equal(400);
      expect(r.json().error).to.equal("invalid JSON");
    });

    it("answers 400 to JSON that is not a list of {id, rev?}", async () => {
      for (const bad of ['{"id":"x"}', '[{"id":1}]', '[{"id":"x","rev":5}]', "[null]", '"x"']) {
        const r = await request("POST", "/h/streams", sign(), bad);
        expect(r.status, bad).to.equal(400);
        expect(r.json().error).to.equal("expected [{id, rev?}]");
      }
    });

    it("answers 413 to a body over the limit", async () => {
      const r = await request("POST", "/h/streams", sign(), JSON.stringify([{ id: "a".repeat(200) }]));
      expect(r.status).to.equal(413);
      expect(r.json().error).to.equal("request too large");
    });

    it("takes a body of exactly the limit and refuses one a byte over", async () => {
      const body = (n: number) => JSON.stringify([{ id: "a".repeat(n - 11) }]);
      expect(Buffer.byteLength(body(64))).to.equal(64);
      const at = await request("POST", "/h/streams", sign(), body(64));
      expect(at.status).to.equal(200);
      const over = await request("POST", "/h/streams", sign(), body(65));
      expect(over.status).to.equal(413);
    });

    it("authenticates a body sent in several chunks only once it is complete", async () => {
      db.put({ _id: "abc", _rev: "1-x" });
      const body = JSON.stringify([{ id: "abc" }]);
      const r: Reply = await new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/h/streams", method: "POST", headers: sign(), agent: false }, (res) => collect(res, resolve));
        req.on("error", reject);
        req.write(body.slice(0, 5));
        setTimeout(() => req.end(body.slice(5)), 50);
      });
      expect(r.status).to.equal(200);
      expect(r.json().docs[0]._id).to.equal("abc");
    });
  });

  describe("GET /h/feed", () => {
    it("sends an SSE stream: a first heartbeat, then each item with its cursor as id", async () => {
      seedItem(1);
      seedItem(2);
      const feed = openFeed(sign());
      await feed.until(() => feed.text().includes("id: umid:1002,u2"));
      expect(feed.status()).to.equal(200);
      const text = feed.text();
      expect(text.startsWith(": connected\n\n")).to.equal(true);
      expect(text).to.match(/event: heartbeat\ndata: {"head":"umid:1002,u2"/);
      expect(text).to.contain("id: umid:1001,u1\ndata: ");
      expect(text.indexOf("id: umid:1001,u1")).to.be.lessThan(text.indexOf("id: umid:1002,u2"));
      expect(feeds.size).to.equal(1);
      const [client] = [...feeds];
      expect(client.keyHash).to.equal(keyHash);
      await waitFor(() => client.cursor === "umid:1002,u2");
    });

    it("starts after ?from", async () => {
      seedItem(1);
      seedItem(2);
      const feed = openFeed(sign(), "?from=umid:1001,u1");
      await feed.until(() => feed.text().includes("id: umid:1002,u2"));
      expect(feed.text()).to.not.contain("id: umid:1001,u1");
    });

    it("prefers Last-Event-ID over ?from when a client reconnects", async () => {
      seedItem(1);
      seedItem(2);
      seedItem(3);
      const feed = openFeed({ ...sign(), "last-event-id": "umid:1002,u2" }, "?from=");
      await feed.until(() => feed.text().includes("id: umid:1003,u3"));
      expect(feed.text()).to.not.contain("id: umid:1001,u1");
      expect(feed.text()).to.not.contain("id: umid:1002,u2");
    });

    it("delivers an item written after the feed opened", async () => {
      const feed = openFeed(sign());
      await feed.until(() => feed.text().includes("event: heartbeat"));
      seedItem(7);
      await feed.until(() => feed.text().includes("id: umid:1007,u7"));
    });

    it("refuses a feed past maxFeeds with 503, leaving the others running", async () => {
      maxFeeds = 1;
      const first = openFeed(sign());
      await first.until(() => first.text().includes("heartbeat"));
      const second = await request("GET", "/h/feed", sign(otherKp, otherHash));
      expect(second.status).to.equal(503);
      expect(second.json().error).to.equal("feed limit reached");
      expect(feeds.size).to.equal(1);
      expect(first.ended()).to.equal(false);
    });

    it("lets a reconnect replace the same key's old feed, even at the limit", async () => {
      maxFeeds = 1;
      const first = openFeed(sign());
      await first.until(() => first.text().includes("heartbeat"));
      const second = openFeed(sign());
      await second.until(() => second.text().includes("heartbeat"));
      await first.until(() => first.ended());
      expect(second.status()).to.equal(200);
      expect(feeds.size).to.equal(1);
    });

    it("frees the slot when the client disconnects, and reports each change", async () => {
      const feed = openFeed(sign());
      await feed.until(() => feed.text().includes("heartbeat"));
      expect(feeds.size).to.equal(1);
      feed.req.destroy();
      await waitFor(() => feeds.size === 0);
      expect(feedChanges).to.deep.equal([1, 0]);
    });

    it("registers no feed when the client leaves while it is being authenticated", async () => {
      state.lookupDelayMs = 150;
      const feed = openFeed(sign());
      await new Promise((r) => setTimeout(r, 30));
      feed.req.destroy();
      await new Promise((r) => setTimeout(r, 300));
      expect(feeds.size).to.equal(0);
      expect(feedChanges).to.deep.equal([]);
    });

    it("ends the feed with an error event when its database read fails", async () => {
      seedItem(1);
      const feed = openFeed(sign());
      await feed.until(() => feed.text().includes("id: umid:1001,u1"));
      events.failAllDocs = true;
      await feed.until(() => feed.text().includes('event: error\ndata: {"error":"feed failed"}'));
      await feed.until(() => feed.ended());
      await waitFor(() => feeds.size === 0);
    });
  });
});
