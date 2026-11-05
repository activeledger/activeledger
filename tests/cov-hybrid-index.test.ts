import { expect } from "chai";
import "mocha";
import * as child from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { ActiveCrypto } from "../packages/crypto/src";

/**
 * The activehybrid command line, run in this process against a temporary
 * working directory, with a stand-in for the node's local API.
 */
describe("activehybrid command line (cov)", function () {
  this.timeout(30000);
  const realExit = process.exit;
  const realLog = console.log;
  const realError = console.error;
  const realArgv = process.argv;
  const realCwd = process.cwd();
  let dir: string;
  let out: string[];
  let err: string[];
  let seq = 0;
  let server: http.Server;
  let port: number;
  let seen: { method?: string; url?: string; auth?: string }[];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const kids: child.ChildProcess[] = [];
  const envKeep: Record<string, string | undefined> = {};

  const run = async (args: string[], env: Record<string, string> = {}): Promise<number> => {
    for (const [k, v] of Object.entries(env)) {
      envKeep[k] = process.env[k];
      process.env[k] = v;
    }
    const exited = new Promise<number>((resolve) => {
      (process as any).exit = (c: number) => resolve(c);
    });
    process.argv = [process.argv[0], path.join(dir, "fake-entry.js"), ...args];
    const sigterm = process.listeners("SIGTERM");
    const sigint = process.listeners("SIGINT");
    try {
      await import(`../packages/hybrid/src/index.ts?run${++seq}`);
      return await Promise.race([exited, new Promise<number>((_, rej) => setTimeout(() => rej(new Error("did not exit")), 20000))]);
    } finally {
      for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l)) process.removeListener("SIGTERM", l);
      for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.removeListener("SIGINT", l);
      for (const k of Object.keys(env)) {
        if (envKeep[k] === undefined) delete process.env[k];
        else process.env[k] = envKeep[k];
      }
    }
  };

  const writeConfig = (over: Record<string, any> = {}) =>
    fs.writeFileSync(path.join(dir, "hybrid.json"), JSON.stringify({ upstreams: [{ host: "127.0.0.1", port: 1, transport: "http" }], bind: "127.0.0.1", port, ...over }));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-index-"));
    process.chdir(dir);
    out = [];
    err = [];
    seen = [];
    console.log = (...a: any[]) => void out.push(a.join(" "));
    console.error = (...a: any[]) => void err.push(a.join(" "));
    handler = (_req, res) => res.end("{}");
    server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    (process as any).exit = realExit;
    console.log = realLog;
    console.error = realError;
    process.argv = realArgv;
    process.chdir(realCwd);
    for (const k of kids.splice(0)) {
      try {
        k.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const reply = (status: number, body: any) => {
    handler = (_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
  };

  describe("status", () => {
    beforeEach(() => writeConfig());
    it("prints a ready node's lag and cursor, exit 0", async () => {
      reply(200, { ready: true, lagSeconds: 4, cursor: "umid:9,x" });
      expect(await run(["status"])).to.equal(0);
      expect(out).to.deep.equal(["ready  lag 4s  cursor umid:9,x"]);
      expect(seen[0].url).to.equal("/health");
    });
    it("prints question marks and dashes for what is not known", async () => {
      reply(200, { ready: true, cursor: "" });
      await run(["status"]);
      expect(out).to.deep.equal(["ready  lag ?s  cursor -"]);
    });
    it("marks a node beyond --max-lag, exit 2", async () => {
      reply(200, { ready: true, lagSeconds: 30, cursor: "c" });
      expect(await run(["status", "--max-lag", "10"])).to.equal(2);
      expect(out).to.deep.equal(["ready  lag 30s  cursor c  (lagging)"]);
    });
    it("says why a node is not ready, exit 2", async () => {
      reply(503, { ready: false, reason: "catching up" });
      expect(await run(["status"])).to.equal(2);
      expect(out).to.deep.equal(["not ready: catching up"]);
    });
    it("says 'unknown' when there is no reason", async () => {
      reply(503, { ready: false });
      await run(["status"]);
      expect(out).to.deep.equal(["not ready: unknown"]);
    });
    it("prints the body as JSON with --json", async () => {
      reply(200, { ready: true, lagSeconds: 1, cursor: "c" });
      await run(["status", "--json"]);
      expect(JSON.parse(out[0])).to.deep.equal({ ready: true, lagSeconds: 1, cursor: "c" });
    });
    it("sends the configured token", async () => {
      writeConfig({ token: "tok" });
      await run(["status"]);
      expect(seen[0].auth).to.equal("Bearer tok");
    });
    it("reaches a wildcard bind on loopback", async () => {
      writeConfig({ bind: "0.0.0.0" });
      reply(200, { ready: true, lagSeconds: 0, cursor: "c" });
      expect(await run(["status"])).to.equal(0);
    });
    it("reports a node that is not running, exit 2", async () => {
      await new Promise((r) => server.close(r));
      expect(await run(["status"])).to.equal(2);
      expect(out).to.deep.equal(["not ready: not running"]);
    });
    it("reports an invalid config, exit 1, as text or JSON", async () => {
      fs.writeFileSync(path.join(dir, "hybrid.json"), JSON.stringify({ port: "x" }));
      expect(await run(["status"])).to.equal(1);
      expect(err.join("\n")).to.contain("port: expected an integer");
      err.length = 0;
      expect(await run(["status", "--json"])).to.equal(1);
      expect(JSON.parse(err[0]).error[0]).to.contain("port: expected an integer");
    });
    it("reports a config that is not there", async () => {
      fs.rmSync(path.join(dir, "hybrid.json"));
      expect(await run(["status"])).to.equal(1);
      expect(err.length).to.equal(1);
    });
  });

  describe("divergences and prune", () => {
    beforeEach(() => writeConfig({ token: "t" }));
    it("lists divergence records, one per line", async () => {
      reply(200, [{ at: "2026-01-01T00:00:00Z", kind: "state", umid: "u1" }, { at: "2026-01-02T00:00:00Z", kind: "umid-doc-mismatch", umid: "u2" }]);
      expect(await run(["divergences"])).to.equal(0);
      expect(out).to.deep.equal(["2026-01-01T00:00:00Z  state  u1\n2026-01-02T00:00:00Z  umid-doc-mismatch  u2"]);
      expect(seen[0]).to.deep.equal({ method: "GET", url: "/divergences", auth: "Bearer t" });
    });
    it("says so when there are none, and passes --since along encoded", async () => {
      reply(200, []);
      await run(["divergences", "--since", "2026-01-01 10:00"]);
      expect(out).to.deep.equal(["no divergences"]);
      expect(seen[0].url).to.equal("/divergences?since=2026-01-01%2010%3A00");
    });
    it("prints JSON as it came", async () => {
      reply(200, [{ at: "a", kind: "k", umid: "u" }]);
      await run(["divergences", "--json"]);
      expect(JSON.parse(out[0])).to.deep.equal([{ at: "a", kind: "k", umid: "u" }]);
    });
    it("reports the node's error and exits 1", async () => {
      reply(401, { error: "Unauthorized" });
      expect(await run(["divergences"])).to.equal(1);
      expect(err).to.deep.equal(["Unauthorized"]);
      expect(out).to.deep.equal([]);
    });
    it("falls back to the HTTP status", async () => {
      reply(500, null);
      expect(await run(["divergences"])).to.equal(1);
      expect(err).to.deep.equal(["HTTP 500"]);
    });
    it("reports a node it cannot reach, exit 2", async () => {
      await new Promise((r) => server.close(r));
      expect(await run(["divergences"])).to.equal(2);
      expect(err[0]).to.match(/^could not reach the node: /);
    });
    it("prune asks the node to prune and reports the counts", async () => {
      reply(200, { dryRun: false, umids: { pruned: 3 }, events: { pruned: 5 } });
      expect(await run(["prune"])).to.equal(0);
      expect(out).to.deep.equal(["pruned 3 umid docs and 5 events"]);
      expect(seen[0]).to.deep.equal({ method: "POST", url: "/prune", auth: "Bearer t" });
    });
    it("prune --dry-run only says what it would do", async () => {
      reply(200, { dryRun: true, umids: { pruned: 1 }, events: { pruned: 2 } });
      await run(["prune", "--dry-run"]);
      expect(out).to.deep.equal(["would prune 1 umid docs and 2 events"]);
      expect(seen[0].url).to.equal("/prune?dryRun=true");
    });
  });

  describe("commands run in place", () => {
    it("init writes the identity and config, check-config accepts it, token prints a new one", async () => {
      expect(await run(["init", "--upstream", "127.0.0.1:5260"])).to.equal(0);
      expect(fs.existsSync(path.join(dir, ".identity"))).to.equal(true);
      expect(fs.existsSync(path.join(dir, "hybrid.json"))).to.equal(true);
      out.length = 0;
      expect(await run(["check-config"])).to.equal(0);
      expect(out.join()).to.contain("is valid");
      out.length = 0;
      expect(await run(["token"])).to.equal(0);
      expect(out[0]).to.match(/^[0-9a-f]{32,}$/);
    });
    it("check-config says what is wrong, exit 2", async () => {
      fs.writeFileSync(path.join(dir, "hybrid.json"), JSON.stringify({ bogus: 1 }));
      expect(await run(["check-config"])).to.equal(2);
      expect(err.join()).to.contain("bogus");
    });
    it("register, update, retire, peers and pin fail cleanly with no upstream to ask", async () => {
      await run(["init", "--upstream", "127.0.0.1:1"]);
      for (const cmd of [["register", "--endpoint", "p2p://h.example:5271"], ["update", "--endpoint", "p2p://h.example:5271"], ["retire", "--yes"], ["peers"], ["pin"]]) {
        err.length = 0;
        const code = await run(cmd);
        expect(code, cmd[0]).to.not.equal(0);
        expect(err.length, cmd[0]).to.be.greaterThan(0);
      }
    });
    it("stop says it is not running when there is no node, exit 0", async () => {
      expect(await run(["stop"])).to.equal(0);
      expect(out).to.deep.equal(["not running"]);
    });
    it("restart does not start a node when the stop failed", async () => {
      const k = child.spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      kids.push(k);
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(dir, ".activehybrid.pid"), String(k.pid));
      expect(await run(["restart", "--timeout", "1"])).to.equal(1);
      expect(err.join()).to.contain("did not exit within 1s");
      expect(fs.existsSync(path.join(dir, "activehybrid.log"))).to.equal(false);
    });
    it("an unknown command or flag is refused by the parser", async () => {
      const code = await run(["no-such-command"]);
      expect(code).to.not.equal(0);
    });
  });

  describe("start", () => {
    it("refuses when a node is already running", async () => {
      writeConfig();
      fs.writeFileSync(path.join(dir, ".activehybrid.pid"), String(process.pid));
      expect(await run(["start"])).to.equal(1);
      expect(err).to.deep.equal([`already running (pid ${process.pid})`]);
    });

    it("as the detached node, reports a bad config through the state file", async () => {
      fs.writeFileSync(path.join(dir, "hybrid.json"), JSON.stringify({ port: 0 }));
      expect(await run(["start", "--foreground"], { ACTIVEHYBRID_CHILD: "1" })).to.equal(1);
      const state = JSON.parse(fs.readFileSync(path.join(dir, ".activehybrid.state"), "utf8"));
      expect(state.step).to.equal("config");
      expect(state.event).to.equal("fail");
      expect(state.detail).to.contain("port: expected an integer");
      expect(state.error).to.equal(state.detail);
      expect(err.join()).to.contain("port: expected an integer");
    });

    it("as the detached node, refuses when another live node holds the pid file", async () => {
      writeConfig();
      const k = child.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      kids.push(k);
      fs.writeFileSync(path.join(dir, ".activehybrid.pid"), String(k.pid));
      expect(await run(["start", "--foreground"], { ACTIVEHYBRID_CHILD: "1" })).to.equal(1);
      expect(err).to.deep.equal([`already running (pid ${k.pid})`]);
      expect(JSON.parse(fs.readFileSync(path.join(dir, ".activehybrid.state"), "utf8"))).to.deep.equal({ error: `already running (pid ${k.pid})` });
      expect(fs.readFileSync(path.join(dir, ".activehybrid.pid"), "utf8")).to.equal(String(k.pid));
    });

    it("in the foreground, shows an invalid config and exits 1 without a state file", async () => {
      fs.writeFileSync(path.join(dir, "hybrid.json"), JSON.stringify({ port: 0 }));
      expect(await run(["start", "--foreground", "--quiet"])).to.equal(1);
      expect(err.join()).to.contain("port: expected an integer");
      expect(fs.existsSync(path.join(dir, ".activehybrid.state"))).to.equal(false);
    });

    it("as the detached node, exits 2 and releases the pid when every upstream refuses the key", async () => {
      await run(["init", "--upstream", `127.0.0.1:${port}`]);
      reply(403, { reason: "not registered" });
      const code = await run(["start", "--foreground", "--port", "5299"], { ACTIVEHYBRID_CHILD: "1" });
      expect(code).to.equal(2);
      const state = JSON.parse(fs.readFileSync(path.join(dir, ".activehybrid.state"), "utf8"));
      expect(state.error).to.contain("Every upstream refused this key");
      expect(fs.existsSync(path.join(dir, ".activehybrid.pid"))).to.equal(false);
      expect(seen.length).to.be.greaterThan(0);
      expect(seen[0].url).to.equal("/h/bootstrap");
    });

    it("as the detached node, exits 1 when no upstream can be reached", async () => {
      await run(["init", "--upstream", "127.0.0.1:1"]);
      const code = await run(["start", "--foreground", "--port", "5299"], { ACTIVEHYBRID_CHILD: "1" });
      expect(code).to.equal(1);
      const state = JSON.parse(fs.readFileSync(path.join(dir, ".activehybrid.state"), "utf8"));
      expect(state.error).to.contain("Could not bootstrap from any upstream");
      expect(fs.existsSync(path.join(dir, ".activehybrid.pid"))).to.equal(false);
    });

    it("in the foreground, prints the failure rather than a state file", async () => {
      await run(["init", "--upstream", "127.0.0.1:1"]);
      const code = await run(["start", "--foreground", "--port", "5299", "--quiet"]);
      expect(code).to.equal(1);
      expect(fs.existsSync(path.join(dir, ".activehybrid.state"))).to.equal(false);
      expect(fs.existsSync(path.join(dir, ".activehybrid.pid"))).to.equal(false);
    });

    describe("a node that comes up", () => {
      let up: http.Server;
      let upPort: number;
      let nodePort: number;
      const freePort = async () => {
        const s = http.createServer();
        await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
        const p = (s.address() as AddressInfo).port;
        await new Promise((r) => s.close(r));
        return p;
      };
      beforeEach(async () => {
        const nodeKey = new ActiveCrypto.KeyPair("rsa").generate().pub.pkcs8pem;
        const setup = { _id: "setup", _rev: "2-s", neighbourhood: [{ host: "h", port: 1, identity: { type: "rsa", public: nodeKey } }], consensus: { reached: 60 } };
        up = http.createServer((req, res) => {
          const url = new URL(req.url as string, "http://x");
          const json = (b: any) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(b)));
          if (url.pathname === "/h/bootstrap") return json({ setup, required: [], contracts: [], cursor: "umid:5,u5", minVersion: "5.1.0" });
          if (url.pathname === "/h/head") return json({ cursor: "umid:5,u5", time: Date.now() });
          if (url.pathname === "/h/feed") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ head: "umid:5,u5", time: Date.now() })}\n\n`);
            return; // idle
          }
          if (url.pathname === "/h/streams") return json({ docs: [], missing: [] });
          res.writeHead(404);
          res.end("{}");
        });
        await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
        upPort = (up.address() as AddressInfo).port;
        nodePort = await freePort();
      });
      afterEach(async () => {
        up.closeAllConnections();
        await new Promise((r) => up.close(r));
      });
      const health = () =>
        new Promise<any>((resolve) => {
          http.get({ host: "127.0.0.1", port: nodePort, path: "/health" }, (res) => {
            let t = "";
            res.on("data", (c) => (t += c));
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(t) }));
          }).on("error", () => resolve(undefined));
        });
      const untilReady = async () => {
        for (let i = 0; i < 200; i++) {
          const h = await health();
          if (h?.body?.ready) return h;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("never became ready");
      };

      for (const detached of [true, false]) {
        it(`${detached ? "as the detached node" : "in the foreground"} serves, says it is ready, and stops cleanly on SIGTERM`, async () => {
          await run(["init", "--upstream", `127.0.0.1:${upPort}`]);
          const exited = run(["start", "--foreground", "--quiet", "--port", String(nodePort)], detached ? { ACTIVEHYBRID_CHILD: "1" } : {});
          const h = await untilReady();
          expect(h.status).to.equal(200);
          expect(fs.readFileSync(path.join(dir, ".activehybrid.pid"), "utf8")).to.equal(String(process.pid));
          if (detached) {
            const state = JSON.parse(fs.readFileSync(path.join(dir, ".activehybrid.state"), "utf8"));
            expect(state).to.deep.include({ ready: true, step: "ready", event: "done" });
          } else {
            expect(fs.existsSync(path.join(dir, ".activehybrid.state"))).to.equal(false);
          }
          process.emit(detached ? "SIGTERM" : "SIGINT", detached ? "SIGTERM" : "SIGINT");
          expect(await exited).to.equal(0);
          expect(fs.existsSync(path.join(dir, ".activehybrid.pid"))).to.equal(false);
          expect(await health()).to.equal(undefined);
        });
      }
    });

    it("reports an error that escapes a command, exit 1", async () => {
      writeConfig();
      fs.mkdirSync(path.join(dir, "activehybrid.log"));
      expect(await run(["start", "--quiet"])).to.equal(1);
      expect(err.join()).to.contain("EISDIR");
    });

    describe("detaching", () => {
      const entry = (script: string) => fs.writeFileSync(path.join(dir, "fake-entry.js"), script);
      it("starts the node in the background with --foreground and follows it to ready", async () => {
        writeConfig();
        entry(`
          const fs = require("fs");
          fs.writeFileSync("spawned.json", JSON.stringify({ argv: process.argv.slice(2), child: process.env.ACTIVEHYBRID_CHILD, noColor: process.env.NO_COLOR }));
          fs.writeFileSync(".activehybrid.state", JSON.stringify({ ready: true, step: "ready", event: "done" }));
        `);
        expect(await run(["start", "--config", "hybrid.json", "--quiet"])).to.equal(0);
        await new Promise((r) => setTimeout(r, 300));
        const spawned = JSON.parse(fs.readFileSync(path.join(dir, "spawned.json"), "utf8"));
        expect(spawned.argv).to.deep.equal(["start", "--foreground", "--config", "hybrid.json", "--quiet"]);
        expect(spawned.child).to.equal("1");
        expect(spawned.noColor).to.equal("1");
        expect(fs.existsSync(path.join(dir, "activehybrid.log"))).to.equal(true);
      });
      it("drops a --foreground it was given so the child has it once", async () => {
        writeConfig();
        entry(`
          const fs = require("fs");
          fs.writeFileSync("spawned.json", JSON.stringify({ argv: process.argv.slice(2) }));
          fs.writeFileSync(".activehybrid.state", JSON.stringify({ ready: true }));
        `);
        // not detached by the flag, so give it the default command
        expect(await run(["--quiet"])).to.equal(0);
        await new Promise((r) => setTimeout(r, 300));
        const spawned = JSON.parse(fs.readFileSync(path.join(dir, "spawned.json"), "utf8"));
        expect(spawned.argv.filter((a: string) => a === "--foreground").length).to.equal(1);
        expect(spawned.argv[0]).to.equal("start");
      });
      it("exits 1 when the node dies before it is ready, clearing an old state file first", async () => {
        writeConfig();
        fs.writeFileSync(path.join(dir, ".activehybrid.state"), JSON.stringify({ ready: true }));
        entry(`process.exit(0)`);
        expect(await run(["start", "--quiet"])).to.equal(1);
      });
    });
  });
});
