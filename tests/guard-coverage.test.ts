import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as net from "net";
import * as tls from "tls";
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
});
