import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { IEmbeddedStorage, openEmbeddedStorage } from "../packages/storage/src/embedded";
import { HybridServer } from "../packages/hybrid/src/api";
import { EventLog } from "../packages/hybrid/src/events";

const STREAM = "b".repeat(64);

describe("Hybrid API server, odd requests and failing helpers (cov)", () => {
  let dir: string;
  let store: IEmbeddedStorage;
  let server: HybridServer;
  let port: number;
  let lookups: string[][];
  let lookupImpl: (ids: string[]) => Promise<{ missing: string[] }>;
  let now: number;
  const state: any = { version: "5.1.0", ready: true, minVersion: "5.1.0", cursor: "c", headConfirmedAt: Date.now(), upstreams: [] };

  const start = async (over: any = {}) => {
    server = new HybridServer({
      config: { bind: "127.0.0.1", port: 0, maxLagSeconds: null } as any,
      state,
      store,
      lookup: {
        ensure: async () => ({ missing: [] }),
        refreshToTip: async (ids: string[]) => {
          lookups.push(ids);
          return lookupImpl(ids);
        },
      },
      submitter: { submit: async () => ({ status: 200, body: {} }) } as any,
      heartbeatMs: 50,
      now: () => now,
      ...over,
    });
    port = (await server.start()).port;
  };

  const get = (p: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: p }, (res) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve({ status: res.statusCode as number, body: t ? JSON.parse(t) : undefined }));
        })
        .on("error", reject);
    });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-server-cov-"));
    store = await openEmbeddedStorage(dir);
    lookups = [];
    lookupImpl = async (ids) => ({ missing: ids });
    now = 1_000_000;
  });
  afterEach(async () => {
    await server?.stop();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers 400 to a request target that is not a path", async () => {
    await start();
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let t = "";
      s.on("data", (c) => (t += c));
      s.on("end", () => resolve(t));
      s.on("error", reject);
    });
    expect(reply).to.match(/^HTTP\/1\.1 400 /);
    expect(reply).to.contain('{"error":"Bad request"}');
  });

  describe("an unknown stream whose lookup fails", () => {
    it("is 404 and is not asked for again until the cache runs out", async () => {
      lookupImpl = async () => {
        throw new Error("upstream down");
      };
      await start({ notFoundCacheMs: 5000 });
      const first = await get(`/stream/${STREAM}`);
      expect(first.status).to.equal(404);
      expect(first.body).to.deep.equal({ error: "Stream not found" });
      expect(lookups.length).to.equal(1);
      await get(`/stream/${STREAM}`);
      expect(lookups.length).to.equal(1);
      now += 4999;
      await get(`/stream/${STREAM}`);
      expect(lookups.length).to.equal(1);
      now += 2;
      await get(`/stream/${STREAM}`);
      expect(lookups.length).to.equal(2);
    });
    it("is served once a later lookup brings it in", async () => {
      await start({ notFoundCacheMs: 5000 });
      expect((await get(`/stream/${STREAM}`)).status).to.equal(404);
      lookupImpl = async () => {
        await store.data.post({ _id: STREAM, v: 1 });
        await store.data.post({ _id: `${STREAM}:stream`, umid: "u" });
        return { missing: [] };
      };
      now += 6000;
      const r = await get(`/stream/${STREAM}`);
      expect(r.status).to.equal(200);
      expect(r.body.stream.v).to.equal(1);
      expect(r.body.meta.umid).to.equal("u");
    });
  });

  it("404s an unheld umid that no supernode has, without asking for an attestation", async () => {
    let attested = 0;
    state.verify = { keys: new Map(), reachedPercent: 51, networkSize: 1 };
    await start({ sources: { supernodes: [{ id: "sn", umid: async () => undefined, attest: async () => (attested++, {}) }], peers: [] } });
    const r = await get("/umid/abc");
    delete state.verify;
    expect(r.status).to.equal(404);
    expect(r.body).to.deep.equal({ error: "Umid not found" });
    expect(attested).to.equal(0);
  });

  it("still tails live events when the replay cannot be read", async () => {
    await start();
    (store.events as any).eventsSince = async () => {
      throw new Error("cannot read");
    };
    const log = new EventLog(store.events);
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/events", headers: { "last-event-id": "1-000001,x" } }, (res) => {
        let raw = "";
        const timer = setTimeout(() => (req.destroy(), resolve(raw)), 600);
        res.on("data", (c) => {
          raw += c;
          if (raw.includes("live1")) (clearTimeout(timer), req.destroy(), resolve(raw));
        });
      });
      req.on("error", () => undefined);
      setTimeout(() => log.emit({ type: "live1", contract: "a", umid: "u" }).catch(reject), 150);
    });
    expect(got).to.contain('"name":"live1"');
  });
});
