import { expect } from "chai";
import "mocha";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ActiveRequest, ContractScope, StorageAccessError, StorageSocket } from "@activeledger/activeutilities";
import { ActiveOptions } from "@activeledger/activeoptions";
import { runSandboxed, runUnsandboxed } from "../packages/protocol/src/protocol/sandbox";
import { VirtualMachine } from "../packages/protocol/src/protocol/vm";
import Contract from "../packages/activeledger/src/contracts/default/contract";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const undici = require("undici");

const NEVER = ["activeledger", "activeledgerevents", "activeledgererrors", "activeledgererror", "activeledgererrors_archive", "activeledgererror_archive"];
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const FORBIDDEN = "/activeledger/zz:volatile";

// Round two of the storage/localhost guard red team. Every assertion says the guard HOLDS; ground
// truth is what the stand-in storage server received. A failing assertion is a finding.
describe("redteam 2: contract storage guard", function () {
  this.timeout(60000);
  let storage: http.Server, other: http.Server, port = 0, otherPort = 0;
  const seen: { method: string; url: string; body: string }[] = [];
  let otherHits = 0;
  let redirectTo = "";
  const sockets = new Set<net.Socket>();

  const firstSeg = (u: string) => decodeURIComponent(u.split("?")[0].split("/").filter(Boolean)[0] ?? "").toLowerCase();
  // Anything a contract must never get to the store, however it got there
  const bad = () => seen.filter((r) => /volatile/i.test(decodeURIComponent(r.url) + r.body) || NEVER.includes(firstSeg(r.url)) || firstSeg(r.url).startsWith("_") || !/^(GET|POST)$/.test(r.method));
  const inContract = <T>(fn: () => T, extra: any = {}) => runSandboxed({ mode: "storage", customDatabases: true, onBlocked: () => undefined, ...extra }, fn);
  const refused = async (fn: () => unknown) => { try { await fn(); } catch (e: any) { return e; } return null; };
  const okUrl = () => `http://127.0.0.1:${port}/activeledger_x/doc`;
  const warmPool = () => new Promise<void>((resolve) => http.get(okUrl(), (res) => { res.resume(); res.on("end", () => setTimeout(resolve, 30)); }).on("error", () => resolve()));

  before(async () => {
    storage = http.createServer((q, s) => {
      let b = ""; q.on("data", (c) => (b += c));
      q.on("end", () => { seen.push({ method: q.method!, url: q.url!, body: b }); s.setHeader("content-type", "application/json"); s.end('{"ok":true}'); });
    });
    other = http.createServer((q, s) => {
      otherHits++;
      if (redirectTo) { s.statusCode = 307; s.setHeader("location", redirectTo); s.end(); } else { s.setHeader("content-type", "application/json"); s.end('{"other":true}'); }
    });
    for (const s of [storage, other]) s.on("connection", (c) => sockets.add(c));
    await new Promise<void>((r) => storage.listen(0, "127.0.0.1", r));
    // The other service listens dual-stack so IPv6 and 0.0.0.0 spellings reach it
    await new Promise<void>((r) => other.listen(0, "::", r));
    port = (storage.address() as net.AddressInfo).port;
    otherPort = (other.address() as net.AddressInfo).port;
    ContractScope.protectPorts([port]);
    ContractScope.neverDatabases(NEVER);
  });
  after(() => {
    sockets.forEach((s) => s.destroy()); storage.close(); other.close();
    // The guard's shared state outlives this file: leave it as found, so a later test's server that gets one of these ports is not taken for the storage
    delete (globalThis as any)[Symbol.for("activeledger.protectedPorts")];
    delete (globalThis as any)[Symbol.for("activeledger.neverDatabases")];
  });
  // Every test starts with no pooled connections anywhere (node http agent, undici pool), so a hit can only come from the test itself
  beforeEach(async () => {
    sockets.forEach((s) => s.destroy()); sockets.clear();
    (http.globalAgent as any).destroy();
    await settle(60);
    seen.length = 0; otherHits = 0; redirectTo = "";
  });

  // ---------------------------------------------------------------------------------------------
  describe("(1) unix socket transport (StorageSocket) from contract scope", () => {
    let dir: string, sockPath: string, server: net.Server;
    const frames: string[] = [];
    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt2-"));
      sockPath = path.join(dir, "ds.sock");
      server = net.createServer((c) => {
        let buf = Buffer.alloc(0);
        c.on("data", (d) => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
            const len = buf.readUInt32BE(0);
            const f = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
            const id = f.readUInt32BE(0), hl = f.readUInt16BE(4);
            frames.push(f.subarray(6, 6 + hl).toString());
            const body = Buffer.from('{"ok":"socket"}');
            const out = Buffer.alloc(4 + 4 + 2 + body.length);
            out.writeUInt32BE(out.length - 4, 0); out.writeUInt32BE(id, 4); out.writeUInt16BE(200, 8); body.copy(out, 10);
            c.write(out);
          }
        });
      });
      await new Promise<void>((r) => server.listen(sockPath, r));
      StorageSocket.register(`http://127.0.0.1:${port}`, sockPath);
      // The node's own first request connects the socket (outside any contract)
      await StorageSocket.for(`http://127.0.0.1:${port}`)!.request("GET", "/activeledger_warm/x", undefined, 1000);
    });
    after(() => { StorageSocket.unregisterAll(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    beforeEach(() => { frames.length = 0; });

    it("the socket is used for an approved request and for nothing a contract could not do over HTTP", async () => {
      const r: any = await inContract(() => ActiveRequest.send(okUrl(), "GET"));
      expect(r.data).to.deep.equal({ ok: "socket" });
      for (const p of [FORBIDDEN, "/activeledger/x", "/_all_dbs", "/activeledger_x/_backup"]) {
        expect(await refused(() => inContract(() => ActiveRequest.send(`http://127.0.0.1:${port}${p}`, "GET"))), p).to.be.instanceOf(StorageAccessError);
      }
      expect(frames).to.deep.equal(["GET /activeledger_x/doc"]);
      expect(seen).to.deep.equal([]);
    });

    it("StorageSocket.request called directly from a contract is refused", async () => {
      const s = StorageSocket.for(`http://127.0.0.1:${port}`)!;
      expect(await refused(() => inContract(() => s.request("GET", FORBIDDEN, undefined, 1000)))).to.be.instanceOf(StorageAccessError);
      expect(frames).to.deep.equal([]);
    });

    it("StorageSocket.request is refused in the callbacks of an approved request (the approval's context outlives the call)", async () => {
      const s = StorageSocket.for(`http://127.0.0.1:${port}`)!;
      let outcome: any = "never ran";
      await inContract(() => new Promise<void>((resolve) => {
        http.get(okUrl(), (res) => {
          res.resume();
          // This callback runs in the context the connection was created in: the approval's
          s.request("GET", FORBIDDEN, undefined, 1000).then((r) => { outcome = r; resolve(); }, (e) => { outcome = e; resolve(); });
        }).on("error", () => resolve());
      }));
      expect(outcome, "outcome").to.be.instanceOf(StorageAccessError);
      expect(frames.filter((f) => /volatile/.test(f))).to.deep.equal([]);
    });

    it("no unix socket can be opened from a contract by any wrapped route, including the node's own socket path", async () => {
      const forms: Array<() => unknown> = [
        () => net.connect(sockPath), () => net.connect({ path: sockPath }), () => new net.Socket().connect({ path: sockPath }),
        () => new net.Socket().connect(sockPath), () => http.request({ socketPath: sockPath, path: "/x" }),
        () => net.createConnection({ path: sockPath, port: 1 } as any), () => net.connect({ path: sockPath, host: "127.0.0.1", port }),
      ];
      for (const [i, f] of forms.entries()) expect(await refused(() => inContract(f)), `form ${i}`).to.be.instanceOf(StorageAccessError);
      await settle(50);
      expect(frames).to.deep.equal([]);
    });

    it("a contract's request that happens to be the one that has to (re)connect the storage socket neither fails nor breaks the node's own use of it", async () => {
      StorageSocket.unregisterAll();
      StorageSocket.register(`http://127.0.0.1:${port}`, sockPath); // not connected yet
      const viaContract: any = await inContract(() => ActiveRequest.send(okUrl(), "GET")).catch((e: any) => e);
      // the node itself, outside any contract, afterwards
      const host: any = await ActiveRequest.send(okUrl(), "GET").catch((e: any) => e);
      expect(host instanceof Error ? undefined : (host && host.data), "node's own request after a contract's connect attempt").to.not.equal(undefined);
      expect(host instanceof Error, "node's own request rejected: " + host).to.equal(false);
      expect(viaContract instanceof Error, "contract's own approved request threw: " + viaContract).to.equal(false);
    });

  });

  // ---------------------------------------------------------------------------------------------
  describe("(2) live connections a contract can reach", () => {





    it("new http.ClientRequest is not a way round http.request (fresh connection)", async () => {
      await refused(() => inContract(() => new Promise<void>((resolve) => {
        const req = new http.ClientRequest({ host: "127.0.0.1", port, path: FORBIDDEN, method: "GET" }, (res) => { res.resume(); res.on("end", () => resolve()); });
        req.on("error", () => resolve());
        req.end();
      })));
      await settle(200);
      expect(bad()).to.deep.equal([]);
    });







    it("same redirect through http.request is not followed (no pooled connection, no follow)", async () => {
      redirectTo = `http://127.0.0.1:${port}${FORBIDDEN}`;
      await refused(() => inContract(() => new Promise<void>((resolve) => { http.get(`http://127.0.0.1:${otherPort}/`, (res) => { res.resume(); res.on("end", () => resolve()); }).on("error", () => resolve()); }), { denyLocalhost: false }));
      await settle(200);
      expect(bad()).to.deep.equal([]);
    });

    it("WebSocket global to the storage port is refused", async () => {
      const WS: any = (globalThis as any).WebSocket;
      if (!WS) return;
      await refused(() => inContract(() => { const w = new WS(`ws://127.0.0.1:${port}${FORBIDDEN}`); w.onerror = () => undefined; }));
      await settle(200);
      expect(seen).to.deep.equal([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("(3) losing the contract's context: code of the contract run by the host", () => {
    let vm: VirtualMachine;
    const saved: any = {};
    const UMID = "umid-rt2";
    before(() => {
      saved.build = ActiveOptions.get<number>("build", 0);
      saved.db = ActiveOptions.get<any>("db", undefined);
      saved.security = ActiveOptions.get<any>("security", undefined);
      ActiveOptions.set("build", 50600);
      ActiveOptions.set("db", { selfhost: { port }, database: "activeledger", event: "activeledgerevents", error: "activeledgererrors" });
      ActiveOptions.set("security", {});
    });
    after(() => { ActiveOptions.set("build", saved.build); ActiveOptions.set("db", saved.db); ActiveOptions.set("security", saved.security); });
    beforeEach(() => {
      vm = new VirtualMachine(`localhost:${port}`, { get: async () => { throw new Error("none"); } } as any, {} as any);
      (vm as any).contractReferences = { [UMID]: { tx: { $namespace: "somens", $contract: "c@1.0.0" }, inputs: {} } };
    });
    // Run a function the way the VM runs contract code (storage mode, custom databases open)
    const sandboxed = <T>(fn: () => T): T => (vm as any).sandboxed(UMID, fn);
    const forbiddenSend = () => ActiveRequest.send(`http://127.0.0.1:${port}${FORBIDDEN}`, "GET");

    it("control: the VM's sandbox refuses the forbidden request from vote()", async () => {
      expect(await refused(() => sandboxed(() => forbiddenSend()))).to.be.instanceOf(StorageAccessError);
      expect(bad()).to.deep.equal([]);
    });

    it("a listener a contract adds to the emitter it is handed does not run its code outside the sandbox (getVolatile -> volatileFetched)", async () => {
      // The contract is given the VM's emitter as a constructor argument (and keeps it as this.eventEmitter)
      const emitter: any = (vm as any).contractEmitter();
      await sandboxed(async () => {
        emitter.once(`volatileFetched-${UMID}S`, () => { forbiddenSend().catch(() => undefined); });
        emitter.emit("getVolatile", UMID, "S");
      });
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });

    it("a thenable returned from vote() does not run its code when the host awaits it", async () => {
      const outer = { then(res: any) { forbiddenSend().catch(() => undefined); res(true); } };
      const contract = (vm as any).scopedContract(UMID, { vote: () => outer });
      await (async () => await contract.vote())();
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });

    it("toJSON / toString / getters of what a contract returns or throws are not run by the host outside the sandbox", async () => {
      const evil = () => { forbiddenSend().catch(() => undefined); };
      const contract = (vm as any).scopedContract(UMID, { run: async () => ({ toJSON() { evil(); return {}; }, toString() { evil(); return "x"; }, get message() { evil(); return "m"; } }) });
      const result = await contract.run();
      JSON.stringify(result); String(result); (result as any).message; // what the host's own logging and serialising do
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });

    it("shutdown() on the contract, called by vm.destroy(), runs inside the sandbox", async () => {
      (vm as any).smartContracts[UMID] = (vm as any).scopedContract(UMID, { shutdown() { forbiddenSend().catch(() => undefined); } });
      vm.destroy(UMID);
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });

    it("getTimeout() on the contract, called by the VM's timeout timer, runs inside the sandbox", async () => {
      (vm as any).smartContracts[UMID] = (vm as any).scopedContract(UMID, { getTimeout() { forbiddenSend().catch(() => undefined); return undefined; } });
      (vm as any).hasBeenExtended(UMID);
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });

    it("the other methods the VM calls on a contract outside sandboxed() (exportContractData, getActivityStreams, getThisInterNodeComms, getClearInterNodeComms, getReturnToRemote, getThrows, exportAdoptDeclarations, getSupernodeDependence, setHostMode)", async () => {
      const evil = () => { forbiddenSend().catch(() => undefined); };
      const names = ["getSupernodeDependence", "exportAdoptDeclarations", "getActivityStreams", "exportContractData", "getThisInterNodeComms", "getClearInterNodeComms", "getReturnToRemote", "getThrows"];
      const c: any = { setHostMode: evil };
      for (const n of names) c[n] = () => { evil(); return n === "getSupernodeDependence" ? [] : n === "getActivityStreams" ? { activities: {}, contractData: {} } : {}; };
      (vm as any).smartContracts[UMID] = (vm as any).scopedContract(UMID, c);
      for (const call of [
        () => vm.getExecutionReport(UMID), () => (vm as any).getNewContractData(UMID), () => (vm as any).getInternodeCommsFromVM(UMID),
        () => (vm as any).clearingInternodeCommsFromVM(UMID), () => (vm as any).getReturnContractData(UMID), () => (vm as any).getThrowsFromVM(UMID), () => (vm as any).getActivityStreamsFromVM(UMID),
      ]) { try { call(); } catch { /* shape only */ } }
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });

    it("timers, intervals, immediates, ticks, microtasks and events created in a call still see the contract's scope after the call ended", async () => {
      let ran = 0;
      await sandboxed(async () => {
        setTimeout(() => { ran++; forbiddenSend().catch(() => undefined); }, 20);
        setImmediate(() => { ran++; forbiddenSend().catch(() => undefined); });
        process.nextTick(() => { ran++; forbiddenSend().catch(() => undefined); });
        queueMicrotask(() => { ran++; forbiddenSend().catch(() => undefined); });
        const iv = setInterval(() => { ran++; forbiddenSend().catch(() => undefined); clearInterval(iv); }, 60);
        const { EventEmitter } = require("events"); const e = new EventEmitter(); setTimeout(() => { ran++; e.emit("x"); }, 40); e.on("x", () => { ran++; forbiddenSend().catch(() => undefined); });
        const { Readable } = require("stream"); Readable.from(["a"]).on("data", () => { ran++; forbiddenSend().catch(() => undefined); });
        fs.readFile(__filename, () => { ran++; forbiddenSend().catch(() => undefined); });
        Promise.resolve().then(() => { ran++; forbiddenSend().catch(() => undefined); });
      });
      await settle(300);
      expect(ran, "callbacks that ran").to.be.greaterThan(5);
      expect(bad()).to.deep.equal([]);
    });

    it("AsyncResource / AsyncLocalStorage.snapshot / bind created inside a call stay in the contract's scope", async () => {
      const { AsyncResource, AsyncLocalStorage } = require("async_hooks");
      await sandboxed(async () => {
        const snap = AsyncLocalStorage.snapshot();
        const res = new AsyncResource("own");
        const bound = AsyncResource.bind(() => forbiddenSend().catch(() => undefined));
        setTimeout(() => { snap(() => forbiddenSend().catch(() => undefined)); res.runInAsyncScope(() => forbiddenSend().catch(() => undefined)); bound(); }, 10);
        // a second, independent store cannot clear the guard's
        new AsyncLocalStorage().run({}, () => forbiddenSend().catch(() => undefined));
        new AsyncLocalStorage().enterWith({});
        await forbiddenSend().catch(() => undefined);
      });
      await settle(300);
      expect(bad()).to.deep.equal([]);
    });
  });

  describe("(3a) the contract shapes that run code outside the sandbox are accepted by the deploy scan", () => {
    const scan = (source: string): string | null => { try { Contract.prototype.securityScan.call({}, source, "somenamespace"); return null; } catch (e: any) { return e.message; } };
    const wrap = (members: string) => `import { Standard } from "@activeledger/activecontracts"; import { ActiveRequest } from "@activeledger/activetoolkits"; export default class C extends Standard { ${members} }`;
    const send = `ActiveRequest.send("https://example.com/", "GET")`;
  });

  // ---------------------------------------------------------------------------------------------
  describe("(3b) the registered symbols are in the contract's reach (scan-dependent: needs globalThis/Symbol, which the deploy scan refuses)", () => {
  });

  // ---------------------------------------------------------------------------------------------
  describe("(4) allow-list plumbing: ns / ns/contract keys and listed()", () => {
    const entries = (...e: string[]) => e;
    it("listed(): a path-limited entry does not widen by traversal, case, encoding or separators", () => {
      const e = entries("localhost:5290/wallets");
      const d = (p: string) => ContractScope.listed(e, { host: "127.0.0.1", port: 5290, path: p });
      expect(d("/wallets"), "exact").to.equal(true);
      expect(d("/wallets/x"), "child").to.equal(true);
      const widened = [
        "/wallets/../admin", "/wallets/%2e%2e/admin", "/wallets/.%2e/admin", "/wallets/%2e./admin", "/wallets/%2E%2E/admin", "/wallets/..%2fadmin", "/wallets%2f..%2fadmin", "/wallets%2Fx",
        "/Wallets", "/WALLETS/x", "/wallets_old", "/wallets-old", "/walletsx", "/wallets;/../admin", "/wallets/..;/admin", "//admin", "/./admin", "/x/../admin", "/wallets\\..\\admin", "/wallets/..%5cadmin",
        "/wallets/%2e%2e%2fadmin", "/wallets/%252e%252e/admin", "\\admin", "/wallets/./../admin", "/%77allets/../admin",
      ];
      const hit = widened.filter((p) => d(p));
      expect(hit, "paths a '/wallets' entry listed that a decoding or backslash-reading target reads as outside /wallets").to.deep.equal([]);
      expect(d("/%77allets/../admin")).to.equal(false);
    });
    it("listed(): host, port and scheme-default confusion do not widen an entry", () => {
      const e = entries("localhost:5290/x", "127.0.0.1:6000");
      const L = (host: string | undefined, port: number, path?: string) => ContractScope.listed(e, { host, port, path });
      expect(L("127.0.0.2", 5290, "/x")).to.equal(false);
      expect(L("0.0.0.0", 5290, "/x")).to.equal(false);
      expect(L("evil.example", 5290, "/x")).to.equal(false);
      expect(L("localhost", 5291, "/x")).to.equal(false);
      expect(L("localhost", 5290, undefined), "bare socket to a path-limited entry").to.equal(false);
      expect(L("localhost", 80, "/x")).to.equal(false);
      expect(L("LOCALHOST", 6000, "/anything")).to.equal(true);
      expect(ContractScope.listed(["user@127.0.0.1:6000"], { host: "127.0.0.1", port: 6000, path: "/" }) , "userinfo in an entry").to.equal(true);
      expect(ContractScope.listed(["127.0.0.1:6000@evil.example:7000"], { host: "127.0.0.1", port: 6000, path: "/" }), "entry userinfo trick").to.equal(false);
    });

    describe("through the VM's sandboxed()", () => {
      const saved: any = {};
      let vm: VirtualMachine;
      before(() => {
        saved.build = ActiveOptions.get<number>("build", 0); saved.db = ActiveOptions.get<any>("db", undefined); saved.security = ActiveOptions.get<any>("security", undefined);
      });
      after(() => { ActiveOptions.set("build", saved.build); ActiveOptions.set("db", saved.db); ActiveOptions.set("security", saved.security); });
      beforeEach(() => {
        ActiveOptions.set("build", 50600);
        ActiveOptions.set("db", { selfhost: { port }, database: "activeledger", event: "activeledgerevents", error: "activeledgererrors" });
        vm = new VirtualMachine(`localhost:${port}`, {} as any, {} as any);
      });
      const as = (ns: string, contract: string, fn: () => unknown) => {
        (vm as any).contractReferences = { u: { tx: { $namespace: ns, $contract: contract }, inputs: {} } };
        return (vm as any).sandboxed("u", fn);
      };
      const get = (p: string) => () => ActiveRequest.send(`http://127.0.0.1:${port}${p}`, "GET");
      const POLICY = (allow: any, extra: any = {}) => ({ contractEgress: { storage: "deny", allow }, ...extra });

      it("an entry for one namespace does not apply to another, nor ns/contract to a sibling contract or a namespace of the same prefix", async () => {
        ActiveOptions.set("security", POLICY({ nsa: [`127.0.0.1:${port}/activeledger_listed`], "nsb/c1": [`127.0.0.1:${port}/activeledger_listed`] }));
        expect(await refused(() => as("nsa", "c@1", get("/activeledger_listed/doc"))), "own namespace").to.equal(null);
        for (const [ns, c] of [["nsb", "c"], ["nsa2", "c"], ["ns", "c"], ["nsb", "c10"], ["nsb", "c"], ["nsb", "C1"], ["NSA", "c"], ["nsb", "c1x"], ["__proto__", "c"], ["constructor", "c"]]) {
          const e = await refused(() => as(ns, c, get("/activeledger_listed/doc")));
          // NSA is a different spelling; the lists are looked up exactly
          expect(e, `${ns}/${c}`).to.be.instanceOf(StorageAccessError);
        }
        expect(await refused(() => as("nsb", "c1@9.9.9", get("/activeledger_listed/doc"))), "ns/contract at any version").to.equal(null);
        expect(await refused(() => as("nsb", "c1@x@y", get("/activeledger_listed/doc"))), "version with an @").to.equal(null);
        expect(await refused(() => as("nsb", "c1/../c2@1", get("/activeledger_listed/doc"))), "contract with a path in it").to.be.instanceOf(StorageAccessError);
        expect(bad()).to.deep.equal([]);
      });

      it("a listed entry for a namespace never widens to the node's own databases or volatile", async () => {
        ActiveOptions.set("security", POLICY({ nsa: [`127.0.0.1:${port}`] }));
        for (const p of ["/activeledger/x", "/activeledgerevents/x", "/activeledger_listed/x:volatile", "/ActiveLedger/x", "/_all_dbs"]) {
          expect(await refused(() => as("nsa", "c", get(p))), p).to.be.instanceOf(StorageAccessError);
        }
        expect(bad()).to.deep.equal([]);
      });

      it("allowLocalhost is looked up per namespace, case-folded, and 'true' only (not a truthy value)", async () => {
        ActiveOptions.set("security", { contractEgress: { storage: "deny" }, namespace: { nsa: { policy: { allowLocalhost: true } } } });
        const other = () => ActiveRequest.send(`http://127.0.0.1:${otherPort}/`, "GET");
        expect(await refused(() => as("nsa", "c", other)), "allowed").to.equal(null);
        for (const ns of ["nsb", "ns", "nsa2", "constructor", "__proto__", "toString"]) expect(await refused(() => as(ns, "c", other)), ns).to.be.instanceOf(StorageAccessError);
        ActiveOptions.set("security", { contractEgress: { storage: "deny" }, namespace: { nsa: { policy: { allowLocalhost: "true" } } } });
        expect(await refused(() => as("nsa", "c", other)), "string 'true'").to.be.instanceOf(StorageAccessError);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("(5) isLoopbackHost: every spelling that really connects to this machine is recognised", () => {
    // Ground truth: connect outside a contract and see if the stand-in on the dual-stack port answers
    const connects = (host: string) => new Promise<boolean>((resolve) => {
      let done = false;
      const fin = (v: boolean) => { if (!done) { done = true; s.destroy(); resolve(v); } };
      let s: net.Socket;
      try { s = net.connect({ host, port: otherPort }); } catch { resolve(false); return; }
      s.setTimeout(500, () => fin(false));
      s.on("connect", () => fin(true));
      s.on("error", () => fin(false));
    });
    const forms = [
      // IPv4 spellings
      "127.0.0.1", "127.1", "127.0.1", "0x7f.1", "0177.0.0.1", "0x7f000001", "2130706433", "017700000001", "127.0.0.1.", "0", "0.0.0.0", "0.0", "0x0", "00", "127.0x1", "0x7f.0.0.0x1", "127.00.00.01", "0177.1", "127.255.255.254", "0.0.0.0.",
      // IPv6 spellings
      "::1", "0::1", "0:0::1", "::0001", "::01", "0000:0000:0000:0000:0000:0000:0000:0001", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0::1", "::0:1", "[::1]", "::", "::0", "0::0", "0:0:0:0:0:0:0:0",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::FFFF:7F00:1", "::ffff:7f00:0001", "0000:0000:0000:0000:0000:ffff:7f00:0001", "::ffff:127.1.2.3", "::ffff:0.0.0.0", "::ffff:0:0", "::ffff:7f00:0", "0:0:0:0:0:ffff:127.0.0.1",
      "::127.0.0.1", "::7f00:1", "::ffff:0177.0.0.1",
      // zone ids
      "::1%lo", "::1%1", "::1%0", "[::1%lo]", "::ffff:127.0.0.1%lo",
      // names
      "localhost", "LOCALHOST", "localhost.", "LocalHost.", "foo.localhost", "a.b.localhost", "ip6-localhost", "ip6-loopback", "localhost.localdomain", "adamw-cb1", "adamw-cb1.localdomain", os.hostname(),
      // unicode and odd
      "127。0。0。1", "127．0．0．1", "１２７.０.０.１", "localhost。", "ｌocalhost", "127.0.0.1\0", " 127.0.0.1", "127.0.0.1 ", "127.0.0.1\t", "localhost\n", "127%2e0.0.1", "%31%32%37.0.0.1",
    ];
    it("every spelling that connects to the stand-in is seen as this machine", async function () {
      this.timeout(120000);
      const missed: string[] = [];
      const real: string[] = [];
      for (const f of forms) {
        const c = await connects(f);
        if (!c) continue;
        real.push(f);
        if (!ContractScope.isLoopbackHost(f)) missed.push(f);
      }
      console.log("spellings that really connected:", JSON.stringify(real));
      console.log("  of which isLoopbackHost missed:", JSON.stringify(missed));
      expect(missed).to.deep.equal([]);
    });

    it("the same, end to end: a contract's raw request, socket and tls to the stand-in with denyLocalhost is refused for every spelling that connects", async function () {
      this.timeout(120000);
      const got: string[] = [];
      for (const f of forms) {
        if (!(await connects(f))) continue;
        const before = otherHits;
        for (const attempt of [
          () => new Promise<void>((resolve) => { const r = http.get({ host: f, port: otherPort, path: "/" }, (res) => { res.resume(); res.on("end", () => resolve()); }); r.on("error", () => resolve()); }),
          () => new Promise<void>((resolve) => { const s = net.connect({ host: f, port: otherPort }); s.on("connect", () => { s.write("GET / HTTP/1.0\r\n\r\n"); setTimeout(() => { s.destroy(); resolve(); }, 80); }); s.on("error", () => resolve()); }),
          () => new Promise<void>((resolve) => { const s = net.connect(otherPort, f); s.on("connect", () => { s.write("GET / HTTP/1.0\r\n\r\n"); setTimeout(() => { s.destroy(); resolve(); }, 80); }); s.on("error", () => resolve()); }),
        ]) {
          await refused(() => inContract(attempt, { denyLocalhost: true }));
        }
        await settle(40);
        if (otherHits > before) got.push(f);
      }
      console.log("spellings that reached the local service from a denyLocalhost contract:", JSON.stringify(got));
      expect(got).to.deep.equal([]);
    });

    it("URL forms: userinfo, redirects from an allowed host, and a host header that names another target do not move the destination", async () => {
      const t = async (u: string, opts?: any) => { await refused(() => inContract(() => fetch(u, opts), { denyLocalhost: true })); };
      for (const u of [`http://x@127.0.0.1:${otherPort}/`, `http://127.0.0.1:${otherPort}@example.invalid/`, `http://example.invalid\\@127.0.0.1:${otherPort}/`, `http:\\\\127.0.0.1:${otherPort}/`, `http:///127.0.0.1:${otherPort}/`, `http://127.0.0.1.:${otherPort}/`, `http://[::ffff:7f00:1]:${otherPort}/`, `http://[0:0:0:0:0:ffff:7f00:1]:${otherPort}/`, `http://0177.0.0.1:${otherPort}/`, `http://2130706433:${otherPort}/`, `http://127.1:${otherPort}/`, `http://0:${otherPort}/`, `http://foo.localhost:${otherPort}/`, `http://LOCALHOST.:${otherPort}/`, `http://127%2e0.0.1:${otherPort}/`, `http://ｌocalhost:${otherPort}/`, `http://127。0。0。1:${otherPort}/`, `http://\t127.0.0.1:${otherPort}/`, `http://127.0.0.1\n:${otherPort}/`]) await t(u);
      for (const u of [`http://x@127.0.0.1:${otherPort}/`, `http://127.1:${otherPort}/`, `http://0:${otherPort}/`, `http://[::ffff:7f00:1]:${otherPort}/`, `http://foo.localhost:${otherPort}/`, `http://127%2e0.0.1:${otherPort}/`, `http://127。0。0。1:${otherPort}/`]) {
        await refused(() => inContract(() => ActiveRequest.send(u, "GET"), { denyLocalhost: true }));
        await refused(() => inContract(() => new Promise<void>((resolve) => { http.get(u, (res) => { res.resume(); res.on("end", () => resolve()); }).on("error", () => resolve()); }), { denyLocalhost: true }));
      }
      await settle(200);
      expect(otherHits, "requests that reached the local service").to.equal(0);
    });

    it("Host header mismatch: connecting to one loopback service with the Host of another does not change what is approved", async () => {
      await refused(() => inContract(() => new Promise<void>((resolve) => { http.get({ host: "127.0.0.1", port: otherPort, path: "/", headers: { Host: `127.0.0.1:${port}` } }, (res) => { res.resume(); res.on("end", () => resolve()); }).on("error", () => resolve()); }), { denyLocalhost: false }));
      await refused(() => inContract(() => new Promise<void>((resolve) => { http.get({ host: "127.0.0.1", port, path: FORBIDDEN, headers: { Host: `127.0.0.1:${otherPort}` } }, (res) => { res.resume(); res.on("end", () => resolve()); }).on("error", () => resolve()); }), { denyLocalhost: false }));
      expect(bad()).to.deep.equal([]);
    });

    it("net/tls host or port given as an object whose conversions change on the second read are not accepted", async () => {
      let n = 0;
      const flip = (a: any, b: any) => ({ toString() { return ++n === 1 ? a : b; }, valueOf() { return ++n === 1 ? a : b; }, [Symbol.toPrimitive]() { return ++n === 1 ? a : b; } });
      const forms: Array<() => unknown> = [
        () => net.connect({ host: flip("example.invalid", "127.0.0.1") as any, port: otherPort }),
        () => net.connect({ host: "127.0.0.1", port: flip(1, otherPort) as any }),
        () => net.connect({ host: "127.0.0.1", port: flip(1, port) as any }),
        () => net.connect({ host: ["127.0.0.1"] as any, port: otherPort }),
        () => net.connect({ host: new String("127.0.0.1") as any, port: otherPort }),
        () => net.connect({ host: "127.0.0.1", port: new Number(port) as any }),
      ];
      const before = otherHits;
      for (const [i, f] of forms.entries()) { n = 0; await refused(() => inContract(f, { denyLocalhost: true })); void i; }
      await settle(200);
      expect(otherHits - before, "reached the local service").to.equal(0);
      expect(seen, "reached the storage").to.deep.equal([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("(7) fetch / Request / URL / legacy url objects", () => {
    it("fetch with a Request, Headers, dispatcher, signal or a stream body is refused or never reaches the store", async () => {
      const u = `http://127.0.0.1:${port}${FORBIDDEN}`;
      const attempts: Array<() => unknown> = [
        () => fetch(new Request(u)), () => fetch(new Request(u, { method: "DELETE" }), {}), () => fetch(new Request(u), { method: "GET" }),
        () => fetch(u, { headers: new Headers({ a: "b" }) as any }), () => fetch(u, { dispatcher: undici.getGlobalDispatcher() } as any),
        () => fetch(u, { signal: AbortSignal.timeout(100) } as any), () => fetch(u, { method: "POST", body: new Blob(["x:volatile"]) as any }),
        () => fetch(u, { method: "POST", body: new URLSearchParams("a=volatile") as any }), () => fetch(u, { method: "POST", body: Buffer.from("x") as any }),
        () => fetch({ toString: () => u } as any), () => fetch(new String(u) as any), () => fetch(new URL(u)), () => fetch(u),
        () => fetch(`http://127.0.0.1:${port}/activeledger_x/doc`, { method: "PUT" }), () => fetch(`http://127.0.0.1:${port}/activeledger_x/doc`, { method: "DELETE" }),
        () => fetch(`http://127.0.0.1:${port}/activeledger_x/doc`, { method: "get" }), () => fetch(`http://127.0.0.1:${port}/activeledger_x/doc`, { method: "PATCH" }),
        () => fetch(`http://127.0.0.1:${port}/activeledger_x/_bulk_docs`, { method: "post", body: '{"docs":[{"_id":"a:volatile"}]}' }),
        () => fetch(`http://127.0.0.1:${port}/activeledger_x/_bulk_docs`, { method: "POST", body: "{\"docs\":[{\"_id\":\"a:vo\\u006clatile\"}]}" }),
      ];
      for (const a of attempts) await refused(() => inContract(a));
      await settle(200);
      expect(bad()).to.deep.equal([]);
    });

    it("http.request with url.parse / urlToHttpOptions / WHATWG URL plus options, and url + options mixes, cannot change the target after the check", async () => {
      const url = require("url");
      const u = `http://127.0.0.1:${port}${FORBIDDEN}`;
      const attempts: Array<() => unknown> = [
        () => http.get(url.parse(u) as any), () => http.get(url.urlToHttpOptions(new URL(u)) as any), () => http.get(new URL(u)), () => http.get(u),
        () => http.get(new URL(`http://127.0.0.1:${port}/activeledger_x/doc`), { path: FORBIDDEN }), () => http.get(`http://127.0.0.1:${port}/activeledger_x/doc`, { path: FORBIDDEN }),
        () => http.get(`http://example.invalid/`, { host: "127.0.0.1", port, path: FORBIDDEN }), () => http.get(`http://example.invalid/`, { hostname: "127.0.0.1", port, path: FORBIDDEN }),
        () => http.get(u, { host: "example.invalid" }), () => http.get({ host: "example.invalid", hostname: "127.0.0.1", port, path: FORBIDDEN }), () => http.get({ host: "127.0.0.1", hostname: "example.invalid", port, path: FORBIDDEN }),
        () => http.get({ host: "127.0.0.1", port, path: FORBIDDEN, setHost: false, headers: { host: "example.invalid" } }), () => http.get({ host: "127.0.0.1", port, path: "http://example.invalid" + FORBIDDEN }),
        () => http.get({ host: "127.0.0.1", port, path: "//example.invalid" + FORBIDDEN }), () => http.get({ host: "127.0.0.1", port, path: "*" }), () => http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "127.0.0.1:" + port }),
        () => http.get({ host: "127.0.0.1", port, path: "/activeledger_x/doc#/../../activeledger/zz:volatile" }), () => http.get({ host: "127.0.0.1", port, path: "/activeledger_x/doc?\u00e9=1" }),
        () => http.get({ host: "127.0.0.1", port, path: "/activeledger_x/doc#" + FORBIDDEN }),
        () => http.get({ host: "127.0.0.1", port, path: "/activeledger_x#/_backup" }), () => http.request({ host: "127.0.0.1", port, method: "POST", path: "/activeledger_x#/_backup" }).end("{}"),
      ];
      for (const a of attempts) await refused(() => inContract(() => { const r: any = a(); r?.on?.("error", () => undefined); r?.on?.("response", (res: any) => res.resume()); return r; }));
      await settle(250);
      expect(bad()).to.deep.equal([]);
    });

    it("wire-level: what the store receives for the paths the guard allowed is the path the guard judged (no # / \\ / latin-1 divergence)", async () => {
      const paths = ["/activeledger_x/doc#frag", "/activeledger_x/doc\\x", "/activeledger_x/d\u00e9", "/activeledger_x/a%23b", "/activeledger_x/doc?a=b#c", "/activeledger_x/\u00ad_all_docs", "/activeledger_x/_all_docs#x", "/activeledger_x/_all_docs;x"];
      for (const p of paths) await refused(() => inContract(() => new Promise<void>((resolve) => { http.get({ host: "127.0.0.1", port, path: p }, (res) => { res.resume(); res.on("end", () => resolve()); }).on("error", () => resolve()); })));
      await settle(200);
      const received = seen.map((r) => r.url);
      console.log("allowed paths as the store saw them:", JSON.stringify(received));
      // The store splits on "/" and "?" only (it has no idea of "#"): the guard judged the path with the fragment cut off.
      for (const r of received) expect(r, "the store saw a path the guard judged differently").to.not.include("#");
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("(6) deploy-time source scan: literal storage / loopback mentions the rules should catch", () => {
    let before: any, beforeSecurity: any;
    const scan = (source: string, namespace = "somenamespace"): string | null => {
      try { Contract.prototype.securityScan.call({}, source, namespace); return null; } catch (e: any) { return e.message; }
    };
    const wrap = (body: string) => `export default class Foo { vote() { ${body} } }`;
    beforeEach(() => { before = ActiveOptions.get<number>("build", 0); beforeSecurity = ActiveOptions.get<any>("security", undefined); ActiveOptions.set("build", 50600); ActiveOptions.set("security", {}); });
    afterEach(() => { ActiveOptions.set("build", before); ActiveOptions.set("security", beforeSecurity); });

    it("volatile: literal spellings (one literal, or literals the compiler folds) are caught", () => {
      const missed: string[] = [];
      const cases = [
        `return "/activeledger_w/a:vo\\"latile";`, // the store drops quotes from startkey/endkey
        `return "?startkey=%22a:vo%22latile%22";`, `return "a:" + "volatile";`, "return `a:${\"volatile\"}`;", `return ["a:", "volatile"].join("");`, `return "a:vol" + "atile";`,
        `return "/activeledger_w/a:\\u200bvolatile";`, `return "/activeledger_w/a:\\u00advolatile";`, `return "http://h/activeledger_w/a%3A%76olatile";`,
        `return "a" + ":volatile";`, `return "a:v" + "olatile";`, `return "/activeledger_w/a:VOLATILE";`, `return "/activeledger_w/a%3AVolatile";`,
        `return "a:v\\u200bolatile";`, `return "a: volatile";`, `return "a:\\tvolatile";`, `return "a:\\nvolatile";`, `return "x" + "/" + "volatile";`,
        `return "volatile".padStart(10, "a:");`, `return "elitalov".split("").reverse().join("");`, `return "a:" + String.fromCharCode(118) + "olatile";`,
        `const k = "a"; return \`\${k}:volatile\`;`, `const s = "volatile"; return "a:" + s;`, `return "a:" + \`volatile\`;`, `return "%3Avolatile";`, `return ":%76olatile";`, `return "\\u003avolatile";`,
        `return "/activeledger_w/a:\\uff56olatile";`, `return "a:\\u{76}olatile";`, `return "a:\\x76olatile";`,
      ];
      for (const c of cases) if (!(scan(wrap(c)) || "").includes("volatile")) missed.push(c);
      console.log("scan misses (volatile):\n  " + missed.join("\n  "));
      // Literal-only rule: a single literal, or a '+' of literals, spelled the way the store reads it
      const literalOnly = missed.filter((c) => /^return ("|`)/.test(c) && !/(join|padStart|fromCharCode|reverse|const )/.test(c) && !/\\u200b|\\u00ad|\\uff56/.test(c));
      expect(literalOnly, "literal-only spellings the volatile rule missed").to.deep.equal([]);
    });

    it("loopback: every literal URL/host:port that URL-parses to this machine is caught", () => {
      const hosts = [
        "localhost", "LOCALHOST", "localhost.", "foo.localhost", "127.0.0.1", "127.0.0.1.", "127.1", "127.0.1", "0x7f.1", "0177.0.0.1", "0x7f000001", "2130706433", "017700000001", "0", "0.0.0.0", "0x0", "00",
        "[::1]", "[0:0:0:0:0:0:0:1]", "[0::1]", "[::0001]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:ffff:7f00:1]", "[::FFFF:7F00:1]", "ｌocalhost", "127。0。0。1", "１２７.０.０.１", "127%2e0.0.1", "%6cocalhost",
      ];
      const shapes = [(h: string) => `http://${h}:5259/x`, (h: string) => `${h}:5259`, (h: string) => `//${h}:5259/x`, (h: string) => `http:\\\\${h}:5259/x`, (h: string) => `http:///${h}:5259/x`, (h: string) => `http://u:p@${h}:5259/x`, (h: string) => `HTTP://${h}:5259/x`, (h: string) => `http://${h}/x`,
        (h: string) => `http://\\t${h}:5259/x`, (h: string) => `http://${h}\\n:5259/x`, (h: string) => `ht\\ttp://${h}:5259/x`, (h: string) => ` http://${h}:5259/x`, (h: string) => `\\u0000http://${h}:5259/x`, (h: string) => `http://${h}:05259/x`, (h: string) => `http://${h}:5259?x`, (h: string) => `http://${h}:5259#x`];
      const missed: string[] = [];
      for (const h of hosts) for (const s of shapes) {
        const lit = s(h);
        // What a runtime URL parse sees (strip the escapes the shape uses for tab/newline/NUL)
        const cooked = lit.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\u0000/g, "\u0000");
        let parsed: string | undefined;
        try { parsed = new URL(cooked.trim()).hostname; } catch { parsed = undefined; }
        if (!parsed || !ContractScope.isLoopbackHost(parsed)) continue; // not something the runtime sees as this machine
        if (!(scan(wrap(`return "${lit}";`)) || "").includes("allowLocalhost")) missed.push(lit.replace(/\t/g, "\\t").replace(/\n/g, "\\n"));
      }
      const byHost: any = {}, byShape: any = {};
      for (const m of missed) {
        const host = hosts.find((h) => m.includes(h)) || "?";
        byHost[host] = (byHost[host] || 0) + 1;
      }
      for (const [i, sh] of shapes.entries()) byShape[sh("H")] = missed.filter((m) => m === sh("localhost").replace(/\t/g, "\\t").replace(/\n/g, "\\n") || m === sh("127.0.0.1").replace(/\t/g, "\\t").replace(/\n/g, "\\n") || m === sh("[::1]")).length + 0 * i;
      console.log("scan misses (loopback) by host:", JSON.stringify(byHost));
      console.log("scan misses (loopback) by shape (canonical hosts):", JSON.stringify(byShape));
      expect(missed).to.deep.equal([]);
    });

    it("connection options: the request-option rule holds for the other ways to write the call", () => {
      const missed: string[] = [];
      const cases = [
        `h["request"]({ agent: a });`, `h.request({ ["agent"]: a });`, `new h.ClientRequest({ agent: a });`, `const o = { agent: a }; h.request(o);`, `h.request({ ...{ agent: a } });`, `const r = h.request; r({ agent: a });`,
        `new Agent({ lookup: l });`, `h2.connect("x", { createConnection: c });`, `got("x", { agent: a });`, `axios.get("x", { httpAgent: a });`, `new u.Client("x", { connect: c });`, `h.request({ socketPath: "/x" });`,
        `h.request("x", { lookup: l });`, `h.request("x", { "lookup": l });`, `h.request(\`x\`, { lookup: l });`, `h.request({ agent: a });`, `h.get({ agent: a });`, `this.h.request({ socketPath: "/x" });`, `h.request(...[{ agent: a }]);`, `h.request(Object.assign({}, { agent: a }));`,
        `h.request({ host: "h", createConnection: c });`, `new h.Agent({ lookup: l });`, `h.request({ port: 1 }, { agent: a });`, `h.request({ agent: a, host: "x" } as any);`, `h.request(<any>{ agent: a });`, `h.request({ host: "x", port: 1, "agent": a });`,
        `net.connect({ lookup: l });`, `new net.Socket().connect({ lookup: l });`, `tls.connect({ socket: s });`, `new net.Socket({ fd: 3 });`, `client.pipeline({ agent: a });`, `client.dispatch({ dispatcher: d });`, `client.open({ createConnection: c });`,
      ];
      for (const c of cases) if (!/request option/.test(scan(wrap(c)) || "")) missed.push(c);
      console.log("scan misses (connection options):\n  " + missed.join("\n  "));
      // Literal-only: an options object literal with one of the keys, as a direct argument of a request call (any way of naming the call)
      // Literal-only: an options object literal with one of the keys as a direct argument of a call (however the call is spelled)
      const literalOnly = missed.filter((c) => !/Object\.assign|const r =|const o =|\.\.\.|net\.|tls\.|connect:/.test(c) && /\{ ?\[?"?(agent|lookup|socketPath|createConnection|dispatcher)/.test(c));
      expect(literalOnly, "literal-only misses").to.deep.equal([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe("(8) scan-dependent escapes: a module that a namespace allowed (std/external) gives a new realm or process", () => {



    it("dgram, http2.connect and tls over a socket option cannot reach the store", async () => {
      const http2 = require("http2");
      await refused(() => inContract(() => { const c = http2.connect(`http://127.0.0.1:${port}`); c.on("error", () => undefined); const r = c.request({ ":path": FORBIDDEN }); r.on("error", () => undefined); r.end(); }));
      await settle(200);
      expect(bad()).to.deep.equal([]);
    });
  });
});
