import { expect } from "chai";
import "mocha";
import * as crypto from "crypto";
import { ActiveOptions } from "@activeledger/activeoptions";
import { ActiveLogger } from "@activeledger/activelogger";
import { ActiveProtocol } from "@activeledger/activeprotocol";
import { Home } from "../packages/network/src/network/home";

// The worker Processor lives in a module that starts itself on import: it
// registers its IPC handler on the global process object. The handler is
// captured while it registers (so it is never wired to mocha's own process)
// and driven with the same messages the host sends over IPC.
describe("Network worker Processor (process.ts)", () => {
  type Msg = { type: string; data: any };
  let handler: (m: any) => void;
  let disconnect: () => void;
  let sent: Msg[];
  let timers: { fn: () => void; ms: number }[];
  let logged: { level: string; obj: any; msg?: string }[];

  const originals: any = {};
  const proto: any = ActiveProtocol.Process.prototype;

  // Calls made to the stubbed protocol process
  let started: any[];
  let destroyed: string[];
  let broadcasts: any[];

  const rejectionListeners = () => process.listeners("unhandledRejection");

  const entryFor = (umid: string, extra: any = {}): any => ({
    $umid: umid,
    $tx: { $namespace: "ns", $contract: "contractid", $i: {}, $o: {} },
    $nodes: {},
    $sigs: {},
    ...extra,
  });

  const lastSent = (type: string): Msg | undefined =>
    [...sent].reverse().find((m) => m.type === type);

  // Live transactions (so each test can clean up) and the unhandledRejection
  // listener each one registered
  const live = new Set<string>();
  const rejection: { [umid: string]: (reason: any) => void } = {};

  const tx = (entry: any): any => {
    const known = new Set(rejectionListeners());
    handler({ type: "tx", entry });
    live.add(entry.$umid);
    rejection[entry.$umid] = rejectionListeners().find(
      (l) => !known.has(l)
    ) as any;
    return lastProtocol;
  };

  // The Processor keeps its protocols private; the stubbed constructor path
  // is observed through the prototype stub on start()
  let lastProtocol: any;

  before(async () => {
    originals.on = process.on;
    originals.send = (process as any).send;
    originals.exit = process.exit;
    originals.init = ActiveOptions.init;
    originals.parseConfig = ActiveOptions.parseConfig;
    originals.extendConfig = ActiveOptions.extendConfig;
    originals.setTimeout = global.setTimeout;
    for (const l of ["info", "warn", "error", "debug", "fatal"]) {
      originals[l] = (ActiveLogger as any)[l];
    }

    ActiveOptions.init = () => undefined;
    ActiveOptions.parseConfig = () => undefined;
    (process as any).on = function (event: string, fn: any) {
      if (event === "message") handler = fn;
      else if (event === "disconnect") disconnect = fn;
      else return originals.on.call(process, event, fn);
      return process;
    };
    try {
      // Constructing the Processor is the import side effect
      const mod = await import("../packages/network/src/network/process");
      void mod;
    } finally {
      process.on = originals.on;
    }
  });

  beforeEach(() => {
    sent = [];
    timers = [];
    logged = [];
    started = [];
    destroyed = [];
    broadcasts = [];
    (process as any).send = (m: Msg) => {
      sent.push(m);
      return true;
    };
    (global as any).setTimeout = (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0 as any;
    };
    for (const l of ["info", "warn", "error", "debug", "fatal"]) {
      (ActiveLogger as any)[l] = (obj: any, msg?: string) => {
        logged.push({ level: l, obj, msg });
        return new Error(msg);
      };
    }
    originals.start = proto.start;
    originals.destroy = proto.destroy;
    originals.updated = proto.updatedFromBroadcast;
    originals.clearCache = (ActiveProtocol.Process as any)
      .clearContractPathCache;
    proto.start = function (...args: any[]) {
      lastProtocol = this;
      started.push(args);
    };
    proto.destroy = function (umid: string) {
      destroyed.push(umid);
    };
    proto.updatedFromBroadcast = function (nodes: any) {
      broadcasts.push(nodes);
    };
    Home.reference = "self-ref";
    Home.host = "localhost:5260";
    Home.right = { host: "r", port: 1 } as any;
  });

  afterEach(() => {
    process.send = originals.send;
    (global as any).setTimeout = originals.setTimeout;
    for (const l of ["info", "warn", "error", "debug", "fatal"]) {
      (ActiveLogger as any)[l] = originals[l];
    }
    proto.start = originals.start;
    proto.destroy = originals.destroy;
    proto.updatedFromBroadcast = originals.updated;
    (ActiveProtocol.Process as any).clearContractPathCache =
      originals.clearCache;
    // Leave no protocol or rejection listener behind
    for (const umid of live) {
      handler({ type: "destory", data: { umid, skipTimeout: true } });
    }
    live.clear();
    ActiveOptions.extendConfig = originals.extendConfig;
    process.exit = originals.exit;
  });

  after(() => {
    ActiveOptions.init = originals.init;
    ActiveOptions.parseConfig = originals.parseConfig;
  });

  describe("lifecycle", () => {
    it("exits when the host disconnects", () => {
      let code: number | undefined;
      process.exit = ((c?: number) => {
        code = c;
      }) as any;
      disconnect();
      expect(code).to.equal(0);
    });

    it("rejects an unknown message type without touching state", () => {
      handler({ type: "nonsense" });
      expect(logged.some((l) => l.level === "fatal" && l.msg === "Unknown Processor Call")).to.equal(true);
      expect(sent).to.deep.equal([]);
    });

    it("reports memory pressure to the host once only", () => {
      const rss = process.memoryUsage.rss;
      (process.memoryUsage as any).rss = () => Number.MAX_SAFE_INTEGER;
      try {
        handler({ type: "contractData", data: { contract: "c", data: 1 } });
        handler({ type: "contractData", data: { contract: "c", data: 2 } });
      } finally {
        (process.memoryUsage as any).rss = rss;
      }
      expect(sent.filter((m) => m.type === "memory")).to.have.length(1);
      expect(lastSent("memory")!.data).to.have.property("rss");
    });
  });

  describe("setup", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const setupData = () => ({
      db: { url: "http://127.0.0.1:1", database: "d", error: "e", event: "v" },
      __base: "/tmp/base",
      reference: "ref-1",
      self: "10.0.0.1:5260",
      pubPem: publicKey,
      privPem: privateKey,
      right: { host: "10.0.0.2", port: 5260, isHome: false },
      neighbours: { a: { reference: "a" } },
    });

    it("builds the connections and home, then tells the host it is ready", async () => {
      ActiveOptions.extendConfig = () => Promise.resolve({});
      handler({ type: "setup", data: setupData() });
      await new Promise((r) => setImmediate(r));

      expect(ActiveOptions.get<string>("__base", "")).to.equal("/tmp/base");
      expect(Home.reference).to.equal("ref-1");
      expect(Home.host).to.equal("10.0.0.1:5260");
      expect(Home.publicPem).to.equal(publicKey);
      expect(Home.identity).to.not.equal(undefined);
      expect(ActiveProtocol.Attestation.key).to.equal(Home.identity);
      expect(Home.right.host).to.equal("10.0.0.2");
      expect(Home.right.port).to.equal(5260);
      expect(lastSent("ready")!.data).to.deep.equal({ pid: process.pid });
    });

    it("never says ready when the configuration cannot be extended", async () => {
      ActiveOptions.extendConfig = () => Promise.reject(new Error("no db"));
      handler({ type: "setup", data: setupData() });
      await new Promise((r) => setImmediate(r));
      expect(lastSent("ready")).to.equal(undefined);
      expect(
        logged.some((l) => l.level === "fatal" && l.msg === "Config Extension Issues")
      ).to.equal(true);
    });
  });

  describe("housekeeping (hk)", () => {
    it("replaces the right neighbour and keeps the neighbourhood", () => {
      const neighbours: any = { x: {} };
      handler({
        type: "hk",
        data: {
          right: { host: "10.1.1.1", port: 6000, isHome: false },
          neighbourhood: neighbours,
        },
      });
      expect(Home.right.host).to.equal("10.1.1.1");
      expect(Home.right.port).to.equal(6000);
    });

    it("accepts a neighbourhood-less update and marks the right as home", () => {
      const neighbours: any = { keep: {} };
      handler({
        type: "hk",
        data: { right: { host: "10.1.1.2", port: 6001, isHome: true } },
      });
      expect(Home.right.host).to.equal("10.1.1.2");
      expect(Home.right.isHome).to.equal(true);
    });

    it("rebuilds the right neighbour's identity key when one is sent", () => {
      const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      handler({
        type: "hk",
        data: {
          right: {
            host: "10.1.1.3",
            port: 6002,
            isHome: false,
            identity: { type: "rsa", pem: privateKey },
          },
        },
      });
      expect(Home.right.identity).to.not.equal(undefined);
    });

    it("falls back to the current right neighbour when the message has none", () => {
      Home.right = { host: "10.9.9.9", port: 7000, isHome: false } as any;
      handler({ type: "hk", data: {} });
      expect(Home.right.host).to.equal("10.9.9.9");
      expect(Home.right.port).to.equal(7000);
    });
  });

  describe("reload", () => {
    const data = () => ({
      reference: "new-ref",
      right: { host: "10.2.2.2", port: 6100, isHome: false },
      neighbourhood: { n: {} },
    });

    it("re-reads config and applies the new neighbourhood and reference", async () => {
      let parsed = 0;
      ActiveOptions.parseConfig = () => {
        parsed++;
      };
      ActiveOptions.extendConfig = () =>
        Promise.resolve({ neighbourhood: { some: "thing" } });
      try {
        handler({ type: "reload", data: data() });
        await new Promise((r) => setImmediate(r));
      } finally {
        ActiveOptions.parseConfig = () => undefined;
      }
      expect(parsed).to.equal(1);
      expect(Home.reference).to.equal("new-ref");
      expect(Home.right.host).to.equal("10.2.2.2");
    });

    it("leaves the neighbourhood alone when the config carries none", async () => {
      ActiveOptions.extendConfig = () => Promise.resolve({});
      handler({ type: "reload", data: data() });
      await new Promise((r) => setImmediate(r));
      expect(Home.reference).to.equal("self-ref");
      expect(Home.right.host).to.not.equal("10.2.2.2");
    });

    it("survives an unreadable config.json and still reloads the neighbourhood", async () => {
      ActiveOptions.parseConfig = () => {
        throw new Error("bad json");
      };
      ActiveOptions.extendConfig = () =>
        Promise.resolve({ neighbourhood: true });
      try {
        handler({ type: "reload", data: data() });
        await new Promise((r) => setImmediate(r));
      } finally {
        ActiveOptions.parseConfig = () => undefined;
      }
      expect(
        logged.some((l) => l.level === "error" && l.msg === "Child process failed to re-parse config.json")
      ).to.equal(true);
      expect(Home.reference).to.equal("new-ref");
    });

    it("logs and carries on when the neighbourhood cannot be loaded", async () => {
      ActiveOptions.extendConfig = () => Promise.reject(new Error("db down"));
      handler({ type: "reload", data: data() });
      await new Promise((r) => setImmediate(r));
      expect(
        logged.some((l) => l.level === "info" && l.msg === "Failed to reload Neighbourhood")
      ).to.equal(true);
      expect(Home.reference).to.equal("self-ref");
    });
  });

  // What the Processor has cached for a contract is only visible through what
  // it hands the next protocol it starts for that contract
  let probeCount = 0;
  const cachedFor = (contract: string): { version: any; data: any } => {
    started.length = 0;
    tx(entryFor(`probe-${probeCount++}`, {
      $tx: { $namespace: "ns", $contract: contract, $i: {}, $o: {} },
    }));
    return { version: started[0][0], data: started[0][1] };
  };

  describe("contract caches", () => {
    beforeEach(() => {
      handler({ type: "contractLatestVersion", data: { refresh: true } });
    });

    it("remembers the latest version the host announces", () => {
      handler({
        type: "contractLatestVersion",
        data: { contract: "abc", file: "abc@1.0.0" },
      });
      expect(cachedFor("abc").version).to.equal("abc@1.0.0");
      expect(cachedFor("other").version).to.equal(undefined);
    });

    it("a refresh for one contract drops it and anything that references it", () => {
      const cleared: any[] = [];
      (ActiveProtocol.Process as any).clearContractPathCache = (c?: string) =>
        cleared.push(c);
      for (const [contract, file] of [
        ["abc", "abc@1.0.0"],
        ["abc@=1.0.0", "abc@1.0.0"],
        ["other", "other@2.0.0"],
        ["refs", "x-abc@1.0.0"],
      ]) {
        handler({ type: "contractLatestVersion", data: { contract, file } });
      }
      handler({
        type: "contractLatestVersion",
        data: { refresh: true, contract: "abc", file: "abc@1.1.0" },
      });
      expect(cachedFor("abc").version).to.equal("abc@1.1.0");
      expect(cachedFor("abc@=1.0.0").version).to.equal(undefined);
      expect(cachedFor("refs").version).to.equal(undefined);
      expect(cachedFor("other").version).to.equal("other@2.0.0");
      expect(cleared).to.deep.equal(["abc"]);
    });

    it("a refresh without a contract empties the whole cache", () => {
      const cleared: any[] = [];
      (ActiveProtocol.Process as any).clearContractPathCache = (c?: string) =>
        cleared.push(c);
      handler({ type: "contractLatestVersion", data: { contract: "a", file: "a@1" } });
      handler({ type: "contractLatestVersion", data: { contract: "b", file: "b@1" } });
      handler({ type: "contractLatestVersion", data: { refresh: true } });
      expect(cachedFor("a").version).to.equal(undefined);
      expect(cachedFor("b").version).to.equal(undefined);
      expect(cleared).to.deep.equal([undefined]);
    });

    it("stores contract data pushed by the host", () => {
      handler({ type: "contractData", data: { contract: "cd1", data: { n: 1 } } });
      expect(cachedFor("cd1").data).to.deep.equal({ n: 1 });
    });
  });

  describe("tx", () => {
    it("starts the protocol with the cached version and data for the contract", () => {
      handler({
        type: "contractLatestVersion",
        data: { contract: "contractid", file: "contractid@1.2.3" },
      });
      handler({
        type: "contractData",
        data: { contract: "contractid", data: { _id: "x", data: {} } },
      });
      started.length = 0;
      const p = tx(entryFor("u1"));
      expect(p).to.be.instanceOf(ActiveProtocol.Process);
      expect(started).to.have.length(1);
      expect(started[0][0]).to.equal("contractid@1.2.3");
      expect(started[0][1]).to.deep.equal({ _id: "x", data: {} });
      handler({ type: "contractData", data: { contract: "contractid", data: null } });
    });

    it("looks contract data up by the first 64 characters of the contract id", () => {
      const long = "a".repeat(64) + "@=1.0.0";
      handler({ type: "contractData", data: { contract: "a".repeat(64), data: { d: 1 } } });
      const c = cachedFor(long);
      expect(c.data).to.deep.equal({ d: 1 });
      expect(c.version).to.equal(undefined);
      handler({ type: "contractData", data: { contract: "a".repeat(64), data: null } });
    });

    it("registers one rejection listener per transaction and removes it on destroy", () => {
      const before = rejectionListeners().length;
      const p = tx(entryFor("u3"));
      expect(rejectionListeners().length).to.equal(before + 1);
      handler({ type: "destory", data: { umid: "u3", skipTimeout: true } });
      expect(rejectionListeners().length).to.equal(before);
      expect(destroyed).to.deep.equal(["u3"]);
      // And its protocol no longer reports to the host
      p.emit("broadcast");
      expect(sent).to.deep.equal([]);
    });

    describe("commited", () => {
      it("sends the outcome to the host and schedules a delayed clear", () => {
        const e = entryFor("c1", {
          $nodes: { n: { vote: true } },
          $streams: { new: [] },
          $territoriality: "t",
          response: { ok: 1 },
        });
        const p = tx(e);
        p.emit("commited", true);
        expect(lastSent("commited")!.data).to.deep.equal({
          umid: "c1",
          nodes: { n: { vote: true } },
          entry: { $streams: { new: [] }, $territoriality: "t", response: { ok: 1 } },
        });
        expect(timers.map((t) => t.ms)).to.deep.equal([5000]);
        expect(destroyed).to.deep.equal([]);
        timers[0].fn();
        expect(destroyed).to.deep.equal(["c1"]);
        p.emit("broadcast");
        expect(sent.filter((m) => m.type === "broadcast")).to.have.length(0);
      });

      it("tells the host about a contract upgrade so caches refresh", () => {
        const e = entryFor("c2", {
          $tx: {
            $namespace: "default",
            $contract: "contract",
            $entry: "update",
            $i: { owner: { version: "2.0.0" } },
            $o: { newcontractid: {} },
          },
        });
        tx(e).emit("commited", true);
        expect(lastSent("contractLatestVersion")!.data).to.deep.equal({
          contract: "newcontractid",
          file: "newcontractid@2.0.0",
          refresh: true,
        });
        expect(lastSent("commited")).to.not.equal(undefined);
      });

      it("does not announce a version for other contract calls", () => {
        tx(entryFor("c3")).emit("commited", true);
        expect(lastSent("contractLatestVersion")).to.equal(undefined);
      });
    });

    describe("failed", () => {
      it("records the error against this node and clears a non-broadcast tx", () => {
        const e = entryFor("f1");
        tx(e).emit("failed", { error: new Error("boom") });
        expect(e.$nodes["self-ref"]).to.deep.equal({
          vote: false,
          commit: false,
          error: "Error: boom",
        });
        expect(lastSent("commited")!.data).to.deep.equal({
          umid: "f1",
          nodes: e.$nodes,
        });
        expect(timers).to.have.length(1);
      });

      it("overwrites an error this node already recorded without resetting its vote", () => {
        const e = entryFor("f2", {
          $nodes: { "self-ref": { vote: true, commit: false, error: "old" } },
        });
        tx(e).emit("failed", { error: "new failure" });
        expect(e.$nodes["self-ref"]).to.deep.equal({
          vote: true,
          commit: false,
          error: "new failure",
        });
      });

      it("keeps a broadcast transaction alive for the rest of the network", () => {
        const e = entryFor("f3", { $broadcast: true });
        tx(e).emit("failed", { error: new Error("x") });
        expect(lastSent("commited")).to.not.equal(undefined);
        expect(timers).to.have.length(0);
      });

      it("records nothing against a node when the reference is unknown", () => {
        Home.reference = undefined as any;
        const e = entryFor("f4");
        tx(e).emit("failed", { error: new Error("x") });
        expect(e.$nodes).to.deep.equal({});
        expect(lastSent("commited")).to.not.equal(undefined);
      });

      it("drops the cached contract data so the next run refetches it", () => {
        handler({ type: "contractData", data: { contract: "contractid", data: { data: 1 } } });
        sent.length = 0;
        tx(entryFor("f5")).emit("failed", { error: new Error("x") });
        expect(
          sent.find((m) => m.type === "contractData")!.data
        ).to.deep.equal({ contract: "contractid", data: null });
      });

      it("does not send a data reset when nothing was cached", () => {
        handler({ type: "contractData", data: { contract: "contractid", data: null } });
        sent.length = 0;
        tx(entryFor("f6")).emit("failed", { error: new Error("x") });
        expect(sent.some((m) => m.type === "contractData")).to.equal(false);
      });
    });

    describe("events relayed to the host", () => {
      it("broadcast carries nodes, revs and the early flag", () => {
        const e = entryFor("b1", { $nodes: { a: {} }, $revs: { s: "1-x" } });
        const p = tx(e);
        p.emit("broadcast", true);
        p.emit("broadcast");
        const bs = sent.filter((m) => m.type === "broadcast");
        expect(bs.map((b) => b.data)).to.deep.equal([
          { umid: "b1", nodes: { a: {} }, revs: { s: "1-x" }, early: true },
          { umid: "b1", nodes: { a: {} }, revs: { s: "1-x" }, early: false },
        ]);
      });

      it("reload asks the host to reload for this transaction", () => {
        tx(entryFor("r1")).emit("reload");
        expect(lastSent("reload")!.data).to.deep.equal({ umid: "r1" });
      });

      it("contractLatestVersion is cached and forwarded", () => {
        const r = { contract: "k", file: "k@1.0.0" };
        tx(entryFor("v1")).emit("contractLatestVersion", r);
        expect(cachedFor("k").version).to.equal("k@1.0.0");
        handler({ type: "contractLatestVersion", data: { refresh: true } });
        expect(lastSent("contractLatestVersion")!.data).to.deep.equal(r);
      });

      it("contractData is cached and forwarded", () => {
        const r = { contract: "k", data: { d: 1 } };
        tx(entryFor("v2")).emit("contractData", r);
        expect(cachedFor("k").data).to.deep.equal({ d: 1 });
        handler({ type: "contractData", data: { contract: "k", data: null } });
        expect(lastSent("contractData")!.data).to.deep.equal(r);
      });

      it("empty contract responses are ignored", () => {
        const p = tx(entryFor("v3"));
        p.emit("contractLatestVersion", undefined);
        p.emit("contractData", undefined);
        expect(sent).to.deep.equal([]);
      });
    });

    describe("unhandled rejections", () => {
      const listenerFor = (umid: string) => rejection[umid];

      it("is reported once, recoverably, with the error recorded for this node", () => {
        const e = entryFor("x1");
        tx(e);
        const err = new Error("kaboom");
        listenerFor("x1")(err);
        listenerFor("x1")(err);

        const out = sent.filter((m) => m.type === "unhandledrejection");
        expect(out).to.have.length(1);
        expect(out[0].data.umid).to.equal("x1");
        expect(out[0].data.recoverable).to.equal(true);
        expect(e.$nodes["self-ref"].vote).to.equal(false);
        expect(e.$nodes["self-ref"].commit).to.equal(false);
        expect(e.$nodes["self-ref"].error).to.match(
          /^\(Unhandled Contract Error\) \{/
        );
        expect(logged.filter((l) => l.level === "warn")).to.have.length(1);
        expect(logged[0].obj.message).to.equal("kaboom");
        expect(logged[0].msg).to.equal("UnhandledRejection - x1");
        expect(timers).to.have.length(1);
      });

      it("overwrites an existing node error but keeps its vote", () => {
        const e = entryFor("x2", {
          $nodes: { "self-ref": { vote: true, commit: false, error: "e" } },
        });
        tx(e);
        listenerFor("x2")(new Error("again"));
        expect(e.$nodes["self-ref"].vote).to.equal(true);
        expect(e.$nodes["self-ref"].error).to.contain("(Unhandled Contract Error)");
      });

      it("keeps a broadcast transaction in memory", () => {
        tx(entryFor("x3", { $broadcast: true }));
        listenerFor("x3")(new Error("b"));
        expect(timers).to.have.length(0);
        expect(lastSent("unhandledrejection")).to.not.equal(undefined);
      });

      it("is not recoverable once the node reference is lost and uses a placeholder node", () => {
        Home.reference = undefined as any;
        const e = entryFor("x4");
        tx(e);
        listenerFor("x4")(new Error("lost"));
        const keys = Object.keys(e.$nodes);
        expect(keys).to.have.length(1);
        expect(keys[0]).to.match(/^NoRef-/);
        expect(e.$nodes[keys[0]].vote).to.equal(false);
        expect(lastSent("unhandledrejection")!.data.recoverable).to.equal(false);
      });

      it("copes with a non-error reason", () => {
        const e = entryFor("x5");
        tx(e);
        listenerFor("x5")(undefined);
        expect(logged[0].obj).to.deep.equal({
          name: "Unknown",
          message: "Unknown",
          stack: "Unknown",
        });
        expect(e.$nodes["self-ref"].error).to.equal(
          '(Unhandled Contract Error) "unknown"'
        );
      });

      it("copes with an entry that has no nodes", () => {
        const e = entryFor("x6");
        tx(e);
        // The Processor's entry can lose its nodes after the protocol is built
        delete e.$nodes;
        listenerFor("x6")(new Error("n"));
        const out = lastSent("unhandledrejection")!.data;
        expect(out.nodes).to.equal(undefined);
        expect(out.recoverable).to.equal(false);
      });

      it("does nothing once the transaction was destroyed", () => {
        tx(entryFor("x7"));
        const fn = listenerFor("x7");
        handler({ type: "destory", data: { umid: "x7", skipTimeout: true } });
        fn(new Error("late"));
        expect(sent.some((m) => m.type === "unhandledrejection")).to.equal(false);
      });
    });
  });

  describe("broadcast", () => {
    it("passes the network's node votes on to the running protocol", () => {
      tx(entryFor("bc1"));
      handler({ type: "broadcast", data: { umid: "bc1", nodes: { a: { vote: true } } } });
      expect(broadcasts).to.deep.equal([{ a: { vote: true } }]);
    });

    it("ignores a broadcast for a transaction this worker does not hold", () => {
      handler({ type: "broadcast", data: { umid: "nope", nodes: {} } });
      expect(broadcasts).to.deep.equal([]);
    });
  });

  describe("destory", () => {
    it("with a timeout defers removal by five seconds", () => {
      tx(entryFor("d1"));
      handler({ type: "destory", data: { umid: "d1" } });
      expect(timers.map((t) => t.ms)).to.deep.equal([5000]);
      expect(destroyed).to.deep.equal([]);
      timers[0].fn();
      expect(destroyed).to.deep.equal(["d1"]);
    });

    it("is harmless for an unknown transaction", () => {
      handler({ type: "destory", data: { umid: "ghost", skipTimeout: true } });
      expect(destroyed).to.deep.equal([]);
    });

    it("strips listeners so a destroyed protocol can no longer report", () => {
      const p = tx(entryFor("d2"));
      handler({ type: "destory", data: { umid: "d2", skipTimeout: true } });
      p.emit("commited", true);
      p.emit("broadcast");
      expect(sent).to.deep.equal([]);
    });
  });
});
