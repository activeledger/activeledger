import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as net from "net";
import * as tls from "tls";
import * as https from "https";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveRequest, ContractScope, StorageAccessError } from "@activeledger/activeutilities";
import { runSandboxed } from "../packages/protocol/src/protocol/sandbox";

// The ways a contract with a raw module (http, net, tls, fetch) might reach the storage,
// beyond the toolkit's ActiveRequest. Ground truth is what the stand-in storage server received.
describe("Storage guard: raw modules, fetch and approvals (Activeprotocol)", () => {
  let storage: http.Server, port = 0;
  const seen: string[] = [];
  before(async () => {
    storage = http.createServer((q, s) => { seen.push(`${q.method} ${q.url}`); s.setHeader("content-type", "application/json"); s.end('{"ok":true}'); });
    await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
    port = (storage.address() as net.AddressInfo).port;
    ContractScope.protectPorts([port]);
    ContractScope.neverDatabases(["activeledger", "activeledgerevents", "activeledgererrors"]);
  });
  after(() => storage.close());
  beforeEach(() => { seen.length = 0; });

  // A contract with the modules allowed: custom databases open
  const inContract = <T>(fn: () => T) => runSandboxed({ mode: "storage", customDatabases: true, onBlocked: () => undefined }, fn);
  const refused = async (fn: () => unknown) => { try { await fn(); } catch (e: any) { return e; } return null; };
  const get = (opts: any, cb?: any) => new Promise<number>((resolve, reject) => inContract(() => http.request(opts, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode || 0)); cb?.(res); }).on("error", reject).end()));
  const base = () => ({ host: "127.0.0.1", port, method: "GET" });

  describe("http.request option objects", () => {
    it("allows a plain read of a custom database, and refuses the same options aimed anywhere else", async () => {
      expect(await get({ ...base(), path: "/activeledger_w/doc" })).to.equal(200);
      for (const path of ["/activeledger/doc", "/activeledger_w/doc:volatile", "/activeledger_w/_backup", "/activeledger_w", "/_all_dbs", "/activeledger_w/a/b"]) {
        expect(await refused(() => get({ ...base(), path })), path).to.be.instanceOf(StorageAccessError);
      }
      for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "PROPFIND"]) {
        expect(await refused(() => get({ ...base(), method, path: "/activeledger_w/doc" })), method).to.be.instanceOf(StorageAccessError);
      }
      expect(seen).to.deep.equal(["GET /activeledger_w/doc"]);
    });

    it("refuses an agent, a custom connection, a lookup or a socket path in the options", async () => {
      const path = "/activeledger_w/doc";
      for (const extra of [{ agent: new http.Agent() }, { createConnection: () => net.connect(port) }, { lookup: () => undefined }, { socketPath: "/tmp/x.sock" }]) {
        expect(await refused(() => get({ ...base(), path, ...extra })), Object.keys(extra)[0]).to.be.instanceOf(StorageAccessError);
      }
      expect(seen).to.deep.equal([]);
    });

    it("refuses options that are not plain data (getters, a class instance)", async () => {
      let n = 0;
      const sly: any = { host: "127.0.0.1", method: "GET", path: "/activeledger_w/doc" };
      Object.defineProperty(sly, "port", { enumerable: true, get: () => (++n === 1 ? 9 : port) });
      expect(await refused(() => get(sly))).to.be.instanceOf(StorageAccessError);
      class Opts { host = "127.0.0.1"; port = port; method = "GET"; path = "/activeledger_w/doc"; }
      expect(await refused(() => get(new Opts()))).to.be.instanceOf(StorageAccessError);
      expect(seen).to.deep.equal([]);
    });

    it("reads the argument forms the way http does: (url), (url, options), (options)", async () => {
      const url = `http://127.0.0.1:${port}`;
      expect(await refused(() => inContract(() => http.get(`${url}/activeledger/x`)))).to.be.instanceOf(StorageAccessError);
      expect(await refused(() => inContract(() => http.request(`${url}/activeledger_w/x`, { method: "PUT" })))).to.be.instanceOf(StorageAccessError);
      expect(await refused(() => inContract(() => http.request(new URL(`${url}/activeledger_w/x:volatile`))))).to.be.instanceOf(StorageAccessError);
      expect(await refused(() => inContract(() => http.request({ host: "localhost", port: String(port), path: "/activeledger/x" })))).to.be.instanceOf(StorageAccessError);
      expect(await refused(() => inContract(() => http.request({ hostname: "127.0.0.1", port: [port] as any, path: "/activeledger/x" })))).to.be.instanceOf(StorageAccessError);
      expect(seen).to.deep.equal([]);
    });
  });

  describe("sockets", () => {
    it("refuses every form of connect to the storage port", async () => {
      const forms: Array<() => unknown> = [
        () => net.connect(port), () => net.connect(port, "127.0.0.1"), () => net.connect({ port }), () => net.connect({ port: String(port) as any, host: "localhost" }),
        () => net.createConnection(port), () => net.createConnection({ host: "127.0.0.1", port }), () => new net.Socket().connect(port),
        () => new net.Socket().connect({ port, host: "127.0.0.1" }), () => (net.Socket.prototype as any).connect.call(new net.Socket(), { port }),
        () => tls.connect({ port, host: "127.0.0.1" }), () => tls.connect(port),
      ];
      for (const [i, form] of forms.entries()) expect(await refused(() => inContract(form)), `form ${i}`).to.be.instanceOf(StorageAccessError);
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).to.deep.equal([]);
    });

    it("refuses connection-shaping options on net and tls (lookup, agent, createConnection, socket)", async () => {
      const other = net.createServer((s) => s.end());
      await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
      const p = (other.address() as net.AddressInfo).port;
      for (const extra of [{ lookup: () => undefined }, { createConnection: () => undefined }, { agent: new http.Agent() }, { socket: new net.Socket() }]) {
        expect(await refused(() => inContract(() => net.connect({ port: p, host: "127.0.0.1", ...extra } as any))), Object.keys(extra)[0]).to.be.instanceOf(StorageAccessError);
        expect(await refused(() => inContract(() => tls.connect({ port: p, host: "127.0.0.1", ...extra } as any))), `tls ${Object.keys(extra)[0]}`).to.be.instanceOf(StorageAccessError);
      }
      // The same options hidden: not enumerable, or behind a symbol
      const hidden: any = { port: p, host: "127.0.0.1" };
      Object.defineProperty(hidden, "lookup", { value: () => undefined, enumerable: false });
      expect(await refused(() => inContract(() => net.connect(hidden))), "non-enumerable lookup").to.be.instanceOf(StorageAccessError);
      expect(await refused(() => inContract(() => net.connect({ port: p, [Symbol("x")]: 1 } as any))), "symbol key").to.be.instanceOf(StorageAccessError);
      other.close();
    });

    it("leaves a socket to anywhere else alone", async () => {
      const other = net.createServer((s) => s.end());
      await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
      const p = (other.address() as net.AddressInfo).port;
      await new Promise<void>((resolve, reject) => { const s = inContract(() => net.connect(p, "127.0.0.1")) as net.Socket; s.on("connect", () => { s.destroy(); resolve(); }); s.on("error", reject); });
      other.close();
    });
  });

  describe("fetch", () => {
    const f = (input: any, init?: any) => inContract(() => (globalThis as any).fetch(input, init));
    it("reads a custom database and nothing the guard refuses", async () => {
      expect(((await f(`http://127.0.0.1:${port}/activeledger_w/doc`)) as Response).status).to.equal(200);
      for (const [input, init] of [
        [`http://127.0.0.1:${port}/activeledger/doc`], [`http://127.0.0.1:${port}/activeledger_w/doc`, { method: "PUT", body: "{}" }],
        [`http://127.0.0.1:${port}/activeledger_w/x%3Avolatile`], [new URL(`http://127.0.0.1:${port}/activeledger/x`)],
        [`http://127.0.0.1:${port}/activeledger_w/_bulk_docs`, { method: "POST", body: new Blob(["{}"]) }],
        [`http://127.0.0.1:${port}/activeledger_w/_bulk_docs`, { method: "POST", body: new URLSearchParams({ a: "volatile" }) }],
      ] as any) {
        expect(await refused(() => f(input, init)), String(input)).to.be.instanceOf(StorageAccessError);
      }
      expect(await refused(() => f(new Request(`http://127.0.0.1:${port}/activeledger_w/doc`)))).to.be.instanceOf(StorageAccessError);
      expect(seen).to.deep.equal(["GET /activeledger_w/doc"]);
    });
  });

  describe("delete and the node's own databases", () => {
    it("never reaches the node's databases or any volatile, with any method, through any module", async () => {
      const url = `http://127.0.0.1:${port}`;
      const paths = ["/activeledger/x", "/activeledger", "/activeledgerevents/x", "/activeledgererrors/x", "/activeledger_w/x:volatile", "/activeledger_w/volatile", "/activeledger_w/x%3Avolatile"];
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
        for (const path of paths) {
          expect(await refused(() => inContract(() => ActiveRequest.send(`${url}${path}`, method, undefined, method === "POST" ? { a: 1 } : undefined))), `${method} ${path}`).to.be.instanceOf(StorageAccessError);
          expect(await refused(() => get({ ...base(), method, path })), `http ${method} ${path}`).to.be.instanceOf(StorageAccessError);
          expect(await refused(() => inContract(() => (globalThis as any).fetch(`${url}${path}`, { method }))), `fetch ${method} ${path}`).to.be.instanceOf(StorageAccessError);
        }
      }
      // And a delete of an ordinary document in a custom database is refused too
      expect(await refused(() => inContract(() => ActiveRequest.send(`${url}/activeledger_w/doc`, "DELETE")))).to.be.instanceOf(StorageAccessError);
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).to.deep.equal([]);
    });
  });

  describe("limits on a contract call", () => {
    let slow: http.Server, slowPort = 0, big: http.Server, bigPort = 0;
    const events: string[] = [];
    before(async () => {
      slow = http.createServer((q, res) => { events.push("request arrived"); q.on("close", () => events.push("client gone")); setTimeout(() => { if (!res.destroyed) res.end('{"late":true}'); }, 1500); });
      big = http.createServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end('{"x":"' + "a".repeat(3 * 1024 * 1024) + '"}'); });
      await Promise.all([slow, big].map((x) => new Promise<void>((r) => x.listen(0, "127.0.0.1", r))));
      slowPort = (slow.address() as net.AddressInfo).port; bigPort = (big.address() as net.AddressInfo).port;
    });
    after(() => { slow.close(); big.close(); });
    beforeEach(() => { events.length = 0; });

    const limited = <T>(fn: () => T, limits = { timeoutSeconds: 0.3, maxResponseBytes: 1024 * 1024 }) =>
      runSandboxed({ mode: "storage", onBlocked: () => undefined, limits, spent: { bytes: 0 }, inflight: new Set(), ended: { value: false } }, fn);

    it("cuts a request off at the timeout, whatever timeout the contract asked for", async () => {
      const started = Date.now();
      const r: any = await limited(() => ActiveRequest.send(`http://127.0.0.1:${slowPort}/x`, "GET", undefined, undefined, false, 300));
      expect(r.data).to.equal(null);
      expect(Date.now() - started).to.be.lessThan(1200);
    });

    it("drops a response that is more than the call may read", async () => {
      const r: any = await limited(() => ActiveRequest.send(`http://127.0.0.1:${bigPort}/x`, "GET"));
      expect(r.data).to.equal(null);
    });

    it("does not read a compressed answer (it could expand past the byte budget)", async () => {
      const zlib = require("zlib");
      const gz = http.createServer((_q, res) => { res.setHeader("content-encoding", "gzip"); res.end(zlib.gzipSync('{"ok":true}')); });
      await new Promise<void>((r) => gz.listen(0, "127.0.0.1", r));
      const r: any = await limited(() => ActiveRequest.send(`http://127.0.0.1:${(gz.address() as net.AddressInfo).port}/x`, "GET"));
      gz.close();
      expect(r.data).to.equal(null);
    });

    it("cancels a request still in flight when the contract's call ends", async () => {
      // The call returns without waiting for what it started
      limited(() => { ActiveRequest.send(`http://127.0.0.1:${slowPort}/y`, "GET", undefined, undefined, false, 4); return "done"; }, { timeoutSeconds: 4, maxResponseBytes: 1024 * 1024 });
      await new Promise((r) => setTimeout(r, 400));
      // Either it never got to the server, or it was dropped the moment it did: it does not run to the end
      expect(events.filter((e) => e === "request arrived").length === events.filter((e) => e === "client gone").length).to.equal(true);
      await new Promise((r) => setTimeout(r, 1300));
      expect(events).to.not.include("completed");
    });

    it("applies to nothing outside a contract: the explorer and the CLI are not contracts", async () => {
      // Any verb, the node's own databases, volatile: not restricted when no contract is running
      for (const [method, path] of [["PUT", "/activeledger/x"], ["DELETE", "/activeledger/x:volatile"], ["POST", "/activeledgerevents/_bulk_docs"], ["DELETE", "/activeledger_w"]]) {
        const r: any = await ActiveRequest.send(`http://127.0.0.1:${port}${path}`, method, undefined, method === "POST" ? { a: 1 } : undefined);
        expect(r.data, `${method} ${path}`).to.deep.equal({ ok: true });
      }
      expect(seen).to.have.length(4);
    });
  });

  describe("this machine's other ports (allowLocalhost)", () => {
    let svc: http.Server, svcPort = 0;
    before(async () => {
      svc = http.createServer((q, r) => { seen.push(`svc ${q.method} ${q.url}`); r.setHeader("content-type", "application/json"); r.end('{"svc":true}'); });
      await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
      svcPort = (svc.address() as net.AddressInfo).port;
    });
    after(() => svc.close());
    const closed = <T>(fn: () => T, allow?: (d: any) => boolean) => runSandboxed({ mode: "storage", denyLocalhost: true, allow, customDatabases: true, onBlocked: () => undefined }, fn);

    it("refuses every spelling of this machine on a port that is not the storage's", async () => {
      for (const host of ["127.0.0.1", "localhost", "LOCALHOST.", "127.1", "2130706433", "0x7f.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", "foo.localhost", undefined]) {
        expect(await refused(() => closed(() => http.request({ host, port: svcPort, path: "/x", method: "GET" }).on("error", () => undefined).end())), String(host)).to.be.instanceOf(StorageAccessError);
        expect(await refused(() => closed(() => net.connect({ host, port: svcPort }).on("error", () => undefined))), `net ${host}`).to.be.instanceOf(StorageAccessError);
      }
      expect(await refused(() => closed(() => ActiveRequest.send(`http://127.0.0.1:${svcPort}/x`, "GET"))), "ActiveRequest").to.be.instanceOf(StorageAccessError);
      expect(await refused(() => closed(() => fetch(`http://localhost:${svcPort}/x`))), "fetch").to.be.instanceOf(StorageAccessError);
      expect(seen).to.deep.equal([]);
    });

    it("leaves other hosts alone, and everything when the namespace has allowLocalhost", async () => {
      expect(ContractScope.isLoopbackHost("example.com")).to.equal(false);
      expect(ContractScope.isLoopbackHost("10.0.0.5")).to.equal(false);
      expect(ContractScope.isLoopbackHost("128.0.0.1")).to.equal(false);
      const r: any = await runSandboxed({ mode: "storage", onBlocked: () => undefined }, () => ActiveRequest.send(`http://127.0.0.1:${svcPort}/x`, "GET"));
      expect(r.data).to.deep.equal({ svc: true });
    });

    it("lets a listed destination through, and its connection, but not the next port", async () => {
      const allow = (d: any) => Number(d.port) === svcPort;
      const r: any = await closed(() => ActiveRequest.send(`http://127.0.0.1:${svcPort}/x`, "GET"), allow);
      expect(r.data).to.deep.equal({ svc: true });
      expect(await refused(() => closed(() => ActiveRequest.send(`http://127.0.0.1:${svcPort + 1}/x`, "GET"), allow))).to.be.instanceOf(StorageAccessError);
    });

    it("keeps the storage rules on the storage port whatever the flag", async () => {
      expect(await refused(() => runSandboxed({ mode: "storage", customDatabases: true, onBlocked: () => undefined }, () => ActiveRequest.send(`http://127.0.0.1:${port}/activeledger/x`, "GET")))).to.be.instanceOf(StorageAccessError);
    });
  });

  describe("paths the storage and a matcher could read differently", () => {
    it("never matches an escaped slash, backslash, percent, path parameter or fragment against a path-limited entry", () => {
      const entries = ["127.0.0.1:5259/wallets"];
      for (const path of ["/wallets/..%2fadmin", "/wallets/%2e%2e%2fadmin", "/wallets/..%5cadmin", "/wallets/%252e%252e/admin", "/wallets/..;/admin", "/wallets#x"]) {
        expect(ContractScope.listed(entries, { host: "127.0.0.1", port: 5259, path }), path).to.equal(false);
      }
      expect(ContractScope.listed(entries, { host: "127.0.0.1", port: 5259, path: "/wallets/doc" })).to.equal(true);
    });
    it("refuses a fragment or backslash in a raw request path to the storage", async () => {
      for (const path of ["/activeledger_x/_all_docs#x", "/activeledger_x/doc#frag", "/activeledger_x\\doc"]) {
        expect(await refused(() => get({ ...base(), path })), path).to.be.instanceOf(StorageAccessError);
      }
    });
  });

  describe("approvals", () => {
    it("is checked again for everything a contract does after a request was approved", async () => {
      const url = `http://127.0.0.1:${port}`;
      // From inside the callback of an approved read: another request is judged on its own
      const outcome: any[] = [];
      await new Promise<void>((resolve) => inContract(() => http.get(`${url}/activeledger_w/a`, (res) => {
        res.resume();
        for (const p of ["/activeledger/x", "/activeledger_w/b:volatile", "/activeledger_w/_prune"]) {
          try { http.get(`${url}${p}`).on("error", () => undefined); outcome.push("sent"); } catch (e) { outcome.push(e instanceof StorageAccessError ? "refused" : "other"); }
        }
        try { net.connect(port, "127.0.0.1").on("error", () => undefined).destroy(); outcome.push("socket sent"); } catch (e) { outcome.push(e instanceof StorageAccessError ? "socket refused" : "other"); }
        res.on("end", resolve);
      })));
      expect(outcome.slice(0, 3)).to.deep.equal(["refused", "refused", "refused"]);
      // The approval's one bare socket was spent on the request's own connection
      expect(outcome[3]).to.equal("socket refused");
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).to.deep.equal(["GET /activeledger_w/a"]);
    });
  });

  describe("checkServerIdentity", () => {
    // A port nothing listens on: getting past the guard shows as a connection error, not a refusal
    const closed = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const p = (s.address() as net.AddressInfo).port; await new Promise((r) => s.close(r)); return p; };
    const tried = (fn: () => any) => new Promise<any>((resolve) => { try { const s = inContract(fn); s.on("error", resolve); s.on("secureConnect", () => { s.destroy(); resolve(null); }); } catch (e) { resolve(e); } });

    it("lets a plain https request through the guard: node's own agent passes the built-in", async () => {
      const p = await closed();
      const e = await new Promise<any>((resolve) => { try { inContract(() => require("https").get({ host: "127.0.0.1", port: p }).on("error", resolve)); } catch (x) { resolve(x); } });
      expect(e).to.not.be.instanceOf(StorageAccessError);
      expect(e.code).to.equal("ECONNREFUSED");
    });

    it("lets tls.connect carry the built-in check, and refuses a custom one", async () => {
      const p = await closed();
      expect(await tried(() => tls.connect({ host: "127.0.0.1", port: p, checkServerIdentity: tls.checkServerIdentity }))).to.have.property("code", "ECONNREFUSED");
      expect(await tried(() => tls.connect({ host: "127.0.0.1", port: p, checkServerIdentity: () => undefined }))).to.be.instanceOf(StorageAccessError);
      // Undefined is not the guard's to refuse (node itself rejects it as the wrong type)
      expect(await tried(() => tls.connect({ host: "127.0.0.1", port: p, checkServerIdentity: undefined }))).to.not.be.instanceOf(StorageAccessError);
    });

    it("still checks the certificate's name over a real TLS connection", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlsguard-"));
      try {
        cp.execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
        const cert = fs.readFileSync(path.join(dir, "c.pem"));
        const web = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert }, (_q, s) => s.end("ok"));
        await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
        const wp = (web.address() as net.AddressInfo).port;
        // The test's own trust for its certificate: a contract may not pass a ca itself
        const agentOptions: any = https.globalAgent.options;
        const hadCa = agentOptions.ca;
        agentOptions.ca = cert;
        try {
          const call = (servername: string) => new Promise<any>((resolve) => {
            try {
              inContract(() => https.get({ host: "127.0.0.1", port: wp, servername }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", resolve));
            } catch (e) { resolve(e); }
          });
          expect(await call("localhost")).to.equal(200);
          const wrong = await call("other.example");
          expect(wrong).to.not.be.instanceOf(StorageAccessError);
          expect(wrong.code).to.equal("ERR_TLS_CERT_ALTNAME_INVALID");
        } finally { web.close(); agentOptions.ca = hadCa; }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it("refuses a check that a contract swapped in as tls.checkServerIdentity before it asked", async () => {
      const p = await closed();
      const real = require("tls");
      const original = real.checkServerIdentity;
      const swapped = () => undefined;
      try {
        real.checkServerIdentity = swapped;
        expect(await tried(() => tls.connect({ host: "127.0.0.1", port: p, checkServerIdentity: swapped }))).to.be.instanceOf(StorageAccessError);
      } finally { real.checkServerIdentity = original; }
    });

    it("cannot be got round from inside the contract: it rewrites tls.checkServerIdentity itself, then uses the rewrite", async () => {
      const p = await closed();
      const real = require("tls");
      const original = real.checkServerIdentity;
      try {
        const e = await new Promise<any>((resolve) => {
          try {
            inContract(() => {
              // All of this runs in the contract's context
              const mine = () => undefined;
              real.checkServerIdentity = mine;
              expect(real.checkServerIdentity).to.equal(mine);
              real.connect({ host: "127.0.0.1", port: p, checkServerIdentity: real.checkServerIdentity }).on("error", resolve);
              return null;
            });
          } catch (x) { resolve(x); }
        });
        expect(e).to.be.instanceOf(StorageAccessError);
      } finally { real.checkServerIdentity = original; }
    });

    it("refuses the built-in when it is not plain data (a getter, a hidden property)", async () => {
      const p = await closed();
      const getter = { host: "127.0.0.1", port: p };
      Object.defineProperty(getter, "checkServerIdentity", { enumerable: true, get: () => tls.checkServerIdentity });
      const hidden = { host: "127.0.0.1", port: p };
      Object.defineProperty(hidden, "checkServerIdentity", { enumerable: false, value: tls.checkServerIdentity });
      expect(await tried(() => tls.connect(getter as any))).to.be.instanceOf(StorageAccessError);
      expect(await tried(() => tls.connect(hidden as any))).to.be.instanceOf(StorageAccessError);
    });

    it("ignores a refused option that is undefined (undici passes socket: undefined), and still refuses it once set", async () => {
      const p = await closed();
      const base = { host: "127.0.0.1", port: p };
      expect(await tried(() => tls.connect({ ...base, socket: undefined } as any))).to.have.property("code", "ECONNREFUSED");
      for (const key of ["lookup", "createConnection", "agent", "socketPath", "fd", "handle", "dispatcher", "setHost", "secureContext"]) {
        expect(await tried(() => tls.connect({ ...base, [key]: undefined } as any)), key + " undefined").to.have.property("code", "ECONNREFUSED");
      }
      expect(await tried(() => tls.connect({ ...base, socket: new net.Socket() } as any))).to.be.instanceOf(StorageAccessError);
      expect(await tried(() => tls.connect({ ...base, lookup: () => undefined } as any))).to.be.instanceOf(StorageAccessError);
      expect(await tried(() => tls.connect({ ...base, socketPath: "/tmp/x.sock" } as any))).to.be.instanceOf(StorageAccessError);
      expect(await tried(() => tls.connect({ ...base, secureContext: {} } as any))).to.be.instanceOf(StorageAccessError);
    });

    it("lets a contract's ActiveRequest to https through the guard, with or without a header", async () => {
      const p = await closed();
      for (const header of [undefined, []] as any[]) {
        const blocked: string[] = [];
        const r: any = await runSandboxed({ mode: "storage", customDatabases: false, onBlocked: (w: string) => blocked.push(w) }, () => ActiveRequest.send(`https://127.0.0.1:${p}/x`, "GET", header));
        expect(blocked, JSON.stringify(header)).to.deep.equal([]);
        expect(r.data).to.equal(null);
      }
    });
  });
});
