import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { HybridServer, HybridServerOptions, MAX_BODY_BYTES } from "../packages/hybrid/src/api";
import { EventLog } from "../packages/hybrid/src/events";
import { Submitter } from "../packages/hybrid/src/submit";
import { docHash } from "../packages/hybrid/src/verify";

const STREAM = "a".repeat(64);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: any;
}

describe("Hybrid API server", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  let server: HybridServer;
  let port: number;
  let state: any;
  let lookups: string[][];
  let lookupDocs: { [id: string]: any[] };
  let submitter: { submit(tx: unknown): Promise<any> };

  const start = async (over: Partial<HybridServerOptions> = {}, config: any = {}) => {
    server = new HybridServer({
      config: { bind: "127.0.0.1", port: 0, maxLagSeconds: null, ...config },
      state,
      store,
      lookup: {
        ensure: async () => ({ missing: [] }),
        refreshToTip: async (ids) => {
          lookups.push(ids);
          const missing: string[] = [];
          for (const id of ids) {
            if (!lookupDocs[id]) missing.push(id);
            else for (const d of lookupDocs[id]) await store.data.post(d);
          }
          return { missing };
        },
      },
      submitter: { submit: (tx) => submitter.submit(tx) },
      heartbeatMs: 50,
      ...over,
    });
    port = (await server.start()).port;
  };

  const request = (
    method: string,
    p: string,
    opts: { headers?: http.OutgoingHttpHeaders; body?: string | Buffer } = {}
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path: p, headers: opts.headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: any;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            resolve({ status: res.statusCode as number, headers: res.headers, text, body });
          });
        }
      );
      req.on("error", reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });

  /** Read SSE messages until `count` arrived (or the timeout) */
  const sse = (p: string, count: number, headers: http.OutgoingHttpHeaders = {}, waitMs = 400) =>
    new Promise<{ status: number; events: { id: string; data: any }[]; raw: string; close: () => void }>(
      (resolve, reject) => {
        const events: { id: string; data: any }[] = [];
        let raw = "";
        const req = http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
          const done = () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode as number, events, raw, close: () => req.destroy() });
          };
          const timer = setTimeout(done, waitMs);
          res.on("data", (c) => {
            raw += c.toString();
            const blocks = raw.split("\n\n");
            events.length = 0;
            for (const b of blocks) {
              const id = /^id:(.*)$/m.exec(b)?.[1];
              const data = /^data:(.*)$/m.exec(b)?.[1];
              if (id !== undefined && data !== undefined) events.push({ id, data: JSON.parse(data) });
            }
            if (events.length >= count) done();
          });
          res.on("end", done);
        });
        req.on("error", reject);
      }
    );

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-server-"));
    store = await openEmbeddedStorage(dir);
    state = {
      version: "5.1.0",
      ready: true,
      minVersion: "5.1.0",
      cursor: "umid:1,abc",
      headConfirmedAt: Date.now(),
      upstreams: [{ host: "sn1:5260:http", ok: true }],
    };
    lookups = [];
    lookupDocs = {};
    submitter = { submit: async () => ({ status: 200, body: { ok: true } }) };
  });

  afterEach(async () => {
    await server?.stop();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("bearer token", () => {
    beforeEach(() => start({}, { token: "s3cret" }));

    it("401 on every route without it or with the wrong one", async () => {
      for (const [m, p] of [
        ["GET", "/health"],
        ["GET", `/stream/${STREAM}`],
        ["GET", "/umid/abc"],
        ["GET", "/events"],
        ["POST", "/"],
        ["GET", "/nothing"],
      ]) {
        const r = await request(m, p);
        expect(r.status, `${m} ${p}`).to.equal(401);
        expect(r.headers["www-authenticate"]).to.equal("Bearer");
        const w = await request(m, p, { headers: { authorization: "Bearer wrong" } });
        expect(w.status, `${m} ${p}`).to.equal(401);
      }
      expect((await request("GET", "/health", { headers: { authorization: "Basic s3cret" } })).status).to.equal(401);
      expect((await request("GET", "/health", { headers: { authorization: "Bearer s3cret2" } })).status).to.equal(401);
    });

    it("passes with the token", async () => {
      const r = await request("GET", "/health", { headers: { authorization: "Bearer s3cret" } });
      expect(r.status).to.equal(200);
    });
  });

  describe("GET /health", () => {
    it("ready: 200 with every field and no reason", async () => {
      state.headConfirmedAt = Date.now() - 5500;
      await start();
      const r = await request("GET", "/health");
      expect(r.status).to.equal(200);
      expect(r.body).to.deep.equal({
        ready: true,
        version: "5.1.0",
        minVersion: "5.1.0",
        lagSeconds: 5,
        cursor: "umid:1,abc",
        upstreams: [{ host: "sn1:5260:http", ok: true }],
      });
    });

    it("not ready: 503 with reason starting, or outdated", async () => {
      state.ready = false;
      await start();
      let r = await request("GET", "/health");
      expect(r.status).to.equal(503);
      expect(r.body).to.include({ ready: false, reason: "starting" });
      state.reason = "outdated";
      r = await request("GET", "/health");
      expect(r.status).to.equal(503);
      expect(r.body).to.include({ ready: false, reason: "outdated", minVersion: "5.1.0" });
    });

    it("lag is time since the head was confirmed and never changes the status without maxLagSeconds", async () => {
      state.headConfirmedAt = Date.now() - 3600 * 1000;
      await start();
      const r = await request("GET", "/health");
      expect(r.status).to.equal(200);
      expect(r.body.lagSeconds).to.be.within(3599, 3601);
    });

    it("with maxLagSeconds, 503 beyond it and 200 within it", async () => {
      state.headConfirmedAt = Date.now() - 20000;
      await start({}, { maxLagSeconds: 10 });
      let r = await request("GET", "/health");
      expect(r.status).to.equal(503);
      expect(r.body.ready).to.equal(true);
      expect("reason" in r.body).to.equal(false);
      state.headConfirmedAt = Date.now() - 2000;
      r = await request("GET", "/health");
      expect(r.status).to.equal(200);
    });

    it("never confirmed: lagSeconds null", async () => {
      state.headConfirmedAt = 0;
      await start();
      const r = await request("GET", "/health");
      expect(r.body.lagSeconds).to.equal(null);
    });
  });

  describe("GET /stream/:id", () => {
    beforeEach(() => start());

    it("returns state and :stream meta, never volatile", async () => {
      await store.data.post({ _id: STREAM, balance: 5 });
      await store.data.post({ _id: `${STREAM}:stream`, umid: "u", authorities: [{ public: "k" }] });
      await store.data.post({ _id: `${STREAM}:volatile`, secret: "no" });
      const r = await request("GET", `/stream/${STREAM}`);
      expect(r.status).to.equal(200);
      expect(r.body.stream).to.include({ _id: STREAM, balance: 5 });
      expect(r.body.meta).to.include({ _id: `${STREAM}:stream`, umid: "u" });
      expect(r.body.meta.authorities).to.deep.equal([{ public: "k" }]);
      expect(r.text).to.not.contain("secret");
      expect(lookups).to.have.length(0);
    });

    it("fetches an unknown stream once and serves it from the store after", async () => {
      lookupDocs[STREAM] = [{ _id: STREAM, v: 1 }, { _id: `${STREAM}:stream`, authorities: [] }];
      let r = await request("GET", `/stream/${STREAM}`);
      expect(r.status).to.equal(200);
      expect(r.body.stream.v).to.equal(1);
      r = await request("GET", `/stream/${STREAM}`);
      expect(r.status).to.equal(200);
      expect(lookups).to.deep.equal([[STREAM]]);
    });

    it("404 when no upstream has it, and does not ask again straight away", async () => {
      const [a, b] = await Promise.all([
        request("GET", `/stream/${STREAM}`),
        request("GET", `/stream/${STREAM}`),
      ]);
      expect(a.status).to.equal(404);
      expect(b.status).to.equal(404);
      await request("GET", `/stream/${STREAM}`);
      expect(lookups).to.have.length(1);
    });

    it("400 for ids that are not stream ids", async () => {
      for (const id of [`${STREAM}:volatile`, `${STREAM}%3Astream`, "_all_docs", "_design", ".x", "%E0%A4%A"]) {
        const r = await request("GET", `/stream/${id}`);
        expect(r.status, id).to.equal(400);
      }
      expect(lookups).to.have.length(0);
    });
  });

  describe("GET /umid/:umid", () => {
    it("serves the local :umid doc", async () => {
      await start();
      await store.data.post({ _id: "abc:umid", umid: { $umid: "abc" } });
      const r = await request("GET", "/umid/abc");
      expect(r.status).to.equal(200);
      expect(r.body.umid.$umid).to.equal("abc");
    });

    describe("from a supernode when not held", () => {
      const node = new ActiveCrypto.KeyPair("secp256k1");
      const nodePem = node.generate(2048, true);
      const revs = { [STREAM]: "1-x" };
      const doc = { _id: "def:umid", umid: { $umid: "def", $revs: revs }, streams: {}, events: [] };
      const att = (d: any) => {
        const a: any = { node: "ref1", umid: "def", outcome: "committed", revsOut: {}, umidDocHash: docHash(d) };
        a.sig = ActiveCrypto.signDigest(
          new ActiveCrypto.KeyPair("secp256k1", nodePem.prv.pkcs8pem),
          ActiveCrypto.commitDigest(a.umid, a.outcome, revs, a.revsOut, a.umidDocHash)
        );
        return a;
      };
      const sn = (d: any, a: any) => ({ id: "sn", umid: async () => d, attest: async () => a }) as any;

      beforeEach(() => {
        state.verify = {
          keys: new Map([["ref1", { type: "secp256k1", public: nodePem.pub.pkcs8pem }]]),
          reachedPercent: 51,
          networkSize: 1,
        };
      });

      it("serves it when its attestation verifies", async () => {
        await start({ sources: { supernodes: [sn(doc, att(doc))], peers: [] } });
        const r = await request("GET", "/umid/def");
        expect(r.status).to.equal(200);
        expect(r.body).to.deep.equal(doc);
      });

      it("404 for a doc that does not match its attestation", async () => {
        const tampered = { ...doc, events: [{ x: 1 }] };
        const bad = { id: "bad", umid: async () => tampered, attest: async () => att(doc) } as any;
        await start({ sources: { supernodes: [bad], peers: [] } });
        const r = await request("GET", "/umid/def");
        expect(r.status).to.equal(404);
      });

      it("tries the next supernode after a failure", async () => {
        const broken = { id: "x", umid: async () => { throw new Error("down"); }, attest: async () => undefined } as any;
        await start({ sources: { supernodes: [broken, sn(doc, att(doc))], peers: [] } });
        expect((await request("GET", "/umid/def")).status).to.equal(200);
      });
    });

    it("400 for an invalid umid", async () => {
      await start();
      expect((await request("GET", "/umid/abc:umid")).status).to.equal(400);
      expect((await request("GET", "/umid/_x")).status).to.equal(400);
    });
  });

  describe("GET /events", () => {
    let log: EventLog;
    beforeEach(() => {
      log = new EventLog(store.events);
    });

    it("tails live events in the supernode's SSE format", async () => {
      await start();
      const reading = sse("/events", 2);
      await new Promise((r) => setTimeout(r, 50));
      await log.emit({ type: "minted", contract: "a", umid: "u1", payload: { n: 1 } });
      await log.emit({ type: "tx.committed", contract: "a", umid: "u1" });
      const got = await reading;
      got.close();
      expect(got.status).to.equal(200);
      expect(got.events.map((e) => e.data.name)).to.deep.equal(["minted", "tx.committed"]);
      expect(got.events[0].data).to.deep.equal({ name: "minted", data: { n: 1 }, phase: "commit", contract: "a", umid: "u1" });
      expect(got.raw).to.match(/id:[0-9]+-000001,u1\nevent: message\ndata:\{/);
    });

    it("applies the pinned filter and a client cannot widen it", async () => {
      await start({}, { events: { where: { tenant: "t1" } } });
      const reading = sse("/events?where=tenant:t2", 1, {}, 250);
      const plain = sse("/events", 1, {}, 250);
      await new Promise((r) => setTimeout(r, 50));
      await log.emit({ type: "tx.committed", contract: "a", umid: "u" });
      await log.emit({ type: "minted", contract: "a", umid: "u", payload: { tenant: "t2" } });
      await log.emit({ type: "minted", contract: "a", umid: "u", payload: {} });
      await log.emit({ type: "minted", contract: "a", umid: "u", payload: { tenant: "t1" } });
      const [w, p] = await Promise.all([reading, plain]);
      w.close();
      p.close();
      expect(w.events).to.have.length(0);
      expect(p.events.map((e) => e.data.data)).to.deep.equal([{ tenant: "t1" }]);
    });

    it("resumes after Last-Event-ID with the same filter, then tails", async () => {
      await start({}, { events: { contracts: ["a"] } });
      await log.emit({ type: "e1", contract: "a", umid: "u" });
      await log.emit({ type: "e2", contract: "b", umid: "u" });
      await log.emit({ type: "e3", contract: "a", umid: "u" });
      await log.emit({ type: "e4", contract: "a", umid: "u" });
      const ids = (await store.events.eventsSince("")).map(([id]) => id);

      const reading = sse("/events", 3, { "last-event-id": ids[0] });
      await new Promise((r) => setTimeout(r, 50));
      await log.emit({ type: "e5", contract: "b", umid: "u" });
      await log.emit({ type: "e6", contract: "a", umid: "u" });
      const got = await reading;
      got.close();
      expect(got.events.map((e) => e.data.name)).to.deep.equal(["e3", "e4", "e6"]);
      expect(got.events[0].id).to.equal(ids[2]);
    });

    it("400 for a bad filter", async () => {
      await start();
      expect((await request("GET", "/events?where=nocolon")).status).to.equal(400);
      expect((await request("GET", "/events?bogus=1")).status).to.equal(400);
    });

    it("stop() ends open event streams", async () => {
      await start();
      const reading = sse("/events", 1, {}, 2000);
      await new Promise((r) => setTimeout(r, 50));
      const t = Date.now();
      await server.stop();
      await reading;
      expect(Date.now() - t).to.be.lessThan(1000);
    });
  });

  describe("POST /", () => {
    it("passes the submitter's answer through byte-identical", async () => {
      const answer = {
        $umid: "u",
        $summary: { total: 1, vote: 1, commit: 1, errors: [] },
        $streams: { new: [{ id: STREAM, name: "é" }], updated: [] },
        $responses: [1.5, null, "x"],
      };
      const kp = new ActiveCrypto.KeyPair("secp256k1");
      const pem = kp.generate(2048, true).pub.pkcs8pem;
      submitter = new Submitter({
        config: { refuseOnboard: true },
        state,
        sources: { supernodes: [{ id: "sn", submit: async () => answer } as any], peers: [] },
        lookup: { ensure: async () => ({ missing: [] }), refreshToTip: async () => ({ missing: [] }) },
        identity: { pair: kp, publicPem: pem },
        dryRun: async () =>
          ({ umid: "", vote: true, committed: true, documents: {}, volatile: {}, events: [], supernodeDependent: false, dependence: [], adopt: [] }) as any,
      });
      await start();
      const tx = {
        $tx: { $namespace: "n", $contract: "c", $i: { [STREAM]: {} }, $expire: new Date(Date.now() + 60000).toISOString() },
        $sigs: { [STREAM]: "s" },
      };
      const r = await request("POST", "/", { body: JSON.stringify(tx), headers: { "content-type": "application/json" } });
      expect(r.status).to.equal(200);
      expect(r.text).to.equal(JSON.stringify(answer));
    });

    it("answers a hybrid outcome with its status", async () => {
      submitter = { submit: async () => ({ status: 403, body: { $hybrid: "denied", error: "no" } }) };
      await start();
      const r = await request("POST", "/", { body: "{}" });
      expect(r.status).to.equal(403);
      expect(r.body).to.deep.equal({ $hybrid: "denied", error: "no" });
    });

    it("400 denied for invalid JSON", async () => {
      await start();
      const r = await request("POST", "/", { body: "{nope" });
      expect(r.status).to.equal(400);
      expect(r.body.$hybrid).to.equal("denied");
    });

    it("413 for a body over 16MB, declared or streamed", async () => {
      await start();
      let seen = false;
      submitter = {
        submit: async () => {
          seen = true;
          return { status: 200, body: {} };
        },
      };
      const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
      // Streamed (chunked, no length)
      let r = await request("POST", "/", { body: big });
      expect(r.status).to.equal(413);
      expect(r.body.$hybrid).to.equal("denied");
      // Declared
      r = await request("POST", "/", { body: big, headers: { "content-length": big.length } });
      expect(r.status).to.equal(413);
      expect(seen).to.equal(false);
    });

    it("never leaks an internal error", async () => {
      submitter = {
        submit: async () => {
          throw new Error("/var/lib/secret path");
        },
      };
      await start();
      const r = await request("POST", "/", { body: "{}" });
      expect(r.status).to.equal(500);
      expect(r.body).to.deep.equal({ error: "Internal error" });
    });

    it("503 when the handler takes too long", async () => {
      submitter = { submit: () => new Promise(() => undefined) };
      await start({ requestTimeoutMs: 50 });
      const r = await request("POST", "/", { body: "{}" });
      expect(r.status).to.equal(503);
    });
  });

  describe("routing", () => {
    beforeEach(() => start());
    it("404 for unknown paths", async () => {
      for (const p of ["/nothing", "/stream", "/stream/a/b", "/umid/", "/health/x"]) {
        expect((await request("GET", p)).status, p).to.equal(404);
      }
    });
    it("405 with Allow for a known path and the wrong method", async () => {
      let r = await request("POST", "/health");
      expect(r.status).to.equal(405);
      expect(r.headers.allow).to.equal("GET");
      r = await request("GET", "/");
      expect(r.status).to.equal(405);
      expect(r.headers.allow).to.equal("POST");
      r = await request("DELETE", `/stream/${STREAM}`);
      expect(r.status).to.equal(405);
    });
  });
});
