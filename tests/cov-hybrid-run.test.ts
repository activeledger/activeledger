import { expect } from "chai";
import "mocha";
import * as child from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  alive,
  claimPid,
  followStart,
  nodeRequest,
  readPid,
  readState,
  releasePid,
  runningPid,
  statusOf,
  stopNode,
  waitForExit,
  writeState,
} from "../packages/hybrid/src/run";

describe("Hybrid run: process control (cov)", () => {
  let dir: string;
  const kids: child.ChildProcess[] = [];
  const f = (n: string) => path.join(dir, n);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-run-"));
  });
  afterEach(() => {
    for (const k of kids.splice(0)) {
      try {
        k.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spawnNode = (script: string) => {
    const k = child.spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    kids.push(k);
    return k;
  };
  const DEAD = 2 ** 22 + 12345;

  describe("state file", () => {
    it("is written whole, and no temporary file is left behind", () => {
      writeState(f("s"), { step: "x", event: "begin", lag: 3 });
      expect(readState(f("s"))).to.deep.equal({ step: "x", event: "begin", lag: 3 });
      expect(fs.readdirSync(dir)).to.deep.equal(["s"]);
      writeState(f("s"), { ready: true });
      expect(readState(f("s"))).to.deep.equal({ ready: true });
    });
    it("reads as nothing when missing or half written", () => {
      expect(readState(f("none"))).to.equal(undefined);
      fs.writeFileSync(f("bad"), '{"step":');
      expect(readState(f("bad"))).to.equal(undefined);
    });
  });

  describe("alive", () => {
    it("is true for this process and false for one that does not exist", () => {
      expect(alive(process.pid)).to.equal(true);
      expect(alive(DEAD)).to.equal(false);
    });
    it("counts a process that exists but is not ours as alive", () => {
      const kill = process.kill;
      (process as any).kill = () => {
        throw Object.assign(new Error("nope"), { code: "EPERM" });
      };
      try {
        expect(alive(1)).to.equal(true);
      } finally {
        (process as any).kill = kill;
      }
    });
    it("does not count other errors as alive", () => {
      const kill = process.kill;
      (process as any).kill = () => {
        throw Object.assign(new Error("odd"), { code: "EINVAL" });
      };
      try {
        expect(alive(1)).to.equal(false);
      } finally {
        (process as any).kill = kill;
      }
    });
  });

  describe("pid file", () => {
    it("reads a positive integer and nothing else", () => {
      fs.writeFileSync(f("p"), " 4242\n");
      expect(readPid(f("p"))).to.equal(4242);
      for (const bad of ["abc", "0", "-5", "", "1.5x"]) {
        fs.writeFileSync(f("p"), bad);
        expect(readPid(f("p")), bad).to.equal(bad === "1.5x" ? 1 : undefined);
      }
      expect(readPid(f("missing"))).to.equal(undefined);
    });
    it("runningPid returns a live pid and removes a stale file", () => {
      fs.writeFileSync(f("p"), String(process.pid));
      expect(runningPid(f("p"))).to.equal(process.pid);
      expect(fs.existsSync(f("p"))).to.equal(true);
      fs.writeFileSync(f("p"), String(DEAD));
      expect(runningPid(f("p"))).to.equal(undefined);
      expect(fs.existsSync(f("p"))).to.equal(false);
      expect(runningPid(f("none"))).to.equal(undefined);
    });
    it("claimPid takes a free file, a stale one and its own", () => {
      expect(claimPid(process.pid, f("p"))).to.equal(true);
      expect(fs.readFileSync(f("p"), "utf8")).to.equal(String(process.pid));
      expect(claimPid(process.pid, f("p"))).to.equal(true);
      fs.writeFileSync(f("p"), String(DEAD));
      expect(claimPid(process.pid, f("p"))).to.equal(true);
      expect(readPid(f("p"))).to.equal(process.pid);
    });
    it("claimPid refuses while another live process holds it, leaving the file", () => {
      const k = spawnNode("setInterval(()=>{},1000)");
      fs.writeFileSync(f("p"), String(k.pid));
      expect(claimPid(process.pid, f("p"))).to.equal(false);
      expect(readPid(f("p"))).to.equal(k.pid);
    });
    it("claimPid fails when the file cannot be written", () => {
      expect(claimPid(process.pid, path.join(dir, "no", "such", "dir", "p"))).to.equal(false);
    });
    it("releasePid removes the file only if it holds this pid", () => {
      fs.writeFileSync(f("p"), "999999");
      releasePid(process.pid, f("p"));
      expect(fs.existsSync(f("p"))).to.equal(true);
      fs.writeFileSync(f("p"), String(process.pid));
      releasePid(process.pid, f("p"));
      expect(fs.existsSync(f("p"))).to.equal(false);
    });
  });

  describe("waitForExit", () => {
    it("is true at once for a process that is gone", async () => {
      expect(await waitForExit(DEAD, 5)).to.equal(true);
    });
    it("is false when a live process outlasts the wait", async () => {
      const t0 = Date.now();
      expect(await waitForExit(process.pid, 0.25)).to.equal(false);
      expect(Date.now() - t0).to.be.at.least(240);
    });
    it("is true once the process exits within the wait", async () => {
      const k = spawnNode("setTimeout(()=>{},300)");
      expect(await waitForExit(k.pid as number, 5)).to.equal(true);
    });
  });

  describe("stopNode", () => {
    const out = () => {
      const logs: string[] = [];
      const errors: string[] = [];
      return { logs, errors, o: { log: (t: string) => logs.push(t), error: (t: string) => errors.push(t) } };
    };
    it("says it is not running, as text or JSON, and succeeds", async () => {
      const a = out();
      expect(await stopNode(1, a.o, false, f("p"))).to.equal(0);
      expect(a.logs).to.deep.equal(["not running"]);
      const b = out();
      expect(await stopNode(1, b.o, true, f("p"))).to.equal(0);
      expect(JSON.parse(b.logs[0])).to.deep.equal({ stopped: false, running: false });
    });
    it("stops a running node with SIGTERM, removes the pid file and reports its pid", async () => {
      const k = spawnNode("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)");
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(f("p"), String(k.pid));
      const a = out();
      expect(await stopNode(5, a.o, false, f("p"))).to.equal(0);
      expect(a.logs).to.deep.equal([`stopped ${k.pid}`]);
      expect(fs.existsSync(f("p"))).to.equal(false);
      expect(alive(k.pid as number)).to.equal(false);
    });
    it("reports stopped as JSON", async () => {
      const k = spawnNode("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)");
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(f("p"), String(k.pid));
      const a = out();
      await stopNode(5, a.o, true, f("p"));
      expect(JSON.parse(a.logs[0])).to.deep.equal({ stopped: true, pid: k.pid });
    });
    it("fails, keeping the pid file, when the node will not exit in time", async () => {
      const k = spawnNode("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(f("p"), String(k.pid));
      const a = out();
      expect(await stopNode(0.3, a.o, false, f("p"))).to.equal(1);
      expect(a.errors).to.deep.equal([`process ${k.pid} did not exit within 0.3s`]);
      expect(a.logs).to.deep.equal([]);
      expect(fs.existsSync(f("p"))).to.equal(true);
    });
  });

  describe("requests of a running node", () => {
    let server: http.Server;
    let port: number;
    let seen: http.IncomingMessage[];
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    beforeEach(async () => {
      seen = [];
      handler = (_req, res) => res.end("{}");
      server = http.createServer((req, res) => (seen.push(req), handler(req, res)));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const reply = (status: number, body: string) => {
      handler = (_req, res) => {
        res.writeHead(status);
        res.end(body);
      };
    };

    it("nodeRequest returns the status and parsed body, with the method and path used", async () => {
      reply(201, '{"a":1}');
      const r = await nodeRequest("127.0.0.1", port, "POST", "/prune?dryRun=true");
      expect(r).to.deep.equal({ status: 201, body: { a: 1 } });
      expect(seen[0].method).to.equal("POST");
      expect(seen[0].url).to.equal("/prune?dryRun=true");
      expect(seen[0].headers.authorization).to.equal(undefined);
    });
    it("nodeRequest sends the token as a bearer", async () => {
      await nodeRequest("127.0.0.1", port, "GET", "/health", "s3cret");
      expect(seen[0].headers.authorization).to.equal("Bearer s3cret");
    });
    it("nodeRequest gives a null body for an empty one", async () => {
      reply(204, "");
      expect(await nodeRequest("127.0.0.1", port, "GET", "/x")).to.deep.equal({ status: 204, body: null });
    });
    it("nodeRequest rejects a body that is not JSON, naming the path", async () => {
      reply(200, "<html>");
      let err: any;
      await nodeRequest("127.0.0.1", port, "GET", "/divergences").catch((e) => (err = e));
      expect(err.message).to.equal("not JSON from /divergences");
    });
    it("nodeRequest times out on a node that never answers", async () => {
      handler = () => undefined;
      let err: any;
      await nodeRequest("127.0.0.1", port, "GET", "/x", undefined, 100).catch((e) => (err = e));
      expect(err.message).to.equal("timed out");
    });
    it("nodeRequest rejects when nothing is listening", async () => {
      const dead = http.createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
      const p = (dead.address() as AddressInfo).port;
      await new Promise((r) => dead.close(r));
      let err: any;
      await nodeRequest("127.0.0.1", p, "GET", "/x").catch((e) => (err = e));
      expect(err.code).to.equal("ECONNREFUSED");
    });

    describe("statusOf", () => {
      const health = (status: number, body: any) => reply(status, JSON.stringify(body));
      it("is 0 for a ready node", async () => {
        health(200, { ready: true, lagSeconds: 1 });
        expect(await statusOf("127.0.0.1", port, undefined, undefined)).to.deep.equal({ code: 0, body: { ready: true, lagSeconds: 1 } });
      });
      it("is 2 for a node that is not ready, and for a non-200 even if ready", async () => {
        health(503, { ready: false, reason: "starting" });
        expect((await statusOf("127.0.0.1", port, undefined, undefined)).code).to.equal(2);
        health(503, { ready: true });
        expect((await statusOf("127.0.0.1", port, undefined, undefined)).code).to.equal(2);
        health(200, { ready: false });
        expect((await statusOf("127.0.0.1", port, undefined, undefined)).code).to.equal(2);
      });
      it("is 2 with 'not running' when it cannot be reached", async () => {
        const dead = http.createServer();
        await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
        const p = (dead.address() as AddressInfo).port;
        await new Promise((r) => dead.close(r));
        expect(await statusOf("127.0.0.1", p, undefined, undefined)).to.deep.equal({ code: 2, body: { ready: false, reason: "not running" } });
      });
      it("holds the lag to --max-lag, marking a lagging node", async () => {
        health(200, { ready: true, lagSeconds: 10 });
        expect(await statusOf("127.0.0.1", port, undefined, 10)).to.deep.equal({ code: 0, body: { ready: true, lagSeconds: 10 } });
        const over = await statusOf("127.0.0.1", port, undefined, 9);
        expect(over.code).to.equal(2);
        expect(over.body).to.deep.equal({ ready: true, lagSeconds: 10, reason: "lagging" });
      });
      it("counts an unknown lag as beyond any limit", async () => {
        health(200, { ready: true, lagSeconds: null });
        expect((await statusOf("127.0.0.1", port, undefined, 1000)).code).to.equal(2);
        health(200, { ready: true });
        expect((await statusOf("127.0.0.1", port, undefined, 1000)).code).to.equal(2);
        expect((await statusOf("127.0.0.1", port, undefined, undefined)).code).to.equal(0);
      });
      it("does not call a node that is not ready 'lagging'", async () => {
        health(503, { ready: false, reason: "starting", lagSeconds: null });
        const r = await statusOf("127.0.0.1", port, undefined, 5);
        expect(r.body.reason).to.equal("starting");
      });
      it("treats an empty body as not ready", async () => {
        reply(200, "");
        expect((await statusOf("127.0.0.1", port, undefined, undefined)).code).to.equal(2);
      });
    });
  });

  describe("followStart", () => {
    const display = () => {
      const calls: any[][] = [];
      const d: any = {};
      for (const m of ["begin", "done", "fail", "catchUp", "finish"]) d[m] = (...a: any[]) => calls.push([m, ...a]);
      return { calls, d };
    };

    it("shows each step once and finishes when the node is ready", async () => {
      const { calls, d } = display();
      writeState(f("s"), { step: "config", event: "begin" });
      const done = followStart(d, process.pid, f("s"), 5000);
      await new Promise((r) => setTimeout(r, 250));
      writeState(f("s"), { step: "config", event: "done" });
      await new Promise((r) => setTimeout(r, 250));
      writeState(f("s"), { ready: true, step: "ready", event: "done" });
      expect(await done).to.equal(0);
      expect(calls).to.deep.equal([["begin", "config"], ["done", "config"], ["done", "ready"], ["finish"]]);
    });
    it("fails with the node's reason when a step fails", async () => {
      const { calls, d } = display();
      writeState(f("s"), { step: "bootstrap", event: "fail", detail: "no upstream" });
      expect(await followStart(d, process.pid, f("s"), 5000)).to.equal(1);
      expect(calls).to.deep.equal([["fail", "no upstream", "bootstrap"]]);
    });
    it("falls back to the error, then to 'failed'", async () => {
      let r = display();
      writeState(f("s"), { step: "x", event: "fail", error: "boom" });
      await followStart(r.d, process.pid, f("s"), 5000);
      expect(r.calls).to.deep.equal([["fail", "boom", "x"]]);
      r = display();
      writeState(f("s"), { step: "x", event: "fail" });
      await followStart(r.d, process.pid, f("s"), 5000);
      expect(r.calls).to.deep.equal([["fail", "failed", "x"]]);
    });
    it("shows catch-up progress", async () => {
      const { calls, d } = display();
      writeState(f("s"), { step: "catching up", event: "begin", lag: 42, cursor: "umid:1,a" });
      const done = followStart(d, process.pid, f("s"), 5000);
      await new Promise((r) => setTimeout(r, 250));
      writeState(f("s"), { ready: true });
      await done;
      expect(calls[0]).to.deep.equal(["begin", "catching up"]);
      expect(calls).to.deep.include(["catchUp", 42, "umid:1,a"]);
      expect(calls[calls.length - 1]).to.deep.equal(["finish"]);
    });
    it("shows catch-up lag without a cursor as an empty one", async () => {
      const { calls, d } = display();
      writeState(f("s"), { step: "catching up", event: "begin", lag: 7 });
      const done = followStart(d, process.pid, f("s"), 5000);
      await new Promise((r) => setTimeout(r, 150));
      writeState(f("s"), { ready: true });
      await done;
      expect(calls).to.deep.include(["catchUp", 7, ""]);
    });
    it("fails when the node dies before it is ready, with its error if it left one", async () => {
      let r = display();
      expect(await followStart(r.d, DEAD, f("none"), 5000)).to.equal(1);
      expect(r.calls).to.deep.equal([["fail", "the node exited during start-up"]]);
      r = display();
      writeState(f("s"), { error: "port in use" });
      expect(await followStart(r.d, DEAD, f("s"), 5000)).to.equal(1);
      expect(r.calls).to.deep.equal([["fail", "port in use"]]);
    });
    it("gives up after the timeout", async () => {
      const { calls, d } = display();
      const t0 = Date.now();
      expect(await followStart(d, process.pid, f("none"), 250)).to.equal(1);
      expect(Date.now() - t0).to.be.at.least(240);
      expect(calls).to.deep.equal([["fail", "timed out waiting for the node to become ready"]]);
    });
  });
});
