import { expect } from "chai";
import "mocha";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";
import { defaultConfig } from "../packages/hybrid/src/config";
import { HybridNode } from "../packages/hybrid/src/node";
import { UpstreamError } from "../packages/hybrid/src/http-upstream";
import { BootstrapError } from "../packages/hybrid/src/bootstrap";

const generated = new ActiveCrypto.KeyPair("rsa").generate();
const nodePem = new ActiveCrypto.KeyPair("rsa").generate().pub.pkcs8pem;

const setupDoc = {
  _id: "setup",
  _rev: "2-s",
  neighbourhood: [{ host: "h", port: 1, identity: { type: "rsa", public: nodePem } }],
  consensus: { reached: 60 },
};

/** An upstream that serves a script: a bootstrap, and a feed that heartbeats then idles */
const upstream = (over: any = {}) => {
  const feeds: string[] = [];
  const up: any = {
    id: "up1",
    feeds,
    bootstrap: async () => ({ setup: setupDoc, required: [], contracts: [], cursor: "umid:5,u5", minVersion: "5.1.0", ...over.bootstrap }),
    head: async () => ({ cursor: "umid:5,u5", time: Date.now() }),
    feed: async (cursor: string, _onItem: any, signal: AbortSignal, onBeat: any) => {
      feeds.push(cursor);
      onBeat(over.head ?? "umid:5,u5", Date.now());
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    streams: async () => ({ docs: [], missing: [] }),
    umid: async () => undefined,
    attest: async () => undefined,
    peers: async () => [],
    submit: async () => ({}),
    ...over.methods,
  };
  return up;
};

const get = (port: number, p: string, method = "GET") =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    http.request({ host: "127.0.0.1", port, path: p, method }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data || "null") }));
    }).on("error", reject).end();
  });

describe("HybridNode", () => {
  let dir: string;
  let node: HybridNode | undefined;
  let steps: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-node-"));
    fs.writeFileSync(path.join(dir, ".identity"), JSON.stringify(generated));
    steps = [];
    node = undefined;
  });
  afterEach(async () => node?.stop());

  const make = (up: any, over: any = {}) => {
    const config = { ...defaultConfig(), port: 0, upstreams: [{ host: "h", port: 1, transport: "http" as const }], ...over.config };
    node = new HybridNode({
      config,
      dataDir: path.join(dir, "data"),
      identityPath: path.join(dir, ".identity"),
      version: "5.1.0",
      onStep: (s, e) => steps.push(`${s}:${e}`),
      makeUpstream: () => up,
      progressMs: 5,
      prepareWorkspace: false,
      ...over,
    });
    return node;
  };

  it("runs the steps in order and becomes ready once the head is confirmed", async () => {
    const n = make(upstream());
    await n.start();
    expect(steps).to.deep.equal([
      "config:begin", "config:done", "identity:begin", "identity:done", "store:begin", "store:done",
      "bootstrap:begin", "bootstrap:done", "catching up:begin", "catching up:done", "ready:begin", "ready:done",
    ]);
    expect(n.state.ready).to.equal(true);
    expect(n.state.reason).to.equal(undefined);
    expect(n.state.cursor).to.equal("umid:5,u5");
  });

  it("serves /health: 503 starting during bootstrap, 200 ready after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seen: { status: number; body: any } | undefined;
    const up = upstream({ methods: {} });
    const realBootstrap = up.bootstrap;
    let n!: HybridNode;
    up.bootstrap = async () => {
      seen = await get(n.port!, "/health");
      await gate;
      return realBootstrap();
    };
    n = make(up);
    const started = n.start();
    for (let i = 0; i < 200 && !seen; i++) await new Promise((r) => setTimeout(r, 5));
    release();
    await started;
    expect(seen!.status).to.equal(503);
    expect(seen!.body).to.include({ ready: false, reason: "starting" });
    const after = await get(n.port!, "/health");
    expect(after.status).to.equal(200);
    expect(after.body).to.include({ ready: true, cursor: "umid:5,u5" });
  });

  it("resumes from the stored cursor instead of the bootstrap's", async () => {
    const first = make(upstream());
    await first.start();
    await first.stop();
    // Pretend it applied more before it stopped
    const { openEmbeddedStorage } = await import("../packages/storage/src/embedded");
    const store = await openEmbeddedStorage(path.join(dir, "data"));
    const { saveCursor } = await import("../packages/hybrid/src/bootstrap");
    await saveCursor(store, "umid:9,u9");
    await store.close();

    const up = upstream({ head: "umid:9,u9" });
    const second = make(up);
    await second.start();
    expect(up.feeds[0]).to.equal("umid:9,u9");
    expect(second.state.cursor).to.equal("umid:9,u9");
  });

  it("an outdated release stays up, not ready, and applies nothing", async () => {
    const up = upstream({ bootstrap: { minVersion: "6.0.0" } });
    const n = make(up);
    await n.start();
    expect(n.state.ready).to.equal(false);
    expect(n.state.reason).to.equal("outdated");
    expect(n.state.minVersion).to.equal("6.0.0");
    expect(steps).to.not.include("catching up:begin");
    const h = await get(n.port!, "/health");
    expect(h.status).to.equal(503);
    expect(h.body).to.include({ reason: "outdated", minVersion: "6.0.0" });
    expect(up.feeds).to.deep.equal([]);
  });

  it("fails start with the reason when no upstream bootstraps, and reports the step", async () => {
    const up = upstream({ methods: { bootstrap: async () => { throw new UpstreamError("refused", "refused", 403); } } });
    const n = make(up);
    let err: any;
    try { await n.start(); } catch (e) { err = e; }
    expect(err).to.be.instanceOf(BootstrapError);
    expect(err.refused).to.equal(true);
    expect(steps).to.include("bootstrap:fail");
    expect(n.state.ready).to.equal(false);
  });

  it("fails at the identity step for a missing identity file", async () => {
    fs.rmSync(path.join(dir, ".identity"));
    const n = make(upstream());
    let err: any;
    try { await n.start(); } catch (e) { err = e; }
    expect(err).to.be.instanceOf(Error);
    expect(steps).to.include("identity:fail");
  });

  it("reports catching-up progress while behind", async () => {
    const progress: number[] = [];
    const up = upstream({ head: "umid:9000,u9" });
    const n = make(up, { onProgress: (lag: number) => progress.push(lag), maxStartLagSeconds: 10_000 });
    await n.start();
    expect(progress.length).to.be.greaterThan(0);
  });

  it("answers the CLI's divergences and prune requests from loopback", async () => {
    const n = make(upstream());
    await n.start();
    const { writeDivergence } = await import("../packages/hybrid/src/divergence");
    const store = (n as any).store;
    await writeDivergence(store, { umid: "u1", kind: "output-mismatch", supernodeTally: { yes: 3, no: 0 }, localResult: {}, $revs: { $i: {}, $o: {} }, at: new Date(2000).toISOString() } as any);
    await writeDivergence(store, { umid: "u2", kind: "output-mismatch", supernodeTally: { yes: 3, no: 0 }, localResult: {}, $revs: { $i: {}, $o: {} }, at: new Date(9000).toISOString() } as any);
    const all = await get(n.port!, "/divergences");
    expect(all.status).to.equal(200);
    expect(all.body.map((d: any) => d.umid)).to.deep.equal(["u1", "u2"]);
    const since = await get(n.port!, `/divergences?since=${new Date(5000).toISOString()}`);
    expect(since.body.map((d: any) => d.umid)).to.deep.equal(["u2"]);
    expect((await get(n.port!, "/divergences?since=nonsense")).status).to.equal(400);

    const dry = await get(n.port!, "/prune?dryRun=true", "POST");
    expect(dry.status).to.equal(200);
    expect(dry.body.dryRun).to.equal(true);
    expect((await get(n.port!, "/prune", "POST")).body.dryRun).to.equal(false);
    expect((await get(n.port!, "/prune")).status).to.equal(405);
  });

  /** An upstream whose heartbeats and items the test sends itself */
  const driven = (over: any = {}) => {
    const hooks: { beat?: (head: string, time: number, minVersion?: string) => void; item?: (cursor: string, item: any) => Promise<void> } = {};
    const up = upstream({
      ...over,
      methods: {
        feed: async (_cursor: string, onItem: any, signal: AbortSignal, onBeat: any) => {
          hooks.beat = onBeat;
          hooks.item = onItem;
          onBeat("umid:5,u5", Date.now());
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
        ...over.methods,
      },
    });
    return { up, hooks };
  };

  describe("a minimum version named by a heartbeat", () => {
    it("stops a ready node applying items, and reports it outdated", async () => {
      const { up, hooks } = driven();
      const n = make(up);
      await n.start();
      expect(n.state.ready).to.equal(true);
      hooks.beat!("umid:5,u5", Date.now(), "6.0.0");
      expect(n.state.ready).to.equal(false);
      expect(n.state.reason).to.equal("outdated");
      expect(n.state.minVersion).to.equal("6.0.0");
      const h = await get(n.port!, "/health");
      expect(h.status).to.equal(503);
      expect(h.body).to.include({ ready: false, reason: "outdated", minVersion: "6.0.0" });
    });

    it("applies nothing while outdated: an item is refused before it reaches the processor", async () => {
      const { up, hooks } = driven();
      const n = make(up);
      await n.start();
      hooks.beat!("umid:5,u5", Date.now(), "6.0.0");
      let thrown: any;
      try {
        await hooks.item!("umid:6,u6", { umid: "u6", outcome: "committed" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(Error);
      // The cursor did not move past what was applied
      expect(n.state.cursor).to.equal("umid:5,u5");
    });

    it("resumes, ready again, when the minimum is lowered to this release", async () => {
      const { up, hooks } = driven();
      const n = make(up);
      await n.start();
      hooks.beat!("umid:5,u5", Date.now(), "6.0.0");
      hooks.beat!("umid:5,u5", Date.now(), "5.1.0");
      expect(n.state.ready).to.equal(true);
      expect(n.state.reason).to.equal(undefined);
      expect(n.state.minVersion).to.equal("5.1.0");
      expect((await get(n.port!, "/health")).status).to.equal(200);
    });

    it("stays down after a lowered minimum when it started outdated, which needs a restart", async () => {
      // An outdated node opens no feed to carry a heartbeat: it asks for the head
      const up = upstream({
        bootstrap: { minVersion: "6.0.0" },
        methods: { head: async () => ({ cursor: "umid:5,u5", time: Date.now(), minVersion: "5.1.0" }) },
      });
      const n = make(up);
      await n.start();
      for (let i = 0; i < 200 && n.state.minVersion !== "5.1.0"; i++) await new Promise((r) => setTimeout(r, 5));
      expect(n.state.minVersion).to.equal("5.1.0");
      expect(n.state.ready).to.equal(false);
      expect(n.state.reason).to.equal("outdated");
      expect(up.feeds).to.deep.equal([]);
    });

    it("ignores the same minimum, one that is not a version, and one this release meets", async () => {
      const { up, hooks } = driven();
      const n = make(up);
      await n.start();
      hooks.beat!("umid:5,u5", Date.now(), "5.1.0");
      hooks.beat!("umid:5,u5", Date.now(), "latest");
      hooks.beat!("umid:5,u5", Date.now(), "");
      expect(n.state.ready).to.equal(true);
      expect(n.state.minVersion).to.equal("5.1.0");
      hooks.beat!("umid:5,u5", Date.now(), "5.0.0");
      expect(n.state.ready).to.equal(true);
      expect(n.state.reason).to.equal(undefined);
      expect(n.state.minVersion).to.equal("5.0.0");
    });
  });

  it("makes a source for each supernode the setup stream names, skipping malformed entries", async () => {
    const made: string[] = [];
    const setup = {
      ...setupDoc,
      neighbourhood: [
        { host: "h", port: 1, identity: { type: "rsa", public: nodePem } },
        { host: "other", port: 5260 },
        { host: "other", port: "5260" },
        { host: "noport" },
        { host: "badport", port: "x" },
        { port: 5261 },
        null,
      ],
    };
    const up = upstream({ bootstrap: { setup } });
    make(up, {
      makeUpstream: (e: any) => {
        made.push(`${e.host}:${e.port}:${e.transport}`);
        return { ...up, id: `${e.host}:${e.port}` };
      },
    });
    await node!.start();
    // A well-formed neighbour, whether its port is a number or a numeric string, gets a source
    expect(made).to.include("other:5260:http");
    // Entries without a host or a whole-number port are not turned into endpoints
    expect(made.filter((m) => !/^(h:1|other:5260):http$/.test(m))).to.deep.equal([]);
  });

  describe("logging what the feed does with an item", () => {
    let lines: string[];
    let saved: { warn: any; debug: any };
    beforeEach(() => {
      lines = [];
      const { ActiveLogger } = require("@activeledger/activelogger");
      saved = { warn: ActiveLogger.warn, debug: ActiveLogger.debug };
      ActiveLogger.warn = (m: any) => lines.push(`warn ${m}`);
      ActiveLogger.debug = (m: any) => lines.push(`debug ${m}`);
    });
    afterEach(() => {
      const { ActiveLogger } = require("@activeledger/activelogger");
      ActiveLogger.warn = saved.warn;
      ActiveLogger.debug = saved.debug;
    });

    it("warns, with the shortened umid and the reasons, about an item that was dropped", async () => {
      const { up, hooks } = driven();
      const n = make(up);
      await n.start();
      await hooks.item!("umid:6,abcdefghijklmnopqrst", { umid: "abcdefghijklmnopqrst", outcome: "committed", nodes: {} });
      const line = lines.find((l) => l.includes("abcdefghijkl dropped"));
      expect(line, lines.join("\n")).to.match(/^warn abcdefghijkl dropped \(no\): .+/);
      expect(line).to.not.contain("abcdefghijklm");
    });
  });
});
